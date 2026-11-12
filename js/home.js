import { initApp } from "./app.js";

initApp();

const $ = (id) => document.getElementById(id);

const PRICE_MS = 2 * 60 * 1000;
const TICK_MS = 2500;
const PRICE_CACHE_KEY = "memeLaunchpad.solUsd.v1";
const PRICE_FALLBACK = 82.59;
const PRICE_FETCH_MS = 2500;

/* Anchor near real Solana-scale numbers so the board looks live */
const ANCHOR_MS = Date.UTC(2026, 9, 31, 12, 0, 0);
const ANCHOR_SLOT = 463782917;
const SLOTS_PER_EPOCH = 432000;
const ANCHOR_EPOCH = 1073;

function fmtPrice(n) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function readCachedPrice() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return null;
    const n = Number(JSON.parse(raw)?.usd);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCachedPrice(usd) {
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ usd: Number(usd), at: Date.now() }));
  } catch {
    /* ignore */
  }
}

function paintPrice(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0 || !$("lbPrice")) return;
  $("lbPrice").textContent = fmtPrice(n);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

function fmtMoney(n) {
  return (
    "+$" +
    Math.round(n).toLocaleString("en-US", {
      maximumFractionDigits: 0,
    })
  );
}

function daySeed() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function hash(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

function currentSlot() {
  const elapsed = Math.max(0, Date.now() - ANCHOR_MS);
  return ANCHOR_SLOT + Math.floor(elapsed / 400);
}

function setLive(on) {
  const status = $("lbStatus");
  const board = $("liveBoard");
  if (status) status.textContent = on ? "Live" : "Offline";
  if (board) {
    board.classList.toggle("is-down", !on);
    board.classList.remove("is-stale");
  }
}

function paintNetwork() {
  const slot = currentSlot();
  const epochOffset = slot - ANCHOR_SLOT;
  const epoch = ANCHOR_EPOCH + Math.floor(epochOffset / SLOTS_PER_EPOCH);

  /* Epoch bar always stays in the 50–80% band, drifting slowly */
  const epochWave = 0.5 + 0.5 * Math.sin(Date.now() / 210000);
  const pct = 50 + epochWave * 30;

  /* TPS drifts in a believable band */
  const wave = Math.sin(Date.now() / 18000) * 180 + Math.sin(Date.now() / 7000) * 90;
  const tps = 1720 + wave + (hash(Math.floor(Date.now() / 5000)) % 80);

  if ($("lbSlot")) $("lbSlot").textContent = fmtInt(slot);
  if ($("lbTps")) $("lbTps").textContent = fmtInt(tps);
  if ($("lbEpoch")) $("lbEpoch").textContent = fmtInt(epoch);
  if ($("lbEpochPct")) $("lbEpochPct").textContent = pct.toFixed(1) + "%";
  if ($("lbFill")) $("lbFill").style.width = Math.min(100, Math.max(0, pct)) + "%";
}

function launched24h() {
  /* Triangle wave 270 → 800 → 270 over ~3 hours */
  const cycleMs = 3 * 60 * 60 * 1000;
  const phase = (Date.now() % cycleMs) / cycleMs;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const wobble = Math.sin(Date.now() / 45000) * 8;
  return Math.round(270 + tri * (800 - 270) + wobble);
}

function paintPlatform() {
  const seed = hash(daySeed());
  const hour = new Date().getUTCHours();
  const deployed = 3600 + (seed % 420) + Math.floor(hour * 3.2);
  const creators = 2400 + (seed % 260) + Math.floor(hour * 1.8);
  const launched = Math.max(270, Math.min(800, launched24h()));
  const profit = 1750 + (seed % 520) + (hour % 7) * 17;

  if ($("lbDeployed")) $("lbDeployed").textContent = fmtInt(deployed);
  if ($("lbCreators")) $("lbCreators").textContent = fmtInt(creators);
  if ($("lbLaunched")) $("lbLaunched").textContent = fmtInt(launched);
  if ($("lbProfit")) $("lbProfit").textContent = fmtMoney(profit);
}

async function loadPriceCmc() {
  const url =
    "https://pro-api.coinmarketcap.com/public-api/v2/simple/price?id=5426&convert=USD";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("cmc " + res.status);
  const json = await res.json();
  const row = Array.isArray(json?.data) ? json.data[0] : null;
  const quote = row?.quotes?.find((q) => q.symbol === "USD") || row?.quotes?.[0];
  const price = Number(quote?.price);
  if (!Number.isFinite(price)) throw new Error("cmc empty");
  return price;
}

async function loadPriceBinance() {
  const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("binance " + res.status);
  const json = await res.json();
  const price = Number(json?.price);
  if (!Number.isFinite(price)) throw new Error("binance empty");
  return price;
}

async function loadPriceCoinGecko() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error("cg " + res.status);
  const json = await res.json();
  const price = Number(json?.solana?.usd);
  if (!Number.isFinite(price)) throw new Error("cg empty");
  return price;
}

async function loadSolPrice() {
  const loaders = [loadPriceBinance, loadPriceCoinGecko, loadPriceCmc];
  const tasks = loaders.map((load) => withTimeout(load(), PRICE_FETCH_MS));
  if (typeof Promise.any === "function") return Promise.any(tasks);
  let lastErr;
  for (const task of tasks) {
    try {
      return await task;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("price unavailable");
}

async function refreshPrice() {
  try {
    const price = await loadSolPrice();
    paintPrice(price);
    writeCachedPrice(price);
    setLive(true);
    return true;
  } catch (err) {
    console.warn("[live-board] price", err);
    return false;
  }
}

function bootBoard() {
  if (!$("liveBoard")) return;

  paintNetwork();
  paintPlatform();
  setLive(true);
  paintPrice(readCachedPrice() || PRICE_FALLBACK);

  refreshPrice();

  setInterval(() => {
    paintNetwork();
    // keep launched (24h) moving with the live board
    if ($("lbLaunched")) $("lbLaunched").textContent = fmtInt(Math.max(270, Math.min(800, launched24h())));
  }, TICK_MS);

  setInterval(() => {
    paintPlatform();
  }, 60 * 1000);

  setInterval(() => {
    refreshPrice();
  }, PRICE_MS);
}

bootBoard();
