import { initApp, toast } from "./app.js";
import { upsertPosition, loadPositions } from "./store.js";
import {
  PAY_ADDRESS,
  PAY_QR_SRC,
  confirmPayment,
  isLikelySig,
  lamportsToSol,
} from "./pay.js?v=20";

initApp();

/* Real on-chain payment verification */
const DEMO_SKIP_PAY = false;

const $ = (id) => document.getElementById(id);
const form = $("forgeForm");
if (!form) throw new Error("forge form missing");

let step = 1;
let logoDataUrl = "";
let dexCache = { at: 0, items: [] };
let prefillBusy = false;

const DEX = {
  profiles: "https://api.dexscreener.com/token-profiles/latest/v1",
  boostsLatest: "https://api.dexscreener.com/token-boosts/latest/v1",
  boostsTop: "https://api.dexscreener.com/token-boosts/top/v1",
  tokens: (addr) => `https://api.dexscreener.com/tokens/v1/solana/${addr}`,
};

function resolveDexIcon(icon) {
  if (!icon) return "";
  if (/^https?:\/\//i.test(icon)) {
    try {
      const u = new URL(icon);
      u.searchParams.set("width", "256");
      u.searchParams.set("height", "256");
      u.searchParams.set("fit", "crop");
      u.searchParams.set("quality", "95");
      u.searchParams.set("format", "auto");
      return u.toString();
    } catch {
      return icon;
    }
  }
  return `https://cdn.dexscreener.com/cms/images/${icon}?width=256&height=256&fit=crop&quality=95&format=auto`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dex ${res.status}`);
  return res.json();
}

async function loadDexCandidates() {
  const now = Date.now();
  if (dexCache.items.length && now - dexCache.at < 60_000) return dexCache.items;

  const [profiles, boostsLatest, boostsTop] = await Promise.all([
    fetchJson(DEX.profiles).catch(() => []),
    fetchJson(DEX.boostsLatest).catch(() => []),
    fetchJson(DEX.boostsTop).catch(() => []),
  ]);

  const map = new Map();
  for (const row of [...asArray(profiles), ...asArray(boostsLatest), ...asArray(boostsTop)]) {
    if (!row || row.chainId !== "solana" || !row.tokenAddress) continue;
    const icon = resolveDexIcon(row.icon);
    if (!icon) continue;
    map.set(row.tokenAddress, {
      address: row.tokenAddress,
      icon,
      links: row.links || [],
    });
  }

  const items = [...map.values()];
  if (!items.length) throw new Error("no solana tokens");
  dexCache = { at: now, items };
  return items;
}

function asArray(data) {
  return Array.isArray(data) ? data : data ? [data] : [];
}

async function resolveTokenMeta(address) {
  const pairs = asArray(await fetchJson(DEX.tokens(address)));
  const best = pairs
    .filter((p) => p?.baseToken?.address === address || p?.baseToken?.address?.toLowerCase?.() === address.toLowerCase())
    .sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0] || pairs[0];

  if (!best?.baseToken) throw new Error("token meta missing");
  const name = String(best.baseToken.name || "").trim();
  const symbol = String(best.baseToken.symbol || "").trim().toUpperCase();
  const image = best.info?.imageUrl ? resolveDexIcon(best.info.imageUrl) : "";
  return { name, symbol, image };
}

function paintLogo(src) {
  logoDataUrl = src;
  const dz = $("dropzone");
  const box = $("dropzoneText");
  if (!dz || !box) return;

  dz.classList.add("has-image");

  // Image must live inside #dropzoneText — CSS makes that span fill the zone
  let img = box.querySelector("img.dz-logo");
  if (!img) {
    box.querySelectorAll("svg, .dz-hint, img").forEach((el) => el.remove());
    img = document.createElement("img");
    img.className = "dz-logo";
    img.alt = "Token logo";
    box.appendChild(img);
  }
  img.removeAttribute("crossorigin");
  img.referrerPolicy = "no-referrer";
  img.src = src;

  // Keep summary preview in sync immediately
  const pvLogo = $("pvLogo");
  if (pvLogo) {
    pvLogo.classList.add("has-image");
    pvLogo.style.backgroundImage = `url("${src.replace(/"/g, '\\"')}")`;
    pvLogo.textContent = "";
  }
}

