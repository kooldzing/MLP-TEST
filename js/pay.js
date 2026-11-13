
/**
 * SOL PAYMENT SYSTEM
 * Dynamic deposit wallets + Wallet Direct QR
 *
 * IMPORTANT:
 * Browser verification is for UI feedback only.
 * Purchases must be authorized by server-side verification.
 */

const SUPABASE_URL = "https://vabhjnmcprwyowfdfppz.supabase.co";
const SUPABASE_PUBLIC_KEY = "sb_publishable_c7s9x0PvIwWXmDp_6mzZ_A_IzawQceS";

export let PAY_ADDRESS = "";
export let PAY_QR_SRC = "";
export const PAY_WINDOW_SEC = 10 * 60;

const RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
];

const USED_KEY = "memeLaunchpad.usedPayments.v2";

let activePayment = null;

function validAddress(address) {
  return typeof address === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export function solToLamports(sol) {
  const value = String(sol).trim();

  if (!/^\d+(\.\d{1,9})?$/.test(value)) return NaN;

  const [whole, fractional = ""] = value.split(".");
  const lamports =
    BigInt(whole) * 1000000000n +
    BigInt(fractional.padEnd(9, "0"));

  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    return NaN;
  }

  return Number(lamports);
}

export function lamportsToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

function formatLamports(lamports) {
  const value = BigInt(lamports);
  const whole = value / 1000000000n;
  const fraction = (value % 1000000000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * Create a payment using your deployed Supabase function.
 *
 * accessToken: authenticated user's JWT, if your site uses
 * Supabase Auth.
 */
export async function createPayment(
  expectedSol,
  orderId = null,
  accessToken = null
) {
  const expectedLamports = solToLamports(expectedSol);

  if (!Number.isSafeInteger(expectedLamports) ||
      expectedLamports <= 0) {
    throw new Error("Invalid SOL payment amount");
  }

  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_PUBLIC_KEY,
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (SUPABASE_PUBLIC_KEY.startsWith("eyJ")) {
    // Legacy Supabase anon JWT compatibility.
    // An anon JWT is NOT authenticated user identity.
    headers.Authorization = `Bearer ${SUPABASE_PUBLIC_KEY}`;
  }

  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/create-payment`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedSol,
        orderId,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(
      data.error || `Payment creation failed (${response.status})`
    );
  }

  if (!data.paymentId || !validAddress(data.depositAddress)) {
    throw new Error("Invalid payment response from Supabase");
  }

  let returnedLamports;

  try {
    returnedLamports = BigInt(data.expectedLamports);
  } catch {
    throw new Error("Invalid expectedLamports from Supabase");
  }

  if (returnedLamports <= 0n) {
    throw new Error("Invalid payment amount from Supabase");
  }

  activePayment = {
    paymentId: data.paymentId,
    depositAddress: data.depositAddress,
    index: data.index,
    expectedLamports: returnedLamports.toString(),
    orderId,
  };

  PAY_ADDRESS = activePayment.depositAddress;
  PAY_QR_SRC = "";

  return { ...activePayment };
}

export function getActivePayment() {
  return activePayment ? { ...activePayment } : null;
}

/**
 * Solana Pay link for wallets supporting transfer URLs.
 * Wallet Direct QR intentionally uses the plain address
 * instead, for broader scanner compatibility.
 */
export function getSolanaPayUrl(payment = activePayment) {
  if (!payment || !validAddress(payment.depositAddress)) {
    throw new Error("No active payment");
  }

  const params = new URLSearchParams({
    amount: formatLamports(payment.expectedLamports),
    label: "SOL Payment",
  });

  return `solana:${payment.depositAddress}?${params}`;
}

/**
 * Generate a QR code entirely in the browser.
 * Requires QRCode.js loaded in your HTML.
 */
function qrToDataUrl(value) {
  if (typeof window.QRCode !== "function") {
    throw new Error("QRCode.js is not loaded");
  }

  const holder = document.createElement("div");

  new window.QRCode(holder, {
    text: value,
    width: 256,
    height: 256,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });

  const canvas = holder.querySelector("canvas");

  if (!canvas) {
    throw new Error("Failed to generate payment QR");
  }

  return canvas.toDataURL("image/png");
}

/**
 * Update the existing Wallet Direct area.
 *
 * The QR encodes ONLY the customer's deposit address.
 * The amount is shown separately.
 */
export function renderWalletDirect(payment, selectors = {}) {
  if (!payment || !validAddress(payment.depositAddress)) {
    throw new Error("Invalid deposit wallet");
  }

  const qrSelector =
    selectors.qrImageSelector || "#wallet-direct-qr";

  const addressSelector =
    selectors.addressSelector || "#wallet-direct-address";

  const amountSelector =
    selectors.amountSelector || "#wallet-direct-amount";

  const qrImage = document.querySelector(qrSelector);
  const addressElement = document.querySelector(addressSelector);
  const amountElement = document.querySelector(amountSelector);

  if (!(qrImage instanceof HTMLImageElement)) {
    throw new Error("Wallet Direct QR image was not found");
  }

  PAY_QR_SRC = qrToDataUrl(payment.depositAddress);

  qrImage.src = PAY_QR_SRC;
  qrImage.alt = "Solana deposit wallet QR code";

  if (addressElement) {
    addressElement.textContent = payment.depositAddress;
  }

  if (amountElement) {
    amountElement.textContent =
      `${formatLamports(payment.expectedLamports)} SOL`;
  }

  return PAY_QR_SRC;
}

/**
 * Legacy transaction helpers.
 * These are client-side observations, NOT proof that
 * an order can be securely fulfilled.
 */

function loadUsed() {
  try {
    const raw = localStorage.getItem(USED_KEY);
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function markUsed(signature) {
  const list = loadUsed().filter(s => s !== signature);
  list.unshift(signature);

  localStorage.setItem(
    USED_KEY,
    JSON.stringify(list.slice(0, 200))
  );
}

export function isPaymentUsed(signature) {
  return loadUsed().includes(signature);
}

export function isLikelySig(signature) {
  return typeof signature === "string" &&
    signature.length >= 64 &&
    signature.length <= 128 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(signature);
}

async function rpc(method, params) {
  let lastError;

  for (const url of RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC HTTP ${response.status}`);
      }

      const json = await response.json();

      if (json.error) {
        throw new Error(json.error.message || "RPC error");
      }

      return json.result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("RPC unavailable");
}

