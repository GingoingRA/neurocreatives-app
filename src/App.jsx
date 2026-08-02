import { useEffect, useRef, useState } from "react";
import { createClient } from "genlayer-js";
import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

/* ============================================================================
 * GenLayer client — wallet connect, reads, writes
 * ==========================================================================*/

const CHAINS = { localnet, studionet, testnetAsimov, testnetBradbury };
const NETWORK_NAME = import.meta.env.VITE_GENLAYER_NETWORK || "studionet";
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;
const chain = CHAINS[NETWORK_NAME];

if (!chain) {
  throw new Error(
    `Unknown GenLayer network "${NETWORK_NAME}". Set VITE_GENLAYER_NETWORK to one of: ` +
      Object.keys(CHAINS).join(", ")
  );
}

let client = null;
let currentAddress = null;

function getConnectedAddress() {
  return currentAddress;
}

// Lets a tab remember "I have a transaction in flight" across page refreshes,
// wallet disconnect/reconnect, and (via always-mounted-but-hidden tabs, see
// the tab-switch fix below) tab switches. Keyed by contract + wallet address +
// which write it was, so switching wallets or contract addresses can't
// resume the wrong thing.
const PENDING_TX_PREFIX = "neurocreatives:pendingTx:";

function pendingTxKey(walletAddress, functionName) {
  return `${PENDING_TX_PREFIX}${CONTRACT_ADDRESS}:${walletAddress}:${functionName}`;
}

function savePendingTx(walletAddress, functionName, hash) {
  try {
    localStorage.setItem(pendingTxKey(walletAddress, functionName), JSON.stringify({ hash, startedAt: Date.now() }));
  } catch (err) {
    // localStorage unavailable (private browsing, storage full, etc.) — the
    // feature just degrades to "doesn't survive a refresh," nothing breaks.
  }
}

function loadPendingTx(walletAddress, functionName) {
  try {
    const raw = localStorage.getItem(pendingTxKey(walletAddress, functionName));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function clearPendingTx(walletAddress, functionName) {
  try {
    localStorage.removeItem(pendingTxKey(walletAddress, functionName));
  } catch (err) {
    // ignore
  }
}

// genlayer-js's own `client.connect()` unconditionally calls MetaMask's
// proprietary Snaps API (`wallet_getSnaps` / `wallet_requestSnaps`) to install
// a GenLayer wallet Snap, with no fallback if the wallet doesn't support
// Snaps. That breaks non-MetaMask wallets (Rabby, etc.) entirely, even though
// the actual on-chain work only needs standard EIP-1193/EIP-3085 calls. This
// replicates just the network add/switch part ourselves so any standard
// wallet works — the trade-off is losing MetaMask's Snap-powered fee-estimate
// insights panel, since that's MetaMask-exclusive either way.
async function ensureCorrectChain() {
  const chainIdHex = `0x${chain.id.toString(16)}`;
  const currentChainId = await window.ethereum.request({ method: "eth_chainId" });

  if (currentChainId === chainIdHex) return;

  const chainParams = {
    chainId: chainIdHex,
    chainName: chain.name,
    rpcUrls: chain.rpcUrls.default.http,
    nativeCurrency: chain.nativeCurrency,
    blockExplorerUrls: chain.blockExplorers?.default?.url ? [chain.blockExplorers.default.url] : [],
  };

  await window.ethereum.request({ method: "wallet_addEthereumChain", params: [chainParams] });
  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: chainIdHex }],
  });
}

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error(
      "No browser wallet found. Install MetaMask, Rabby, or another EIP-1193-compatible wallet."
    );
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts[0];

  client = createClient({ chain, account: address });
  await ensureCorrectChain();
  await checkContractDeployed();

  currentAddress = address;
  return address;
}

// Turns "Requested resource not found... contract not found at address..." (a
// cryptic viem error that only ever surfaced the first time someone tried to
// actually submit something) into an immediate, specific message right at
// connect time. Almost always caused by VITE_CONTRACT_ADDRESS pointing at a
// stale/wrong deployment, or VITE_GENLAYER_NETWORK not matching the network
// the contract actually lives on.
async function checkContractDeployed() {
  if (!CONTRACT_ADDRESS) return; // assertReady() will catch this elsewhere
  try {
    const code = await window.ethereum.request({
      method: "eth_getCode",
      params: [CONTRACT_ADDRESS, "latest"],
    });
    if (!code || code === "0x") {
      throw new Error(
        `No contract found at ${CONTRACT_ADDRESS} on ${NETWORK_NAME}. Check that ` +
          `VITE_CONTRACT_ADDRESS in your .env is the exact address from your most ` +
          `recent deployment, and that VITE_GENLAYER_NETWORK matches the network ` +
          `you actually deployed to (not just the network Studio happened to be ` +
          `set to at the time).`
      );
    }
  } catch (err) {
    if (typeof err?.message === "string" && err.message.startsWith("No contract found")) {
      throw err;
    }
    // The eth_getCode call itself failing (rare) shouldn't block connecting —
    // just skip this proactive check and let normal error handling catch any
    // real problem later.
    console.warn("Could not verify contract deployment:", err);
  }
}

function assertReady() {
  if (!client) throw new Error("Connect your wallet first.");
  if (!CONTRACT_ADDRESS) {
    throw new Error(
      "Missing contract address — set VITE_CONTRACT_ADDRESS in your .env file (see .env.example)."
    );
  }
}

async function readContract(functionName, args = []) {
  assertReady();
  return client.readContract({ address: CONTRACT_ADDRESS, functionName, args });
}

// All of this contract's @gl.public.view methods return a JSON-encoded string
// (not a raw object) — `dict` is a forbidden return type in GenVM's schema
// encoder, so the contract manually json.dumps() everything. Parse it here
// once, in one place, instead of at every call site.
async function readContractJSON(functionName, args = []) {
  const raw = await readContract(functionName, args);
  return JSON.parse(raw);
}

// genlayer-js defaults waitForTransactionReceipt to 10 retries * 3s = 30s
// before giving up — plenty for a plain state write, but nowhere near enough
// for a write that triggers LLM-based consensus (exec_prompt calls across
// multiple validators, PROPOSING -> COMMITTING -> REVEALING -> ACCEPTED can
// easily take a couple of minutes). LLM-heavy calls now use
// writeContractTracked (see below) instead, which watches indefinitely with
// live stage feedback rather than giving up after a fixed budget. Quick,
// non-LLM writes still use this shorter, bounded budget.
const QUICK_WAIT_OPTIONS = { interval: 5000, retries: 30 }; // ~2.5 minutes — for
// writes that are normally fast (no LLM) but can still stall under node congestion.

function isTimeoutError(err) {
  return typeof err?.message === "string" && err.message.startsWith("Timed out waiting for transaction");
}