async function applyLogoUrl(url) {
  if (!url) return;
  // Prefer remote URL first so the dropzone paints even if CORS blocks blob convert
  paintLogo(url);
  try {
    const res = await fetch(url, { mode: "cors", referrerPolicy: "no-referrer" });
    if (!res.ok) return;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    if (dataUrl) paintLogo(dataUrl);
  } catch {
    /* remote src already set */
  }
}

function groupNum(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function ungroup(raw) {
  return String(raw || "").replace(/,/g, "");
}

function goTo(n) {
  n = Math.max(1, Math.min(3, Number(n) || 1));
  if (n > step && n === 2 && !validateBasics()) return;
  if (n > step && n === 3 && !validateBasics()) return;
  step = n;

  document.querySelectorAll(".step-pane").forEach((pane) => {
    pane.classList.toggle("is-active", Number(pane.dataset.pane) === step);
  });

  document.querySelectorAll(".step-item").forEach((item) => {
    const s = Number(item.dataset.step);
    item.classList.toggle("is-active", s === step);
    item.classList.toggle("is-done", s < step);
    const btn = item.querySelector(".step-btn");
    if (!btn) return;
    if (s === step) btn.setAttribute("aria-current", "step");
    else btn.removeAttribute("aria-current");
  });

  if (step === 3) fillReview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateBasics() {
  const name = ($("tokenName")?.value || "").trim();
  const symbol = ($("tokenSymbol")?.value || "").trim();
  const supply = ungroup($("tokenSupply")?.value || "");
  if (!logoDataUrl) {
    toast("Add a logo first");
    return false;
  }
  if (!name) {
    toast("Enter a token name");
    $("tokenName")?.focus();
    return false;
  }
  if (!symbol) {
    toast("Enter a symbol");
    $("tokenSymbol")?.focus();
    return false;
  }
  if (!supply || Number(supply) <= 0) {
    toast("Enter a valid supply");
    $("tokenSupply")?.focus();
    return false;
  }
  return true;
}

function syncPreview() {
  const name = ($("tokenName")?.value || "").trim();
  const symbol = ($("tokenSymbol")?.value || "").trim().toUpperCase();
  const supply = $("tokenSupply")?.value || "-";
  const pvName = $("pvName");
  const pvSymbol = $("pvSymbol");
  const pvSupply = $("pvSupply");
  const pvLogo = $("pvLogo");

  if (pvName) {
    pvName.textContent = name || "Your token";
    pvName.classList.toggle("placeholder", !name);
  }
  if (pvSymbol) pvSymbol.textContent = symbol || "SYMBOL";
  if (pvSupply) pvSupply.textContent = supply || "-";

  if (pvLogo) {
    if (logoDataUrl) {
      pvLogo.classList.add("has-image");
      pvLogo.style.backgroundImage = `url(${logoDataUrl})`;
      pvLogo.textContent = "";
    } else {
      pvLogo.classList.remove("has-image");
      pvLogo.style.backgroundImage = "";
      pvLogo.textContent = (symbol || name || "?").slice(0, 1).toUpperCase();
    }
  }

  const badges = $("pvBadges");
  if (badges) {
    const parts = [];
    if ($("optMarketMaker")?.checked) parts.push('<span class="pv-badge">Volume bot</span>');
    if ($("optSocials")?.checked) parts.push('<span class="pv-badge">Socials</span>');
    const liq = getLiquidity();
    if (liq) parts.push(`<span class="pv-badge">${liq} SOL LP</span>`);
    badges.innerHTML = parts.join("");
  }
}

function getLiquidity() {
  const on = document.querySelector(".preset[data-liq].is-on");
  if (on) return on.dataset.liq;
  const custom = ($("liqCustom")?.value || "").trim();
  return custom || "5";
}

function getMmVolume() {
  const on = document.querySelector(".preset[data-mm-volume].is-on");
  if (on) return on.dataset.mmVolume;
  return ($("mmVolumeCustom")?.value || $("mmVolume")?.value || "5").trim();
}

/* Meter stops match HTML tick left% : 1→0, 2→21.53, 5→50, 10→71.53, 25→100 */
const MM_STOPS = [
  { sol: 1, t: 0, band: "Light" },
  { sol: 2, t: 0.2153, band: "Standard" },
  { sol: 5, t: 0.5, band: "Heavy" },
  { sol: 10, t: 0.7153, band: "Intense" },
  { sol: 25, t: 1, band: "Maximum" },
];

function mmMeterProgress(sol) {
  const v = Math.max(0, Number(sol) || 0);
  if (v <= MM_STOPS[0].sol) return MM_STOPS[0].t;
  if (v >= MM_STOPS[MM_STOPS.length - 1].sol) return 1;
  for (let i = 0; i < MM_STOPS.length - 1; i++) {
    const a = MM_STOPS[i];
    const b = MM_STOPS[i + 1];
    if (v >= a.sol && v <= b.sol) {
      const p = (v - a.sol) / (b.sol - a.sol);
      return a.t + (b.t - a.t) * p;
    }
  }
  return 0;
}

function mmBandFor(sol) {
  const v = Number(sol) || 0;
  let band = MM_STOPS[0].band;
  for (const stop of MM_STOPS) {
    if (v >= stop.sol) band = stop.band;
  }
  if (v > 0 && v < 1) band = "Light";
  return band;
}

function syncMmMeter() {
  const meter = $("mmMeter");
  if (!meter) return;
  const raw = getMmVolume();
  const sol = Math.max(0, parseFloat(String(raw).replace(",", ".")) || 0);
  const t = mmMeterProgress(sol);
  const band = mmBandFor(sol);

  meter.style.setProperty("--mtr", String(t));
  meter.style.setProperty("--lvl", String(t));
  meter.classList.toggle("is-empty", sol <= 0);
  meter.classList.toggle("is-warn", sol > 25);

  const amountEl = meter.querySelector('[data-mm-f="amount"]');
  const bandEl = meter.querySelector('[data-mm-f="band"]');
  if (amountEl) {
    amountEl.textContent = Number.isInteger(sol) ? String(sol) : String(Math.round(sol * 10) / 10);
  }
  if (bandEl) bandEl.textContent = band;

  const ticks = meter.querySelectorAll(".vc-ticks span");
  ticks.forEach((span, i) => {
    const stop = MM_STOPS[i];
    span.classList.toggle("on", !!stop && Math.abs(sol - stop.sol) < 0.001);
  });
}

function fillReview() {
  const token = $("reviewToken");
  const cost = $("reviewCost");
  if (!token || !cost) return;

  const name = ($("tokenName")?.value || "").trim();
  const symbol = ($("tokenSymbol")?.value || "").trim().toUpperCase();
  const decimals = $("tokenDecimals")?.value || "9";
  const supply = $("tokenSupply")?.value || "-";
  const liq = getLiquidity();
  const mm = $("optMarketMaker")?.checked;
  const socials = $("optSocials")?.checked;

  token.innerHTML = `
    <li><span>Name</span><b>${escapeHtml(name)}</b></li>
    <li><span>Symbol</span><b>${escapeHtml(symbol)}</b></li>
    <li><span>Decimals</span><b>${escapeHtml(decimals)}</b></li>
    <li><span>Supply</span><b>${escapeHtml(supply)}</b></li>
    <li><span>Liquidity</span><b>${escapeHtml(liq)} SOL</b></li>
    <li><span>Volume bot</span><b>${mm ? getMmVolume() + " SOL" : "Off"}</b></li>
    <li><span>Socials</span><b>${socials ? "On" : "Off"}</b></li>
  `;

  const base = 0.1;
  const lp = Number(liq) || 0;
  const bot = mm ? Number(getMmVolume()) || 0 : 0;
  const total = base + lp + bot;
  cost.innerHTML = `
    <li><span>Platform fee</span><b>${base.toFixed(2)} SOL</b></li>
    <li><span>Initial liquidity</span><b>${lp.toFixed(2)} SOL</b></li>
    <li><span>Volume bot</span><b>${bot.toFixed(2)} SOL</b></li>
    <li class="is-total"><span>Total</span><b>${total.toFixed(2)} SOL</b></li>
  `;

  if ($("payAmountValue")) $("payAmountValue").textContent = total.toFixed(2);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setLogo(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("Use PNG, JPG or WebP");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    paintLogo(String(reader.result || ""));
    syncPreview();
  };
  reader.readAsDataURL(file);
}

/* steps */
document.querySelectorAll("[data-goto]").forEach((btn) => {
  btn.addEventListener("click", () => goTo(btn.getAttribute("data-goto")));
});

document.querySelectorAll(".step-item").forEach((item) => {
  item.querySelector(".step-btn")?.addEventListener("click", () => {
    const target = Number(item.dataset.step);
    if (target <= step || (target === step + 1 && validateBasics())) goTo(target);
    else if (target > step) validateBasics();
  });
});

/* inputs */
$("tokenName")?.addEventListener("input", syncPreview);
$("tokenSymbol")?.addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase();
  syncPreview();
});
$("tokenSupply")?.addEventListener("input", (e) => {
  const caret = e.target.selectionStart;
  const before = e.target.value.length;
  e.target.value = groupNum(e.target.value);
  const after = e.target.value.length;
  try {
    e.target.setSelectionRange(caret + (after - before), caret + (after - before));
  } catch {}
  syncPreview();
});