function accountKeys(tx) {
  return (tx?.transaction?.message?.accountKeys || [])
    .map(key => typeof key === "string" ? key : key.pubkey);
}

function walkInstructions(tx, visit) {
  const message = tx?.transaction?.message;
  if (!message) return;

  for (const instruction of message.instructions || []) {
    visit(instruction);
  }

  for (const inner of tx?.meta?.innerInstructions || []) {
    for (const instruction of inner.instructions || []) {
      visit(instruction);
    }
  }
}

export function solReceivedLamports(tx, dest = PAY_ADDRESS) {
  if (!tx?.meta || tx.meta.err || !validAddress(dest)) {
    return 0;
  }

  let transferred = 0;

  walkInstructions(tx, instruction => {
    const parsed = instruction?.parsed;

    if (
      parsed?.type === "transfer" &&
      parsed.info?.destination === dest &&
      parsed.info?.lamports != null
    ) {
      transferred += Number(parsed.info.lamports) || 0;
    }
  });

  if (transferred > 0) return transferred;

  const index = accountKeys(tx).findIndex(key => key === dest);
  if (index < 0) return 0;

  const previous = Number(tx.meta.preBalances?.[index]) || 0;
  const current = Number(tx.meta.postBalances?.[index]) || 0;

  return Math.max(0, current - previous);
}

export async function fetchTransaction(signature) {
  return rpc("getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  ]);
}

export async function verifySignaturePayment(
  signature,
  needLamports,
  opts = {}
) {
  const dest = opts.depositAddress || PAY_ADDRESS;
  const windowSec = opts.windowSec ?? PAY_WINDOW_SEC;

  if (!validAddress(dest)) {
    return {
      ok: false,
      reason: "Create a payment first",
    };
  }

  if (!isLikelySig(signature)) {
    return { ok: false, reason: "Invalid transaction signature" };
  }

  if (!opts.allowUsed && isPaymentUsed(signature)) {
    return { ok: false, reason: "Payment already used locally" };
  }

  const tx = await fetchTransaction(signature);

  if (!tx) {
    return { ok: false, reason: "Transaction not found yet" };
  }

  if (tx.meta?.err) {
    return { ok: false, reason: "Transaction failed on-chain" };
  }

  const blockTime = Number(tx.blockTime) || 0;
  const now = Math.floor(Date.now() / 1000);

  if (
    !blockTime ||
    now - blockTime > windowSec ||
    blockTime > now + 60
  ) {
    return {
      ok: false,
      reason: "Payment outside the verification window",
    };
  }

  const lamports = solReceivedLamports(tx, dest);

  if (lamports < needLamports) {
    return {
      ok: false,
      reason: "Payment amount is insufficient or recipient is wrong",
      lamports,
      sol: lamportsToSol(lamports),
    };
  }

  return {
    ok: true,
    signature,
    lamports,
    sol: lamportsToSol(lamports),
    blockTime,
    verificationLevel: "client-only",
  };
}

export async function findRecentPayment(
  needLamports,
  opts = {}
) {
  const dest = opts.depositAddress || PAY_ADDRESS;

  if (!validAddress(dest)) {
    return { ok: false, reason: "Create a payment first" };
  }

  const windowSec = opts.windowSec ?? PAY_WINDOW_SEC;
  const limit = opts.limit ?? 30;
  const now = Math.floor(Date.now() / 1000);

  const signatures = await rpc("getSignaturesForAddress", [
    dest,
    { limit, commitment: "confirmed" },
  ]);

  for (const row of signatures || []) {
    if (row.err || !row.signature) continue;
    if (isPaymentUsed(row.signature)) continue;

    const blockTime = Number(row.blockTime) || 0;

    if (blockTime && now - blockTime > windowSec) {
      continue;
    }

    try {
      const result = await verifySignaturePayment(
        row.signature,
        needLamports,
        { ...opts, depositAddress: dest }
      );

      if (result.ok) return result;
    } catch {
      // Continue checking other signatures.
    }
  }

  return {
    ok: false,
    reason: "No matching recent payment",
  };
}

export async function confirmPayment(
  needSol,
  pastedSig = "",
  opts = {}
) {
  const needLamports = solToLamports(needSol);

  if (!Number.isSafeInteger(needLamports) ||
      needLamports <= 0) {
    return { ok: false, reason: "Invalid required amount" };
  }

  const signature = String(pastedSig || "").trim();

  const result = signature
    ? await verifySignaturePayment(
        signature,
        needLamports,
        opts
      )
    : await findRecentPayment(needLamports, opts);

  if (result.ok && opts.mark !== false) {
    markUsed(result.signature);
  }

  // Display-only confirmation.
  // NEVER use this result alone to unlock paid features.
  return result;
}
