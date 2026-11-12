/** Shared SOL payment verification against the receive wallet. */

export const PAY_ADDRESS = "E9CBWnxqNz1GEfR34Qhvqt4nYeJek5ke4JRNSDtE2AzW";
export const PAY_QR_SRC = "img/sol-pay-qr.png?v=18";
export const PAY_WINDOW_SEC = 10 * 60; // last 10 minutes

const RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
];

const USED_KEY = "memeLaunchpad.usedPayments.v1";

function loadUsed() {
  try {
    const raw = localStorage.getItem(USED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function markUsed(sig) {
  const list = loadUsed().filter((s) => s !== sig);
  list.unshift(sig);
  localStorage.setItem(USED_KEY, JSON.stringify(list.slice(0, 200)));
}

export function isPaymentUsed(sig) {
  return loadUsed().includes(sig);
}

export function isLikelySig(sig) {
  if (!sig || sig.length < 64 || sig.length > 128) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(sig);
}

export function solToLamports(sol) {
  return Math.floor(Number(sol) * 1_000_000_000 + 1e-6);
}

export function lamportsToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error("rpc http " + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "rpc error");
      return json.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("rpc unavailable");
}

function accountKeys(tx) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.map((k) => (typeof k === "string" ? k : k.pubkey));
}

function walkInstructions(tx, visit) {
  const msg = tx?.transaction?.message;
  if (!msg) return;
  for (const ix of msg.instructions || []) visit(ix);
  for (const inner of tx?.meta?.innerInstructions || []) {
    for (const ix of inner.instructions || []) visit(ix);
  }
}

/** SOL received by PAY_ADDRESS in a confirmed tx (lamports). */
export function solReceivedLamports(tx, dest = PAY_ADDRESS) {
  if (!tx?.meta || tx.meta.err) return 0;

  let fromIx = 0;
  walkInstructions(tx, (ix) => {
    const p = ix?.parsed;
    if (!p) return;
    if (p.type === "transfer" && p.info?.destination === dest) {
      fromIx += Number(p.info.lamports) || 0;
    }
    if (p.type === "transferChecked" && p.info?.destination === dest && p.info?.tokenAmount) {
      // ignore SPL here â€” we only want native SOL
    }
  });
  if (fromIx > 0) return fromIx;

  const keys = accountKeys(tx);
  const idx = keys.findIndex((k) => k === dest);
  if (idx < 0) return 0;
  const pre = Number(tx.meta.preBalances?.[idx]) || 0;
  const post = Number(tx.meta.postBalances?.[idx]) || 0;
  return Math.max(0, post - pre);
}

export async function fetchTransaction(signature) {
  return rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
}

/**
 * Verify one signature: to PAY_ADDRESS, amount >= needLamports, within window.
 * Returns { ok, signature, lamports, sol, reason }
 */
export async function verifySignaturePayment(signature, needLamports, opts = {}) {
  const windowSec = opts.windowSec ?? PAY_WINDOW_SEC;
  const allowUsed = !!opts.allowUsed;

  if (!isLikelySig(signature)) {
    return { ok: false, reason: "Invalid transaction signature" };
  }
  if (!allowUsed && isPaymentUsed(signature)) {
    return { ok: false, reason: "This payment was already used" };
  }

  const tx = await fetchTransaction(signature);
  if (!tx) return { ok: false, reason: "Transaction not found yet â€” wait a few seconds" };
  if (tx.meta?.err) return { ok: false, reason: "Transaction failed on-chain" };

  const now = Math.floor(Date.now() / 1000);
  const bt = Number(tx.blockTime) || 0;
  if (bt && now - bt > windowSec) {
    return { ok: false, reason: "Payment is older than 10 minutes" };
  }

  const lamports = solReceivedLamports(tx, PAY_ADDRESS);
  if (lamports <= 0) {
    return { ok: false, reason: "No SOL received by the payment wallet in this tx" };
  }
  if (lamports < needLamports) {
    return {
      ok: false,
      reason: `Received ${lamportsToSol(lamports).toFixed(4)} SOL â€” need at least ${lamportsToSol(needLamports).toFixed(4)} SOL`,
      lamports,
      sol: lamportsToSol(lamports),
    };
  }

  return {
    ok: true,
    signature,
    lamports,
    sol: lamportsToSol(lamports),
    blockTime: bt,
  };
}

/**
 * Scan recent incoming SOL to PAY_ADDRESS in the last windowSec.
 * First matching unused payment with amount >= needLamports wins.
 */
export async function findRecentPayment(needLamports, opts = {}) {
  const windowSec = opts.windowSec ?? PAY_WINDOW_SEC;
  const limit = opts.limit ?? 30;
  const now = Math.floor(Date.now() / 1000);

  const sigs = await rpc("getSignaturesForAddress", [
    PAY_ADDRESS,
    { limit, commitment: "confirmed" },
  ]);

  for (const row of sigs || []) {
    if (row.err) continue;
    const sig = row.signature;
    if (!sig || isPaymentUsed(sig)) continue;
    const bt = Number(row.blockTime) || 0;
    if (bt && now - bt > windowSec) continue;

    try {
      const result = await verifySignaturePayment(sig, needLamports, {
        windowSec,
        allowUsed: false,
      });
      if (result.ok) return result;
    } catch {
      /* try next */
    }
  }

  return { ok: false, reason: "No matching payment in the last 10 minutes" };
}

/** Prefer pasted sig; otherwise scan wallet. Marks payment used on success if mark=true. */
export async function confirmPayment(needSol, pastedSig = "", opts = {}) {
  const needLamports = solToLamports(needSol);
  if (!(needLamports > 0)) {
    return { ok: false, reason: "Invalid required amount" };
  }

  const sig = (pastedSig || "").trim();
  let result;
  if (sig) {
    result = await verifySignaturePayment(sig, needLamports, opts);
  } else {
    result = await findRecentPayment(needLamports, opts);
  }

  if (result.ok && opts.mark !== false) {
    markUsed(result.signature);
  }
  return result;
}