$("optMarketMaker")?.addEventListener("change", (e) => {
  e.target.closest(".adv-module")?.classList.toggle("is-lit", e.target.checked);
  syncPreview();
});
$("optSocials")?.addEventListener("change", (e) => {
  e.target.closest(".adv-module")?.classList.toggle("is-lit", e.target.checked);
  syncPreview();
});

/* logo */
const dropzone = $("dropzone");
const logoInput = $("logoInput");
dropzone?.addEventListener("click", () => logoInput?.click());
logoInput?.addEventListener("change", () => {
  if (logoInput.files?.[0]) setLogo(logoInput.files[0]);
});
["dragenter", "dragover"].forEach((ev) => {
  dropzone?.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragging");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropzone?.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragging");
  });
});
dropzone?.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) setLogo(file);
});

/* decimals select */
const decBtn = $("decimalsBtn");
const decMenu = $("decimalsMenu");
decBtn?.addEventListener("click", () => {
  const open = decMenu?.hasAttribute("hidden") === false;
  if (open) {
    decMenu.hidden = true;
    decBtn.setAttribute("aria-expanded", "false");
  } else {
    decMenu.hidden = false;
    decBtn.setAttribute("aria-expanded", "true");
  }
});
decMenu?.querySelectorAll('[role="option"]').forEach((opt) => {
  opt.addEventListener("click", () => {
    const val = opt.dataset.value;
    if ($("tokenDecimals")) $("tokenDecimals").value = val;
    if ($("decimalsValue")) $("decimalsValue").textContent = val;
    decMenu.querySelectorAll('[role="option"]').forEach((o) => {
      o.setAttribute("aria-selected", o === opt ? "true" : "false");
    });
    decMenu.hidden = true;
    decBtn?.setAttribute("aria-expanded", "false");
    syncPreview();
  });
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#decimalsSelect") && decMenu && !decMenu.hidden) {
    decMenu.hidden = true;
    decBtn?.setAttribute("aria-expanded", "false");
  }
});