// A "timed out waiting" error only means our client gave up watching — the
// transaction itself keeps processing on-chain regardless. Rather than
// treating that as a hard failure, poll the read side a few more times to
// see if it actually finished in the meantime.
async function pollUntilReady(fetchFn, isReady, { attempts = 6, delay = 5000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const value = await fetchFn();
    if (isReady(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return null;
}

// genlayer-js's waitForTransactionReceipt treats UNDETERMINED, CANCELED,
// LEADER_TIMEOUT, and VALIDATORS_TIMEOUT as "decided" terminal states and
// resolves *without throwing* even when you asked for ACCEPTED — it only
// throws for an actual client-side timeout (30s default) where the tx is
// still in-flight. That meant a genuinely failed consensus round (e.g.
// UNDETERMINED) looked identical to success from our code's perspective: no
// error, just an empty/stale read afterward. This checks the real outcome.
const NON_SUCCESS_STATUS_MESSAGES = {
  UNDETERMINED:
    "Validators could not reach consensus on this transaction (UNDETERMINED). This usually means the evaluation criteria is too subjective for independent LLM runs to agree on — try again, and if it keeps happening consistently it likely needs a code fix.",
  CANCELED: "Transaction was canceled before it completed.",
  LEADER_TIMEOUT: "The leader validator timed out processing this transaction. Try again.",
  VALIDATORS_TIMEOUT: "Validators timed out reaching consensus on this transaction. Try again.",
};

function isBackpressureError(err) {
  const msg = typeof err?.message === "string" ? err.message : String(err);
  return msg.includes("-32603") || msg.toLowerCase().includes("pipeline backpressure") || msg.toLowerCase().includes("not currently accepting transactions");
}

// The node itself can temporarily refuse new transactions when its internal
// pipeline is backed up ("pipeline backpressure (l1_sender_commit)") — a
// -32603 RPC error. This is a transient node-capacity condition, not
// something wrong with the transaction itself, so the right move is to wait
// and retry rather than fail immediately.
async function submitWithBackpressureRetry(submitFn, { attempts = 12, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await submitFn();
    } catch (err) {
      if (!isBackpressureError(err) || i === attempts - 1) throw err;
      lastErr = err;
      if (onRetry) onRetry(i + 1, attempts);
      // Exponential backoff, capped at 30s: 5s, 10s, 20s, 30s, 30s, 30s...
      // ~12 attempts gives a total budget of roughly 5.5 minutes before
      // finally giving up, since a single fixed 8s x 5 (~40s) budget was
      // nowhere near enough for how long Bradbury actually stays congested.
      const backoffMs = Math.min(5000 * 2 ** i, 30000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

async function writeContract(
  functionName,
  args = [],
  { waitFor = TransactionStatus.ACCEPTED, interval, retries, onRetry } = {}
) {
  assertReady();
  const hash = await submitWithBackpressureRetry(
    () => client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value: 0n }),
    { onRetry }
  );
  const waitOptions = { hash, status: waitFor };
  if (interval !== undefined) waitOptions.interval = interval;
  if (retries !== undefined) waitOptions.retries = retries;
  const receipt = await client.waitForTransactionReceipt(waitOptions);

  const statusName = receipt?.status_name || receipt?.statusName;
  if (statusName && statusName in NON_SUCCESS_STATUS_MESSAGES) {
    throw new Error(NON_SUCCESS_STATUS_MESSAGES[statusName]);
  }
  return receipt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GenLayer's own transaction lifecycle, in order. APPEAL_* only shows up if
// a round gets disputed and re-checked — not part of the normal happy path.
const TX_STAGE_ORDER = ["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "FINALIZED"];
const TX_STAGE_LABELS = {
  PENDING: "Submitted, waiting to be picked up",
  PROPOSING: "Leader validator proposing a result",
  COMMITTING: "Validators committing their votes",
  REVEALING: "Validators revealing their votes",
  APPEAL_COMMITTING: "Under appeal — validators re-committing",
  APPEAL_REVEALING: "Under appeal — validators re-revealing",
  ACCEPTED: "Accepted",
  FINALIZED: "Finalized",
};

// Replaces genlayer-js's own client.waitForTransactionReceipt with our own
// polling loop against client.getTransaction, for two reasons: (1) it lets
// us show which exact stage the transaction is in right now (PROPOSING /
// COMMITTING / REVEALING / ...) instead of a generic spinner, and (2) it
// watches indefinitely (checked via cancelToken) instead of giving up after
// a fixed retries*interval budget and throwing a raw error — which was
// leaving the UI stuck on "still confirming" with no way to recover short of
// resubmitting (burning a limited submission slot) when Bradbury was just
// being slow, not actually failing.
async function writeContractTracked(
  functionName,
  args = [],
  { onStage, onRetry, cancelToken, resumeHash, onHashObtained } = {}
) {
  assertReady();
  const hash =
    resumeHash ||
    (await submitWithBackpressureRetry(
      () => client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value: 0n }),
      { onRetry }
    ));
  if (onHashObtained) onHashObtained(hash);

  const pollIntervalMs = 4000;
  const startTime = Date.now();
  if (onStage) onStage("PENDING", 0);

  while (!cancelToken?.cancelled) {
    await sleep(pollIntervalMs);
    if (cancelToken?.cancelled) break;

    let tx;
    try {
      tx = await client.getTransaction({ hash });
    } catch (err) {
      continue; // transient read hiccup - just retry next tick
    }

    const statusName = tx.statusName || tx.status_name || "PENDING";
    const elapsedMs = Date.now() - startTime;
    if (onStage) onStage(statusName, elapsedMs);

    if (statusName === "ACCEPTED" || statusName === "FINALIZED") {
      return tx;
    }
    if (statusName in NON_SUCCESS_STATUS_MESSAGES) {
      const statusErr = new Error(NON_SUCCESS_STATUS_MESSAGES[statusName]);
      statusErr.statusName = statusName;
      throw statusErr;
    }
  }

  const err = new Error("Stopped watching this transaction.");
  err.cancelled = true;
  throw err;
}

// LEADER_TIMEOUT and VALIDATORS_TIMEOUT are genuine network-level outcomes —
// the assigned leader (or the validator round) simply took too long — not
// bugs, and more likely on Neurocreative submissions specifically since that
// write runs two sequential LLM calls (scoring, then the write-up), giving
// the leader more opportunity to run long. Since the transaction never
// reaches ACCEPTED, none of the contract's state changes apply, so retrying
// is free (it doesn't consume a submission slot) — this automates that
// retry instead of making the user notice the error and resubmit by hand.
// A fresh submission is required on retry (not resumeHash), since the failed
// transaction is dead and can't be resumed.
async function writeContractTrackedWithLeaderRetry(
  functionName,
  args = [],
  { onStage, onRetry, cancelToken, resumeHash, onHashObtained, onLeaderRetry, maxLeaderRetries = 2 } = {}
) {
  let attempt = 0;
  let nextResumeHash = resumeHash;

  while (true) {
    try {
      return await writeContractTracked(functionName, args, {
        onStage,
        onRetry,
        cancelToken,
        resumeHash: nextResumeHash,
        onHashObtained,
      });
    } catch (err) {
      const isLeaderOrValidatorTimeout = err.statusName === "LEADER_TIMEOUT" || err.statusName === "VALIDATORS_TIMEOUT";
      if (!isLeaderOrValidatorTimeout || attempt >= maxLeaderRetries || cancelToken?.cancelled) {
        throw err;
      }
      attempt += 1;
      nextResumeHash = undefined; // the timed-out tx is dead; must submit fresh
      if (onLeaderRetry) onLeaderRetry(attempt, maxLeaderRetries, err.statusName);
    }
  }
}

/* ============================================================================
 * Styles — one shared stylesheet + one theme block per tab
 * ==========================================================================*/

const STYLES = `
* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body { margin: 0; font-family: "Nunito Sans", sans-serif; transition: background 0.4s ease, color 0.4s ease; }
.app { min-height: 100vh; display: flex; flex-direction: column; position: relative; overflow-x: hidden; }

.app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-start; }
.content-flow { display: flex; flex-direction: column; }

/* Two-column row: Codex TV on the left, active tab card on the right.
   Tab switcher + warnings/gates now live inside .tab-column too (not the
   header), sharing the exact same width/center as the card beneath them. */
.two-col { display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap; padding: 4px 28px 26px; }
.tab-column { flex: 1; min-width: 320px; display: flex; flex-direction: column; }
.tab-column-inner { width: 100%; max-width: 760px; margin: 0 auto; box-sizing: border-box; }
.tab-panel { width: 100%; max-width: 760px; margin: 0 auto; box-sizing: border-box; }
.tab-switcher { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-bottom: 16px; }

.news-rail { flex-shrink: 0; width: 400px; max-width: 100%; box-sizing: border-box; position: relative; z-index: 6; }
.news-rail-title { font-size: 1rem; font-weight: 800; margin: 0 0 14px; }
.news-rail-portal-link { display: block; font-size: 0.82rem; font-weight: 700; text-decoration: none; color: inherit; opacity: 0.85; padding: 12px 0; border-top: 1px solid rgba(0,0,0,0.08); margin-top: 16px; }
.news-rail-portal-link:hover { opacity: 1; }
.news-rail-note { font-size: 0.7rem; opacity: 0.5; margin-top: 10px; line-height: 1.4; }
.app--neuro .news-rail-portal-link { border-color: rgba(255,255,255,0.12); }

.tv-frame { width: 400px; max-width: 100%; background: linear-gradient(160deg, #3a3a42, #202024); border-radius: 26px; padding: 18px 18px 0; box-shadow: 0 18px 38px rgba(0,0,0,0.3), inset 0 0 0 3px rgba(255,255,255,0.06); }
.tv-screen { position: relative; background: #060608; border-radius: 16px; height: 330px; overflow: hidden; display: flex; align-items: center; justify-content: center; padding: 26px; box-shadow: inset 0 0 32px rgba(0,0,0,0.8); }
.tv-slide { position: relative; z-index: 1; text-align: center; animation: tv-slide-in 0.5s ease; }
@keyframes tv-slide-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
.tv-slide-title { margin: 0 0 12px; font-size: 1.15rem; font-weight: 800; color: #c6ff3d; text-shadow: 0 0 14px rgba(198,255,61,0.5); letter-spacing: 0.02em; }
.tv-slide-body { margin: 0; font-size: 0.92rem; line-height: 1.5; color: #f1f0ff; opacity: 0.92; max-width: 320px; }
.tv-scanlines { position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(to bottom, rgba(255,255,255,0.035) 0px, rgba(255,255,255,0.035) 1px, transparent 1px, transparent 4px); mix-blend-mode: overlay; }
.tv-dots { display: flex; justify-content: center; gap: 8px; padding: 16px 0; }
.tv-dot { width: 8px; height: 8px; border-radius: 50%; border: none; background: rgba(255,255,255,0.25); cursor: pointer; padding: 0; transition: all 0.2s ease; }
.tv-dot--active { background: #c6ff3d; box-shadow: 0 0 10px rgba(198,255,61,0.7); transform: scale(1.3); }
.tv-stand { width: 84px; height: 18px; margin: 0 auto; background: linear-gradient(160deg, #3a3a42, #17171a); border-radius: 0 0 9px 9px; }
.tv-stand::after { content: ""; display: block; width: 126px; height: 7px; margin: 0 auto; background: #17171a; border-radius: 4px; transform: translateY(12px); }

@media (max-width: 900px) {
  .two-col { flex-direction: column; padding: 4px 16px 22px; }
  .news-rail { width: 100%; }
  .tv-frame { width: 100%; max-width: 400px; margin: 0 auto; }
}

/* Header */
.site-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 28px; gap: 16px; flex-wrap: wrap; position: relative; z-index: 10; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand-logo { height: 34px; width: auto; border-radius: 8px; }
.brand-name { font-weight: 800; font-size: 1.15rem; letter-spacing: 0.01em; }
.tab-btn { border: none; padding: 10px 18px; border-radius: 999px; font-weight: 700; cursor: pointer; font-size: 0.9rem; opacity: 0.6; background: rgba(0,0,0,0.06); transition: all 0.2s ease; }
.tab-btn--active { opacity: 1; transform: translateY(-1px); }
.connect-btn, .primary-btn, .secondary-btn { border: none; cursor: pointer; font-weight: 700; border-radius: 999px; padding: 12px 22px; font-size: 0.95rem; transition: transform 0.12s ease, box-shadow 0.12s ease; }
.connect-btn:disabled, .primary-btn:disabled, .secondary-btn:disabled { opacity: 0.6; cursor: default; }
.wallet-chip { background: rgba(0,0,0,0.08); padding: 8px 14px; border-radius: 999px; font-weight: 700; font-size: 0.85rem; }

/* Gates */
.wallet-gate, .username-gate { margin: 40px auto; text-align: center; z-index: 5; position: relative; padding: 0 20px; }
.username-gate { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.username-gate input { padding: 10px 16px; border-radius: 999px; border: 2px solid rgba(0,0,0,0.12); font-size: 1rem; font-family: inherit; }
.error-banner { background: #ffe1e1; color: #a3222f; padding: 10px 18px; border-radius: 12px; max-width: 560px; margin: 0 auto 12px; text-align: center; position: relative; z-index: 5; font-weight: 600; }
.network-warning { background: #fff4d6; color: #7a5b00; padding: 8px 18px; border-radius: 12px; max-width: 620px; margin: 0 auto 12px; text-align: center; position: relative; z-index: 5; font-size: 0.85rem; font-weight: 600; }

/* Footer */
.site-footer { margin-top: auto; display: flex; justify-content: center; padding: 28px 0 36px; position: relative; z-index: 5; }
.powered-by { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; opacity: 0.75; font-size: 0.85rem; font-weight: 700; transition: opacity 0.15s ease; }
.powered-by:hover { opacity: 1; }
.footer-logo { height: 18px; width: auto; border-radius: 4px; }

/* Stickers */
.sticker-field { position: absolute; inset: 0; pointer-events: none; z-index: 1; overflow: hidden; }
.sticker { position: absolute; display: inline-block; animation: sticker-bob 5s ease-in-out infinite; }
.sticker-emoji { display: inline-block; filter: drop-shadow(0 6px 10px rgba(0,0,0,0.18)); }
@keyframes sticker-bob { 0%, 100% { margin-top: 0; } 50% { margin-top: -14px; } }
@media (prefers-reduced-motion: reduce) { .sticker { animation: none; } }

/* Shared form basics */
textarea { width: 100%; border-radius: 18px; border: 2px solid rgba(0,0,0,0.1); padding: 16px; font-family: inherit; font-size: 1rem; resize: vertical; }
.char-count { text-align: right; font-size: 0.8rem; opacity: 0.6; margin-top: 4px; }
.leaderboard { margin-top: 18px; padding-left: 20px; }
.loading-dots::after { content: ''; display: inline-block; width: 1.2em; text-align: left; animation: loading-dots-anim 1.2s steps(4, end) infinite; }
@keyframes loading-dots-anim { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } 100% { content: ''; } }
.progress-note { display: flex; align-items: center; gap: 8px; justify-content: center; max-width: 560px; margin: 12px auto 0; padding: 10px 18px; border-radius: 12px; font-size: 0.85rem; font-weight: 600; background: rgba(0,0,0,0.05); position: relative; z-index: 5; }

/* Tx progress bar */
.tx-progress { max-width: 560px; margin: 16px auto 0; padding: 16px 18px; border-radius: 14px; background: rgba(0,0,0,0.04); position: relative; z-index: 5; }
.tx-progress-steps { display: flex; align-items: flex-start; justify-content: space-between; gap: 4px; }
.tx-step { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: 1; opacity: 0.4; transition: opacity 0.3s ease; }
.tx-step--done { opacity: 1; }
.tx-step--current { opacity: 1; }
.tx-step-dot { width: 10px; height: 10px; border-radius: 50%; background: rgba(0,0,0,0.25); transition: all 0.3s ease; }
.tx-step--done .tx-step-dot { background: #4ecdc4; }
.tx-step--current .tx-step-dot { background: #ff6f59; box-shadow: 0 0 0 4px rgba(255,111,89,0.25); animation: tx-pulse 1.4s ease-in-out infinite; }
@keyframes tx-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.3); } }
.tx-step-label { font-size: 0.62rem; font-weight: 700; text-align: center; line-height: 1.2; }
.tx-appeal-note { text-align: center; font-size: 0.78rem; font-weight: 700; color: #b45400; margin: 10px 0 0; }
.tx-progress-detail { text-align: center; font-size: 0.78rem; opacity: 0.75; margin: 12px 0 0; }
.tx-slow-note { margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(0,0,0,0.15); text-align: center; }
.tx-slow-note p { font-size: 0.75rem; opacity: 0.75; line-height: 1.5; margin: 0 0 10px; }
.tx-stop-btn { font-size: 0.78rem; padding: 8px 16px; margin-top: 0 !important; }
.app--neuro .tx-progress { background: rgba(255,255,255,0.06); }
.app--neuro .tx-step-dot { background: rgba(255,255,255,0.2); }
.app--neuro .tx-slow-note { border-color: rgba(255,255,255,0.15); }
.app--neuro .tx-appeal-note { color: #ffb37a; }
@media (max-width: 640px) { .site-header { justify-content: center; text-align: center; } }

/* ---- Theme 1: Neurocreative Challenge (electric / dark) ---- */
.app--neuro { --bg:#14121f; --lime:#c6ff3d; --magenta:#ff3da6; --cyan:#35e5ff; --ink:#f1f0ff; background: radial-gradient(circle at 90% 0%, rgba(255,61,166,0.25), transparent 45%), radial-gradient(circle at 0% 100%, rgba(53,229,255,0.2), transparent 45%), var(--bg); color: var(--ink); }
.app--neuro h1, .app--neuro .brand-name { font-family: "Space Grotesk", sans-serif; }
.app--neuro .tab-btn { background: rgba(255,255,255,0.07); color: var(--ink); }
.app--neuro .tab-btn--active { background: var(--lime); color: #14121f; }
.app--neuro .connect-btn, .app--neuro .primary-btn { background: var(--magenta); color: #14121f; box-shadow: 0 0 22px rgba(255,61,166,0.55); }
.app--neuro .connect-btn:active, .app--neuro .primary-btn:active { transform: translateY(2px); box-shadow: 0 0 12px rgba(255,61,166,0.45); }
.app--neuro .secondary-btn { background: var(--cyan); color: #0b2b30; box-shadow: 0 0 18px rgba(53,229,255,0.45); margin-top: 16px; }
.app--neuro .wallet-chip { background: rgba(255,255,255,0.1); color: var(--ink); }
.app--neuro .progress-note { background: rgba(255,255,255,0.08); color: var(--ink); }
.app--neuro textarea { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.16); color: var(--ink); }
.app--neuro textarea:focus { outline: none; border-color: var(--cyan); }
.app--neuro .username-gate input { background: rgba(255,255,255,0.06); color: var(--ink); border-color: rgba(255,255,255,0.2); }
.app--neuro .username-gate input:focus { outline: none; border-color: var(--cyan); }
.neuro-tab { position: relative; padding: 20px 24px 60px; display: flex; justify-content: center; }
.neuro-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 24px; padding: 36px; max-width: 760px; width: 100%; backdrop-filter: blur(6px); position: relative; z-index: 4; }
.neuro-card h1 { font-size: 2.1rem; margin: 0 0 6px; color: var(--lime); }
.neuro-subtitle { opacity: 0.75; margin-bottom: 20px; line-height: 1.5; }
.neuro-result { margin-top: 26px; display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
.neuro-score-ring { width: 130px; height: 130px; border-radius: 50%; background: conic-gradient(var(--lime) calc(var(--score) * 1%), rgba(255,255,255,0.08) 0); display: flex; align-items: center; justify-content: center; }
.neuro-score-ring span { width: 92px; height: 92px; border-radius: 50%; background: #14121f; display: flex; align-items: center; justify-content: center; font-size: 1.7rem; font-weight: 800; color: var(--lime); }
.neuro-rings { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; font-size: 0.85rem; opacity: 0.9; }
.neuro-rings div { background: rgba(255,255,255,0.06); padding: 6px 14px; border-radius: 999px; }
.verdict { max-width: 480px; line-height: 1.6; background: rgba(255,255,255,0.06); padding: 16px 20px; border-radius: 16px; border-left: 3px solid var(--magenta); text-align: left; }
.verdict-label { margin: 0 0 6px; font-weight: 800; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
.verdict-text { margin: 0; white-space: pre-line; }
.slop-flag { background: rgba(255,61,166,0.15); border: 1px solid rgba(255,61,166,0.4); color: #ffd2ea; padding: 8px 16px; border-radius: 12px; font-size: 0.85rem; font-weight: 700; max-width: 480px; text-align: center; }
.neuro-error { color: #ff7a9c; font-weight: 700; margin-top: 10px; }
.app--neuro .leaderboard-list { list-style: none; padding: 0; margin-top: 14px; text-align: left; }
.app--neuro .leaderboard-list li { background: rgba(255,255,255,0.05); padding: 8px 14px; border-radius: 12px; margin-bottom: 6px; }

/* ---- Theme 3: GitHub GenLayer Engagement (badge / contributor) ---- */
.app--github { --bg:#f4f7f1; --primary:#1f6f4a; --primary-shadow:#164f35; --gold:#e8a33d; --gold-shadow:#b97c22; --ink:#1b2b22; background: radial-gradient(circle at 85% 0%, #e4f0e6 0%, var(--bg) 55%), var(--bg); color: var(--ink); }
.app--github h1, .app--github .brand-name { font-family: "Sora", sans-serif; }
.app--github .tab-btn--active { background: var(--primary); color: white; }
.app--github .connect-btn, .app--github .primary-btn { background: var(--primary); color: white; box-shadow: 0 6px 0 var(--primary-shadow); }
.app--github .connect-btn:active, .app--github .primary-btn:active { transform: translateY(3px); box-shadow: 0 3px 0 var(--primary-shadow); }
.app--github .secondary-btn { background: var(--gold); color: #402c05; box-shadow: 0 6px 0 var(--gold-shadow); margin-top: 16px; }
.app--github .secondary-btn:active { transform: translateY(3px); box-shadow: 0 3px 0 var(--gold-shadow); }
.app--github .username-gate input, .app--github .handle-input { background: white; border: 2px solid rgba(31,111,74,0.2); }
.app--github .username-gate input:focus, .app--github textarea:focus, .app--github .handle-input:focus { outline: none; border-color: var(--primary); }
.github-tab { position: relative; padding: 20px 24px 60px; display: flex; justify-content: center; }
.github-card { background: white; border-radius: 24px; padding: 36px; max-width: 760px; width: 100%; box-shadow: 0 16px 40px rgba(31,111,74,0.14); position: relative; z-index: 4; border: 3px solid #dcebe0; }
.github-card h1 { font-size: 2.1rem; margin: 0 0 6px; color: var(--primary); }
.github-subtitle { opacity: 0.75; margin-bottom: 22px; line-height: 1.5; }
.handle-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
.handle-input { flex: 1; min-width: 180px; border-radius: 999px; padding: 12px 18px; font-size: 1rem; font-family: inherit; }
.handle-saved { font-size: 0.85rem; opacity: 0.7; margin: -10px 0 16px; }
.github-result { margin-top: 26px; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
.badge-hex { position: relative; width: 120px; height: 120px; min-width: 120px; border-radius: 50%; background: conic-gradient(var(--primary) calc(var(--score) * 1%), #e6efe8 0); display: flex; align-items: center; justify-content: center; }
.badge-hex-inner { width: 84px; height: 84px; border-radius: 50%; background: white; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.badge-hex-inner .score-num { font-size: 1.4rem; font-weight: 900; color: var(--primary); }
.badge-hex-inner .score-max { font-size: 0.7rem; opacity: 0.6; }
.tier-pill { display: inline-block; background: var(--gold); color: #402c05; font-weight: 800; font-size: 0.8rem; padding: 4px 14px; border-radius: 999px; margin-bottom: 10px; }
.facts-list { list-style: none; padding: 0; margin: 0 0 10px; font-size: 0.88rem; font-weight: 600; }
.facts-list li { margin-bottom: 3px; }
.engagement-summary { font-style: italic; opacity: 0.85; margin-top: 6px; }
.github-error { color: #a3222f; font-weight: 700; margin-top: 10px; }
`;

/* ============================================================================
 * Small shared components
 * ==========================================================================*/

function StickerField({ stickers }) {
  return (
    <div className="sticker-field" aria-hidden="true">
      {stickers.map((s, i) => (
        <span
          key={i}
          className="sticker"
          style={{
            top: s.top,
            left: s.left,
            transform: `rotate(${s.rotate || 0}deg)`,
            animationDelay: s.delay || `${i * 0.4}s`,
          }}
        >
          <span className="sticker-emoji" style={{ fontSize: s.size || "2rem" }}>
            {s.emoji}
          </span>
        </span>
      ))}
    </div>
  );
}

function TxProgressBar({ stage, elapsedMs, onStopWatching }) {
  const isAppeal = stage === "APPEAL_COMMITTING" || stage === "APPEAL_REVEALING";
  // Appeal rounds happen after the normal REVEALING stage already occurred,
  // so light up progress dots through REVEALING while one is in progress.
  const idx = isAppeal ? TX_STAGE_ORDER.indexOf("REVEALING") : TX_STAGE_ORDER.indexOf(stage);
  const label = TX_STAGE_LABELS[stage] || "Working";
  const minutes = Math.floor((elapsedMs || 0) / 60000);
  const seconds = Math.floor(((elapsedMs || 0) % 60000) / 1000);
  const isSlow = (elapsedMs || 0) > 5 * 60 * 1000; // 5+ minutes

  return (
    <div className="tx-progress">
      <div className="tx-progress-steps">
        {TX_STAGE_ORDER.map((s, i) => (
          <div
            key={s}
            className={
              "tx-step" +
              (idx >= 0 && i <= idx ? " tx-step--done" : "") +
              (s === stage ? " tx-step--current" : "")
            }
          >
            <span className="tx-step-dot"></span>
            <span className="tx-step-label">{s === "PENDING" ? "Submitted" : s.charAt(0) + s.slice(1).toLowerCase()}</span>
          </div>
        ))}
      </div>

      {isAppeal && (
        <p className="tx-appeal-note">⚖️ Under appeal — validators are re-checking this round.</p>
      )}

      <p className="tx-progress-detail">
        {label}
        <span className="loading-dots"></span> · {minutes}m {seconds}s elapsed
      </p>

      {isSlow && (
        <div className="tx-slow-note">
          <p>
            This is taking longer than usual — Bradbury is a testnet, so this can happen. Your
            submission is already on-chain either way; it won't be lost if you stop watching.
          </p>
          {onStopWatching && (
            <button className="secondary-btn tx-stop-btn" onClick={onStopWatching} type="button">
              Stop watching (check back later)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Header({ address, onConnect, connecting }) {
  return (
    <header className="site-header">
      <div className="brand">
        <img src="/genlayer-logo.jpg" alt="GenLayer" className="brand-logo" />
        <span className="brand-name">Neurocreatives</span>
      </div>

      <div className="wallet-area">
        {address ? (
          <span className="wallet-chip">{address.slice(0, 6)}…{address.slice(-4)}</span>
        ) : (
          <button className="connect-btn" onClick={onConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        )}
      </div>
    </header>
  );
}

function TabSwitcher({ tab, onTabChange }) {
  return (
    <nav className="tab-switcher">
      <button className={tab === "neuro" ? "tab-btn tab-btn--active" : "tab-btn"} onClick={() => onTabChange("neuro")}>
        🧠 Neurocreative Challenge
      </button>
      <button className={tab === "github" ? "tab-btn tab-btn--active" : "tab-btn"} onClick={() => onTabChange("github")}>
        🐙 GenLayer Engagement
      </button>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <a href="https://genlayer.com" target="_blank" rel="noopener noreferrer" className="powered-by">
        <img src="/genlayer-logo.jpg" alt="" className="footer-logo" />
        Powered by GenLayer
      </a>
    </footer>
  );
}

/* ============================================================================
 * Codex TV — left sidebar, a TV-shaped display flipping through curated tips
 * from GenLayer's official Codex of Content (the community content-curation
 * guide). Static/curated, not live-scraped — see CODEX_HIGHLIGHTS below.
 * ==========================================================================*/

const CODEX_HIGHLIGHTS = [
  {
    title: "Quality Over Quantity",
    body: "Each creator gets 2 weekly submission spots. A low-effort post that scores 0 Yes / 5 No votes and gets rejected costs you a spot next week — better to submit less and make it count.",
  },
  {
    title: "AI Is a Tool, Not a Shortcut",
    body: "GenLayer doesn't reject AI-assisted content — it rejects generic, single-prompt output. Good AI-assisted content still takes real editing, iteration, and a personal touch.",
  },
  {
    title: "Engagement Still Matters",
    body: "Content under ~50 views may be rejected unless it's exceptionally strong. Real organic engagement signals genuine value — botted metrics don't count.",
  },
  {
    title: "Avoid Templated Content",
    body: "Reusing the same background, format, or structure across posts reads as low-effort. Bring your own original angle every time, even within a familiar format.",
  },
  {
    title: "Match Format to Idea",
    body: "A simple idea fits a short post; a deeper topic deserves a full article. Pick the format that actually fits what you're saying, not the one that's easiest.",
  },
  {
    title: "Builder Content Belongs on the Portal",
    body: "Intelligent Contract builds and technical apps are best submitted to the GenLayer Portal for review by Stewards — Discord is for educational, social, and creative content.",
  },
  {
    title: "Originality Is Non-Negotiable",
    body: "Posting someone else's work as your own isn't allowed. Taking inspiration is fine — recreating another creator's work too closely is not.",
  },
  {
    title: "Higher Roles, Higher Standards",
    body: "Brain, Neurocreative, and Singularity members are held to the highest content bar, since they represent the community more visibly than newer members.",
  },
  {
    title: "What Gets Rejected Fast",
    body: "Generic AI-generated text, poorly generated AI visuals, incorrect mascot/brand depictions, and visible AI-tool watermarks are the most common rejection reasons.",
  },
  {
    title: "Two Bad Weeks, One Cooldown",
    body: "A rejection with 0 Yes / 5 No votes costs a submission spot. Hit zero spots and you're in a one-week cooldown before your default two spots return.",
  },
];

function CodexTV() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % CODEX_HIGHLIGHTS.length);
    }, 7000);
    return () => clearInterval(timer);
  }, []);

  const current = CODEX_HIGHLIGHTS[index];

  return (
    <aside className="news-rail">
      <h2 className="news-rail-title">📺 Codex of Content</h2>

      <div className="tv-frame">
        <div className="tv-screen">
          <div key={index} className="tv-slide">
            <p className="tv-slide-title">{current.title}</p>
            <p className="tv-slide-body">{current.body}</p>
          </div>
          <div className="tv-scanlines" aria-hidden="true"></div>
        </div>
        <div className="tv-dots">
          {CODEX_HIGHLIGHTS.map((_, i) => (
            <button
              key={i}
              className={i === index ? "tv-dot tv-dot--active" : "tv-dot"}
              onClick={() => setIndex(i)}
              aria-label={`Show tip ${i + 1}`}
            />
          ))}
        </div>
        <div className="tv-stand" aria-hidden="true"></div>
      </div>

      <a
        className="news-rail-portal-link"
        href="https://portal.genlayer.foundation"
        target="_blank"
        rel="noopener noreferrer"
      >
        🏛️ Builder quests, AMAs &amp; community tasks →
      </a>
    </aside>
  );
}

/* ============================================================================
 * Tab 1 — Neurocreative Challenge
 * ==========================================================================*/

const NEURO_STICKERS = [
  { emoji: "🧠", top: "8%", left: "6%", rotate: -10, size: "3rem" },
  { emoji: "⚡", top: "18%", left: "90%", rotate: 12, size: "2.6rem" },
  { emoji: "🔮", top: "72%", left: "8%", rotate: -8, size: "2.6rem" },
  { emoji: "💥", top: "82%", left: "86%", rotate: 10, size: "2.4rem" },
  { emoji: "🌀", top: "45%", left: "94%", rotate: -6, size: "2.2rem" },
  { emoji: "🎨", top: "55%", left: "2%", rotate: 8, size: "2.2rem" },
];

function NeuroChallengeTab() {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("idle"); // idle | evaluating | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [retryNotice, setRetryNotice] = useState("");
  const [txStage, setTxStage] = useState(null);
  const [txElapsedMs, setTxElapsedMs] = useState(0);
  const [leaderboard, setLeaderboard] = useState(null);
  const [showBoard, setShowBoard] = useState(false);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const cancelTokenRef = useRef(null);
  const submittedContentRef = useRef(""); // remembers what was submitted, for resume-after-refresh

  const busy = status === "evaluating";
  const onRetry = (attempt, max) =>
    setRetryNotice(`Node is busy right now — retrying (${attempt}/${max})…`);

  // On mount (including after a page refresh, or reconnecting a wallet),
  // check whether there's a submission still being watched from before and
  // pick the watch back up automatically instead of leaving the user with no
  // sign it's still in progress.
  useEffect(() => {
    const walletAddress = getConnectedAddress();
    if (!walletAddress) return;
    const pending = loadPendingTx(walletAddress, "submit_content_for_evaluation");
    if (pending?.hash) {
      runTrackedSubmission({ resumeHash: pending.hash, walletAddress });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTrackedSubmission = async ({ resumeHash, walletAddress }) => {
    const cancelToken = { cancelled: false };
    cancelTokenRef.current = cancelToken;

    try {
      setStatus("evaluating");
      const before = await readContractJSON("get_my_content_evaluations", []);
      const previousCount = before.submissions_made;

      await writeContractTrackedWithLeaderRetry("submit_content_for_evaluation", [submittedContentRef.current], {
        onRetry,
        cancelToken,
        resumeHash,
        onHashObtained: (hash) => savePendingTx(walletAddress, "submit_content_for_evaluation", hash),
        onStage: (stage, elapsedMs) => {
          setRetryNotice("");
          setTxStage(stage);
          setTxElapsedMs(elapsedMs);
        },
        onLeaderRetry: (attempt, max) => {
          setTxStage(null);
          setRetryNotice(
            `The leader validator timed out — automatically resubmitting (${attempt}/${max}). This doesn't use up a submission slot.`
          );
        },
      });

      clearPendingTx(walletAddress, "submit_content_for_evaluation");

      // Read-after-write lag: the ACCEPTED/FINALIZED state we just saw can
      // still momentarily precede the state actually being queryable — poll
      // briefly rather than trusting a single immediate read.
      const found = await pollUntilReady(
        () => readContractJSON("get_my_content_evaluations", []),
        (mine) => mine.submissions_made > previousCount,
        { attempts: 8, delay: 4000 }
      );
      if (found) {
        setResult(found.my_evaluations[found.my_evaluations.length - 1]);
        setStatus("done");
        setContent("");
      } else {
        setError(
          "The transaction succeeded but the result isn't showing up yet. Try reloading in a moment, or check the community leaderboard below."
        );
        setStatus("idle");
      }
    } catch (err) {
      if (!err.cancelled) {
        clearPendingTx(walletAddress, "submit_content_for_evaluation");
        setError(err.message || String(err));
        setStatus("idle");
      }
    } finally {
      setTxStage(null);
      setRetryNotice("");
    }
  };

  const handleStopWatching = () => {
    if (cancelTokenRef.current) cancelTokenRef.current.cancelled = true;
    setError(
      "Stopped watching. Your submission is still on-chain — reopen this tab later, or check the community leaderboard, to see the result once it's done."
    );
    setStatus("idle");
    setTxStage(null);
  };

  const handleSubmit = async () => {
    setError("");
    setRetryNotice("");
    setResult(null);
    setTxStage(null);
    setTxElapsedMs(0);
    if (content.trim().length < 20) {
      setError("Write at least 20 characters about GenLayer to enter the challenge.");
      return;
    }

    const walletAddress = getConnectedAddress();
    submittedContentRef.current = content.trim();
    await runTrackedSubmission({ walletAddress });
  };

  const loadLeaderboard = async () => {
    setLoadingBoard(true);
    try {
      const board = await readContractJSON("get_content_leaderboard", []);
      setLeaderboard(board);
      setShowBoard(true);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoadingBoard(false);
    }
  };

  const b = result?.breakdown;

  // Mirrors ASSESSMENT_HIGH_SCORE_THRESHOLD / ASSESSMENT_LOW_SCORE_THRESHOLD
  // in the contract — keep these two in sync if those ever change.
  const verdictLabel = (score) => {
    if (score >= 85) return "🎉 Nailed it:";
    if (score < 40) return "Needs work:";
    return "Why this score:";
  };

  return (
    <main className="neuro-tab">
      <StickerField stickers={NEURO_STICKERS} />
      <div className="neuro-card">
        <h1>Neurocreative Challenge</h1>
        <p className="neuro-subtitle">
          Write something about GenLayer — an explainer, a pitch, a wild analogy. Validators
          fact-check it against the protocol and hand back a 5-line verdict.
        </p>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={4000}
          rows={7}
          placeholder="e.g. Explain GenLayer's Equivalence Principle like you're pitching it to a room of skeptical bankers..."
          disabled={busy}
        />
        <div className="char-count">{content.length}/4000</div>

        <button className="primary-btn" onClick={handleSubmit} disabled={busy}>
          {busy ? (
            <>
              Validators are grading it<span className="loading-dots"></span>
            </>
          ) : (
            "Submit for Grading ⚡"
          )}
        </button>

        {retryNotice && <p className="progress-note">⚠️ {retryNotice}</p>}

        {busy && txStage && (
          <TxProgressBar stage={txStage} elapsedMs={txElapsedMs} onStopWatching={handleStopWatching} />
        )}

        {busy && !txStage && (
          <p className="progress-note">
            ⏳ Submitting<span className="loading-dots"></span>
          </p>
        )}

        {error && <p className="neuro-error">{error}</p>}

        {result && (
          <div className="neuro-result">
            <div className="neuro-score-ring" style={{ "--score": result.score }}>
              <span>{result.score}</span>
            </div>
            <div className="neuro-rings">
              <div>Accuracy <b>{b.accuracy}</b>/10</div>
              <div>Relevance <b>{b.relevance}</b>/10</div>
              <div>Originality <b>{b.originality}</b>/10</div>
              <div>Effort <b>{b.effort}</b>/10</div>
              <div>Clarity <b>{b.clarity}</b>/10</div>
              <div>Authenticity <b>{10 - b.ai_slop}</b>/10</div>
            </div>
            {b.ai_slop >= 7 && (
              <p className="slop-flag">🤖 Flagged as likely AI-generated filler — this caps the score heavily.</p>
            )}
            <div className="verdict">
              <p className="verdict-label">{verdictLabel(result.score)}</p>
              <p className="verdict-text">{result.assessment}</p>
            </div>
          </div>
        )}

        <button className="secondary-btn" onClick={loadLeaderboard} disabled={loadingBoard}>
          {loadingBoard ? "Loading…" : "🏆 See community leaderboard"}
        </button>

        {showBoard && leaderboard && (
          <ul className="leaderboard-list">
            {leaderboard.submissions.slice(0, 5).map((it) => (
              <li key={it.id}>
                <strong>{it.username}</strong> — {it.score}/100
              </li>
            ))}
            {leaderboard.submissions.length === 0 && <li>No submissions yet — be the first!</li>}
          </ul>
        )}
      </div>
    </main>
  );
}

/* ============================================================================
 * Tab 3 — GenLayer Engagement (GitHub profile check)
 * ==========================================================================*/

const GITHUB_STICKERS = [
  { emoji: "🐙", top: "8%", left: "5%", rotate: -10, size: "2.8rem" },
  { emoji: "🏅", top: "16%", left: "90%", rotate: 10, size: "2.4rem" },
  { emoji: "⭐", top: "74%", left: "8%", rotate: -8, size: "2.2rem" },
  { emoji: "🔧", top: "84%", left: "86%", rotate: 12, size: "2.4rem" },
  { emoji: "🧩", top: "46%", left: "93%", rotate: -6, size: "2.2rem" },
  { emoji: "🚀", top: "56%", left: "2%", rotate: 8, size: "2.2rem" },
];

function GitHubEngagementTab() {
  const [handleInput, setHandleInput] = useState("");
  const [handle, setHandle] = useState("");
  const [savingHandle, setSavingHandle] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [profile, setProfile] = useState(null); // result of get_my_engagement
  const [error, setError] = useState("");
  const [retryNotice, setRetryNotice] = useState("");
  const [txStage, setTxStage] = useState(null);
  const [txElapsedMs, setTxElapsedMs] = useState(0);
  const [leaderboard, setLeaderboard] = useState(null);
  const [showBoard, setShowBoard] = useState(false);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const cancelTokenRef = useRef(null);

  const onRetry = (attempt, max) =>
    setRetryNotice(`Node is busy right now — retrying (${attempt}/${max})…`);

  const handleStopWatchingEvaluate = () => {
    if (cancelTokenRef.current) cancelTokenRef.current.cancelled = true;
    setError(
      "Stopped watching. Your check is still running on-chain — reopen this tab later to see the result."
    );
    setEvaluating(false);
    setTxStage(null);
  };

  // Load any existing handle/evaluation for this wallet on mount, and resume
  // watching a still-in-flight check if one was left running (page refresh,
  // wallet reconnect, or coming back to this tab).
  useEffect(() => {
    (async () => {
      try {
        const mine = await readContractJSON("get_my_engagement", []);
        if (mine?.github_handle) setHandle(mine.github_handle);
        if (mine?.evaluated) setProfile(mine);
      } catch (err) {
        console.warn("Could not load existing engagement profile:", err);
      }
    })();

    const walletAddress = getConnectedAddress();
    if (!walletAddress) return;
    const pending = loadPendingTx(walletAddress, "evaluate_my_genlayer_engagement");
    if (pending?.hash) {
      runTrackedEvaluate({ resumeHash: pending.hash, walletAddress });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveHandle = async () => {
    const trimmed = handleInput.trim();
    if (!trimmed) return;
    setError("");
    setSavingHandle(true);
    try {
      await writeContract("set_github_handle", [trimmed], { ...QUICK_WAIT_OPTIONS, onRetry });
      setRetryNotice("");
      setHandle(trimmed);
      setHandleInput("");
      setProfile(null); // stale until re-evaluated
    } catch (err) {
      if (isTimeoutError(err)) {
        setError("Still confirming — checking…");
        const landed = await pollUntilReady(
          () => readContractJSON("get_my_engagement", []),
          (mine) => mine.github_handle === trimmed,
          { attempts: 6, delay: 5000 }
        );
        if (landed) {
          setHandle(trimmed);
          setHandleInput("");
          setProfile(null);
          setError("");
        } else {
          setError("Saving the handle didn't confirm in time. Please try again.");
        }
      } else {
        setError(err.message || String(err));
      }
    } finally {
      setSavingHandle(false);
      setRetryNotice("");
    }
  };

  const runTrackedEvaluate = async ({ resumeHash, walletAddress }) => {
    setEvaluating(true);
    const cancelToken = { cancelled: false };
    cancelTokenRef.current = cancelToken;

    try {
      const before = await readContractJSON("get_my_engagement", []);
      const beforeSnapshot = JSON.stringify(before);

      await writeContractTrackedWithLeaderRetry("evaluate_my_genlayer_engagement", [], {
        onRetry,
        cancelToken,
        resumeHash,
        onHashObtained: (hash) => savePendingTx(walletAddress, "evaluate_my_genlayer_engagement", hash),
        onStage: (stage, elapsedMs) => {
          setRetryNotice("");
          setTxStage(stage);
          setTxElapsedMs(elapsedMs);
        },
        onLeaderRetry: (attempt, max) => {
          setTxStage(null);
          setRetryNotice(
            `The leader validator timed out — automatically resubmitting (${attempt}/${max}).`
          );
        },
      });

      clearPendingTx(walletAddress, "evaluate_my_genlayer_engagement");

      // Same read-after-write lag concern as the other tabs — and since
      // `evaluated` alone would already be true on a *re*-evaluation, compare
      // the whole snapshot so a stale (previous) result isn't mistaken for
      // the fresh one.
      const found = await pollUntilReady(
        () => readContractJSON("get_my_engagement", []),
        (mine) => mine.evaluated && JSON.stringify(mine) !== beforeSnapshot,
        { attempts: 8, delay: 4000 }
      );
      if (found) {
        setProfile(found);
      } else {
        setError(
          "The transaction succeeded but the result isn't showing up yet. Try reloading in a moment."
        );
      }
    } catch (err) {
      if (!err.cancelled) {
        clearPendingTx(walletAddress, "evaluate_my_genlayer_engagement");
        setError(err.message || String(err));
      }
    } finally {
      setEvaluating(false);
      setTxStage(null);
      setRetryNotice("");
    }
  };

  const handleEvaluate = async () => {
    setError("");
    setRetryNotice("");
    setTxStage(null);
    setTxElapsedMs(0);
    await runTrackedEvaluate({ walletAddress: getConnectedAddress() });
  };

  const loadLeaderboard = async () => {
    setLoadingBoard(true);
    try {
      const board = await readContractJSON("get_engagement_leaderboard", []);
      setLeaderboard(board);
      setShowBoard(true);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoadingBoard(false);
    }
  };

  const facts = profile?.facts;

  return (
    <main className="github-tab">
      <StickerField stickers={GITHUB_STICKERS} />
      <div className="github-card">
        <h1>GenLayer Engagement</h1>
        <p className="github-subtitle">
          Link your GitHub handle and the network checks how deep your GenLayer engagement
          really is — bio mentions, related repos, real contributions — then hands you a
          tier badge.
        </p>

        <div className="handle-row">
          <input
            className="handle-input"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            placeholder={handle ? `Update handle (current: ${handle})` : "your-github-handle"}
            maxLength={39}
          />
          <button className="primary-btn" onClick={handleSaveHandle} disabled={savingHandle}>
            {savingHandle ? "Saving…" : "Save handle"}
          </button>
        </div>
        {handle && <p className="handle-saved">Linked handle: @{handle}</p>}

        <button className="primary-btn" onClick={handleEvaluate} disabled={evaluating || !handle}>
          {evaluating ? (
            <>
              Checking GitHub + scoring<span className="loading-dots"></span>
            </>
          ) : (
            "Check My Engagement ⚡"
          )}
        </button>

        {retryNotice && <p className="progress-note">⚠️ {retryNotice}</p>}

        {evaluating && txStage && (
          <TxProgressBar stage={txStage} elapsedMs={txElapsedMs} onStopWatching={handleStopWatchingEvaluate} />
        )}

        {evaluating && !txStage && (
          <p className="progress-note">
            ⏳ Fetching GitHub<span className="loading-dots"></span>
          </p>
        )}

        {error && <p className="github-error">{error}</p>}

        {profile?.evaluated && (
          <div className="github-result">
            <div className="badge-hex" style={{ "--score": profile.engagement_score }}>
              <div className="badge-hex-inner">
                <span className="score-num">{profile.engagement_score}</span>
                <span className="score-max">/100</span>
              </div>
            </div>
            <div>
              <span className="tier-pill">{profile.tier}</span>
              <ul className="facts-list">
                <li>Bio mentions GenLayer: {facts.bio_mentions_genlayer ? "yes" : "no"}</li>
                <li>GenLayer-related repos: {facts.genlayer_repo_count}</li>
                <li>Original (non-fork) GenLayer repos: {facts.genlayer_original_repo_count}</li>
                <li>Public repos: {facts.public_repos}</li>
              </ul>
              <p className="engagement-summary">{profile.summary}</p>
            </div>
          </div>
        )}

        <button className="secondary-btn" onClick={loadLeaderboard} disabled={loadingBoard}>
          {loadingBoard ? "Loading…" : "🏆 See community leaderboard"}
        </button>

        {showBoard && leaderboard && (
          <ol className="leaderboard">
            {leaderboard.profiles.slice(0, 5).map((p, i) => (
              <li key={i}>
                <strong>{p.username}</strong> (@{p.github_handle}) — {p.score}/100 · {p.tier}
              </li>
            ))}
            {leaderboard.profiles.length === 0 && <li>No profiles checked yet — be the first!</li>}
          </ol>
        )}
      </div>
    </main>
  );
}

/* ============================================================================
 * App shell — wallet connect, username gate, tab switching
 * ==========================================================================*/

export default function App() {
  const [tab, setTab] = useState("neuro");
  const [address, setAddress] = useState(null);
  const [username, setUsername] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [savingUsername, setSavingUsername] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!address) return;
    (async () => {
      try {
        const mine = await readContractJSON("get_my_content_evaluations", []);
        if (mine?.username) setUsername(mine.username);
      } catch (err) {
        console.warn("Could not check existing username:", err);
      }
    })();
  }, [address]);

  const handleConnect = async () => {
    setConnecting(true);
    setError("");
    try {
      const addr = await connectWallet();
      setAddress(addr);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleSetUsername = async () => {
    const trimmed = usernameInput.trim();
    if (trimmed.length < 2) {
      setError("Username must be at least 2 characters.");
      return;
    }
    setError("");
    setSavingUsername(true);
    try {
      await writeContract("set_username", [trimmed], {
        ...QUICK_WAIT_OPTIONS,
        onRetry: (attempt, max) => setError(`Node is busy right now — retrying (${attempt}/${max})…`),
      });
      setError("");
      setUsername(trimmed);
    } catch (err) {
      if (isTimeoutError(err)) {
        setError("Still confirming — checking…");
        const landed = await pollUntilReady(
          () => readContractJSON("get_my_content_evaluations", []),
          (mine) => mine.username === trimmed,
          { attempts: 6, delay: 5000 }
        );
        if (landed) {
          setUsername(trimmed);
          setError("");
        } else {
          setError("Saving the username didn't confirm in time. Please try again.");
        }
      } else {
        setError(err.message || String(err));
      }
    } finally {
      setSavingUsername(false);
    }
  };

  const NETWORKS_SHARING_CHAIN_ID_4221 = ["testnetAsimov", "testnetBradbury"];

  return (
    <div className={`app app--${tab}`}>
      <style>{STYLES}</style>

      <div className="app-main">
        <Header address={address} onConnect={handleConnect} connecting={connecting} />

        <div className="two-col">
          <CodexTV />
          <div className="tab-column">
            <div className="tab-column-inner">
              <TabSwitcher tab={tab} onTabChange={setTab} />

              {address && NETWORKS_SHARING_CHAIN_ID_4221.includes(NETWORK_NAME) && (
                <p className="network-warning">
                  ⚠️ Connected for <strong>{NETWORK_NAME}</strong>. Asimov and Bradbury share the
                  same chain ID (4221) in your wallet — if you've used the other one before, check
                  your wallet's active network/RPC before signing, since your wallet can silently
                  reuse the wrong one.
                </p>
              )}

              {!address && (
                <div className="wallet-gate">
                  <p>Connect your wallet to submit content and GitHub profiles for evaluation.</p>
                </div>
              )}

              {address && !username && (
                <div className="username-gate">
                  <input
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    placeholder="Pick a username (2–30 chars)"
                    maxLength={30}
                  />
                  <button className="primary-btn" onClick={handleSetUsername} disabled={savingUsername}>
                    {savingUsername ? "Saving…" : "Save username"}
                  </button>
                </div>
              )}

              {error && <p className="error-banner">{error}</p>}
            </div>

            {address && username && (
              <>
                <div className="tab-panel" style={{ display: tab === "neuro" ? "block" : "none" }}>
                  <NeuroChallengeTab />
                </div>
                <div className="tab-panel" style={{ display: tab === "github" ? "block" : "none" }}>
                  <GitHubEngagementTab />
                </div>
              </>
            )}
          </div>
        </div>

        <Footer />
        </div>
    </div>
  );
}