/* liquidity presets */
document.querySelectorAll(".preset[data-liq]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".preset[data-liq]").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    if ($("liqCustom")) $("liqCustom").value = "";
    syncPreview();
  });
});
$("liqCustom")?.addEventListener("input", () => {
  document.querySelectorAll(".preset[data-liq]").forEach((b) => b.classList.remove("is-on"));
  syncPreview();
});

/* mm volume presets + meter bar */
document.querySelectorAll(".preset[data-mm-volume]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".preset[data-mm-volume]").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    if ($("mmVolume")) $("mmVolume").value = btn.dataset.mmVolume;
    if ($("mmVolumeCustom")) $("mmVolumeCustom").value = "";
    syncMmMeter();
    syncPreview();
  });
});
$("mmVolumeCustom")?.addEventListener("input", () => {
  document.querySelectorAll(".preset[data-mm-volume]").forEach((b) => b.classList.remove("is-on"));
  if ($("mmVolume")) $("mmVolume").value = $("mmVolumeCustom").value;
  syncMmMeter();
  syncPreview();
});
syncMmMeter();

/* Prefill from DexScreener (new profiles + popular boosts) */
$("prefillBtn")?.addEventListener("click", async () => {
  if (prefillBusy) return;
  const btn = $("prefillBtn");
  prefillBusy = true;
  const prevLabel = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = "Loading…";
  }

  try {
    const pool = await loadDexCandidates();
    // try a few picks in case meta/logo fails
    let applied = false;
    const order = [...pool].sort(() => Math.random() - 0.5);
    for (const pick of order.slice(0, 6)) {
      try {
        const meta = await resolveTokenMeta(pick.address);
        const name = (meta.name || "").slice(0, 32);
        const symbol = (meta.symbol || "").slice(0, 10);
        if (!name || !symbol) continue;

        if ($("tokenName")) $("tokenName").value = name;
        if ($("tokenSymbol")) $("tokenSymbol").value = symbol;
        if ($("tokenSupply")) $("tokenSupply").value = "1,000,000,000";

        await applyLogoUrl(meta.image || pick.icon);
        // Social links stay off + empty unless the user turns them on manually
        if ($("optSocials")?.checked) {
          $("optSocials").checked = false;
          $("optSocials").dispatchEvent(new Event("change"));
        }
        if ($("linkTwitter")) $("linkTwitter").value = "";
        if ($("linkTelegram")) $("linkTelegram").value = "";
        if ($("linkWebsite")) $("linkWebsite").value = "";
        syncPreview();
        toast(`Pulled from DexScreener · ${symbol}`);
        applied = true;
        break;
      } catch (err) {
        console.warn("dex pick failed", pick.address, err);
      }
    }
    if (!applied) throw new Error("could not resolve a token");
  } catch (err) {
    console.error(err);
    toast("DexScreener unavailable — try again");
  } finally {
    prefillBusy = false;
    if (btn) {
      btn.disabled = false;
      if (prevLabel != null) btn.innerHTML = prevLabel;
    }
  }
});

/* launch / pay modal */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const payModal = $("payModal");
let launchBusy = false;
let payPollTimer = 0;

function getRequiredSol() {
  const base = 0.1;
  const lp = Number(getLiquidity()) || 0;
  const bot = $("optMarketMaker")?.checked ? Number(getMmVolume()) || 0 : 0;
  return base + lp + bot;
}

function renderPayQr() {
  const box = $("payQr");
  if (!box) return;
  let img = box.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.alt = "Solana payment QR";
    img.width = 196;
    img.height = 196;
    box.appendChild(img);
  }
  img.src = PAY_QR_SRC;
}

function showPayPane(which) {
  if ($("payBody")) $("payBody").hidden = which !== "pay";
  if ($("payLaunch")) $("payLaunch").hidden = which !== "launch";
  if ($("paySuccess")) $("paySuccess").hidden = which !== "success";
}

function setVerifyUi({ error = "", status = "" } = {}) {
  const err = $("verifyError");
  const st = $("verifyStatus");
  if (err) {
    err.hidden = !error;
    err.textContent = error || "";
  }
  if (st) {
    st.hidden = !status;
    st.textContent = status || "";
  }
}

function stopPayPoll() {
  clearInterval(payPollTimer);
  payPollTimer = 0;
}

function startPayPoll() {
  stopPayPoll();
  // In demo skip mode we wait for manual Check + pasted hash — no auto-scan
  if (DEMO_SKIP_PAY) return;
  payPollTimer = setInterval(() => {
    if (launchBusy) return;
    if (!payModal?.classList.contains("open")) return;
    if ($("payBody")?.hidden) return;
    tryConfirmPayment({ silent: true });
  }, 8000);
}


async function openPay() {
  console.log("SOL PAYMENT DEBUG: openPay is running");

  const launchBtn = $("launchBtn");
  if (launchBtn?.disabled) return;
  if (launchBtn) launchBtn.disabled = true;

  stopPayPoll();
  fillReview();

  // TEST MODE: disable payment confirmation until
  // the backend verification is secured.
  if ($("txCheck")) $("txCheck").disabled = true;
  if ($("txInput")) $("txInput").disabled = true;

  if ($("payAddress")) {
    $("payAddress").textContent = "Generating wallet...";
  }

  const qrImage = document.getElementById("wallet-direct-qr");
  if (qrImage) qrImage.removeAttribute("src");

  setVerifyUi({
    status: "Creating your unique Solana deposit wallet..."
  });

  showPayPane("pay");
  payModal?.classList.add("open");

  try {
    // Load the functions from your updated pay.js
    const {
      createPayment,
      renderWalletDirect
    } = await import("./pay.js?v=20");

    // Get the required SOL amount
    const expectedSol = getRequiredSol().toFixed(2);

    // Request the wallet from Supabase
    console.log("SOL PAYMENT DEBUG: Calling Supabase now");

    const payment = await createPayment(expectedSol);

    // Display the customer's unique wallet and QR
    renderWalletDirect(payment, {
      qrImageSelector: "#wallet-direct-qr",
      addressSelector: "#payAddress",
      amountSelector: "#payAmountValue"
    });

    setVerifyUi({
      status: "Test mode: wallet generated. Do not send SOL yet."
    });

    console.log("Payment wallet created:", {
      paymentId: payment.paymentId,
      depositAddress: payment.depositAddress
    });

  } catch (err) {
    console.error("Supabase payment creation failed:", err);

    setVerifyUi({
      error: "Could not generate payment wallet: " +
        (err.message || "Unknown error")
    });

    if ($("payAddress")) {
      $("payAddress").textContent = "Wallet unavailable";
    }

  } finally {
    if (launchBtn) launchBtn.disabled = false;
  }
}


async function simulatePaymentCheck(pasted, need) {
  const steps = [
    "Connecting to Solana RPC…",
    "Looking up transaction…",
    `Verifying transfer ≥ ${need.toFixed(2)} SOL…`,
    "Confirming receiver wallet…",
    "Payment matched — confirming…",
  ];
  for (const msg of steps) {
    setVerifyUi({ status: msg });
    await sleep(550 + Math.floor(Math.random() * 450));
  }
  return {
    ok: true,
    signature: pasted,
    sol: need,
    lamports: Math.floor(need * 1e9),
  };
}

function closePay() {
  if (launchBusy) return;
  stopPayPoll();
  payModal?.classList.remove("open");
  showPayPane("pay");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function deriveMint(sig) {
  let h = 2166136261;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  for (let i = 0; i < 44; i++) {
    h ^= (h << 13) | 0;
    h ^= h >>> 17;
    h ^= (h << 5) | 0;
    out += B58[(h >>> 0) % 58];
  }
  return out;
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

function buildLaunchSteps() {
  const liq = Number(getLiquidity()) || 0;
  const mm = !!$("optMarketMaker")?.checked;
  const socials = !!$("optSocials")?.checked;
  const steps = [
    { id: "pay", label: "Confirm payment on Solana" },
    { id: "mint", label: "Create mint & token accounts" },
    { id: "meta", label: socials ? "Upload metadata & social links" : "Upload on-chain metadata" },
    { id: "auth", label: "Lock mint / freeze / update authorities" },
  ];
  if (liq > 0) steps.push({ id: "pool", label: `Seed Raydium pool · ${liq} SOL` });
  if (mm) steps.push({ id: "bot", label: `Arm volume bot · ${getMmVolume()} SOL` });
  steps.push({ id: "done", label: "Broadcast final confirmation" });
  return steps;
}

function renderLaunchSteps(steps) {
  const list = $("launchSteps");
  if (!list) return;
  list.innerHTML = steps
    .map(
      (s, i) => `
    <li class="launch-step" data-step="${escapeHtml(s.id)}" data-i="${i}">
      <span class="tick" aria-hidden="true"></span>
      <span class="launch-step-label">${escapeHtml(s.label)}</span>
    </li>`
    )
    .join("");
}

function setLaunchStep(index, state) {
  const items = [...document.querySelectorAll("#launchSteps .launch-step")];
  items.forEach((el, i) => {
    el.classList.remove("is-active", "is-done");
    if (i < index) el.classList.add("is-done");
    else if (i === index) el.classList.add(state === "done" ? "is-done" : "is-active");
  });
}

function saveLaunchPosition(sig) {
  const name = ($("tokenName")?.value || "").trim() || "Token";
  const symbol = ($("tokenSymbol")?.value || "").trim().toUpperCase() || "TKN";
  const supply = ($("tokenSupply")?.value || "1000000000").trim();
  const decimals = $("tokenDecimals")?.value || "9";
  // Exact SOL the user chose for the pool — chart/pooled start from this
  const liq = Math.max(0, Number(getLiquidity()) || 0);
  const mm = !!$("optMarketMaker")?.checked;
  const mint = deriveMint(sig || String(Date.now()));
  const supplyNum = Number(String(supply).replace(/,/g, "")) || 1_000_000_000;
  const tokenReserve = Math.floor(supplyNum * 0.8);
  const priceSol = liq / Math.max(tokenReserve, 1);
  const mmVol = mm ? Number(getMmVolume()) || 0 : 0;
  const pos = {
    mint,
    name,
    symbol,
    logo: logoDataUrl || "",
    supply,
    decimals,
    liquiditySol: liq,
    tokenReserve,
    priceSol,
    mmVolume: mmVol,
    paymentSig: sig || "",
    createdAt: Date.now(),
  };
  try {
    // Prefer slim logo if huge — avoid localStorage quota wipe
    if (pos.logo && pos.logo.length > 120000) {
      pos.logo = "";
    }
    upsertPosition(pos);
    const saved = loadPositions().some((p) => p.mint === pos.mint);
    if (!saved) {
      toast("Could not save liquidity position");
      return null;
    }
  } catch (err) {
    console.error("upsertPosition failed", err);
    try {
      upsertPosition({ ...pos, logo: "" });
    } catch (err2) {
      console.error(err2);
      toast("Could not save liquidity position");
      return null;
    }
  }
  return pos;
}

async function runLaunchSimulation(sig) {
  const pos = saveLaunchPosition(sig);
  const name = pos?.name || ($("tokenName")?.value || "").trim();
  const symbol = pos?.symbol || ($("tokenSymbol")?.value || "").trim().toUpperCase();
  const supply = pos?.supply || ($("tokenSupply")?.value || "—").trim();
  const decimals = pos?.decimals || $("tokenDecimals")?.value || "9";
  const liq = Number(pos?.liquiditySol) || Number(getLiquidity()) || 0;
  const mm = !!$("optMarketMaker")?.checked;
  const mint = pos?.mint || deriveMint(sig);
  const steps = buildLaunchSteps();

  if ($("launchTitle")) $("launchTitle").textContent = `Launching ${symbol || "token"}`;
  if ($("launchSub")) $("launchSub").textContent = "Confirming payment on Solana…";
  renderLaunchSteps(steps);
  showPayPane("launch");

  const btn = $("txCheck");
  if (btn) btn.disabled = true;

  try {
    for (let i = 0; i < steps.length; i++) {
      setLaunchStep(i, "active");
      if ($("launchSub")) $("launchSub").textContent = steps[i].label + "…";
      const wait = 700 + Math.floor(Math.random() * 900) + (i === 0 ? 400 : 0);
      await sleep(wait);
      setLaunchStep(i, "done");
    }

    if ($("successLine")) {
      $("successLine").innerHTML = `<b>${escapeHtml(symbol)}</b> is live on Solana mainnet.`;
    }

    const facts = [
      ["Token", `${escapeHtml(name)} (${escapeHtml(symbol)})`],
      ["Mint", shortAddr(mint)],
      ["Supply", escapeHtml(supply)],
      ["Decimals", escapeHtml(decimals)],
      ["Network", "Solana Mainnet"],
      ["Liquidity", liq > 0 ? `${liq.toFixed(2)} SOL seeded` : "Not added"],
      ["Volume bot", mm ? `${escapeHtml(getMmVolume())} SOL armed` : "Off"],
      ["Payment", shortAddr(sig)],
    ];

    if ($("successFacts")) {
      $("successFacts").innerHTML = facts
        .map(([k, v]) => `<li><span>${k}</span><b title="${v}">${v}</b></li>`)
        .join("");
    }

    const explorer = $("successExplorer");
    if (explorer) {
      explorer.href = `https://solscan.io/token/${mint}`;
      explorer.hidden = false;
    }

    // re-save after animation in case anything changed
    if (pos) upsertPosition(pos);

    showPayPane("success");
    toast(`${symbol} launched · saved to Liquidity`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function tryConfirmPayment({ silent = false } = {}) {
  if (launchBusy) return false;
  const need = getRequiredSol();
  const pasted = ($("txInput")?.value || "").trim();

  // Demo mode: only manual Check with a pasted hash (no silent auto-confirm)
  if (DEMO_SKIP_PAY) {
    if (silent) return false;
    if (!pasted) {
      setVerifyUi({ error: "Paste the transaction signature, then press Check" });
      return false;
    }
    if (!isLikelySig(pasted)) {
      setVerifyUi({ error: "Invalid transaction signature" });
      return false;
    }
    const btn = $("txCheck");
    if (btn) btn.disabled = true;
    try {
      setVerifyUi({ status: "Checking Solana for payment…" });
      const result = await simulatePaymentCheck(pasted, need);
      stopPayPoll();
      setVerifyUi({ status: `Payment confirmed: ${need.toFixed(4)} SOL` });
      toast(`Payment confirmed · ${need.toFixed(2)} SOL`);
      launchBusy = true;
      try {
        await runLaunchSimulation(result.signature);
      } finally {
        launchBusy = false;
      }
      return true;
    } catch (err) {
      console.error(err);
      setVerifyUi({ error: "Could not verify payment — try again" });
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (pasted && !isLikelySig(pasted)) {
    if (!silent) setVerifyUi({ error: "Paste a valid Solana transaction signature (or leave empty to auto-scan)" });
    return false;
  }

  if (!silent) {
    setVerifyUi({ status: "Checking Solana for payment…" });
    const btn = $("txCheck");
    if (btn) btn.disabled = true;
  }

  try {
    const result = await confirmPayment(need, pasted);
    if (!result.ok) {
      if (!silent) {
        setVerifyUi({ error: result.reason || "Payment not found" });
      } else {
        setVerifyUi({
          status: `Watching wallet… need ≥ ${need.toFixed(2)} SOL (last 10 min)`,
        });
      }
      return false;
    }

    stopPayPoll();
    setVerifyUi({
      status: `Payment confirmed: ${lamportsToSol(result.lamports).toFixed(4)} SOL`,
    });
    toast(`Payment confirmed · ${result.sol.toFixed(4)} SOL`);

    launchBusy = true;
    try {
      await runLaunchSimulation(result.signature);
    } finally {
      launchBusy = false;
    }
    return true;
  } catch (err) {
    console.error(err);
    if (!silent) setVerifyUi({ error: "Could not reach Solana RPC — try again" });
    return false;
  } finally {
    if (!silent) {
      const btn = $("txCheck");
      if (btn) btn.disabled = false;
    }
  }
}

$("launchBtn")?.addEventListener("click", () => {
  if (!validateBasics()) {
    goTo(1);
    return;
  }
  openPay();
});
$("payDone")?.addEventListener("click", closePay);
$("successClose")?.addEventListener("click", () => {
  stopPayPoll();
  closePay();
});
payModal?.addEventListener("click", (e) => {
  if (e.target === payModal) closePay();
});

document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const kind = btn.getAttribute("data-copy");
    const text =
      kind === "amount" ? $("payAmountValue")?.textContent : $("payAddress")?.textContent;
    try {
      await navigator.clipboard.writeText((text || "").trim());
      toast("Copied");
    } catch {
      toast("Could not copy");
    }
  });
});

$("txCheck")?.addEventListener("click", () => tryConfirmPayment({ silent: false }));

syncPreview();
goTo(1);
