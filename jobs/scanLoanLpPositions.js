// jobs/scanLoanLpPositions.js
const path = require("path");

// Load .env FIRST, before importing anything that may import logger at module load time.
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const Database = require("better-sqlite3");
const { ethers } = require("ethers");

const baseLogger = require("../utils/logger");
const logger = baseLogger.forEnv("SCAN_DEBUG"); // required in .env (fail-fast)

const { acquireLock, releaseLock } = require("../utils/lock");
const { refreshLoanSnapshots } = require("../monitoring/loanMonitor");
const { refreshLpSnapshots } = require("../monitoring/lpMonitor");
const { initSchema } = require("../db");
const troveNftAbi = require("../abi/troveNFT.json");
const troveManagerAbi = require("../abi/troveManager.json");
const sortedTrovesAbi = require("../abi/sortedTroves.json");
const activePoolAbi = require("../abi/activePool.json");

// =========================================================
// ENV VALIDATION (FAIL FAST)
// =========================================================
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    logger.error(`[scanLoanLpPositions] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const DB_PATH = requireEnv("DB_PATH");

const FLR_RPC_URL = requireEnv("FLR_MAINNET_SCAN");
const XDC_RPC_URL = requireEnv("XDC_MAINNET_SCAN");

const FLR_SCAN_BLOCKS = Number(requireEnv("FLR_MAINNET_SCAN_BLOCKS"));
const XDC_SCAN_BLOCKS = Number(requireEnv("XDC_MAINNET_SCAN_BLOCKS"));

const FLR_PAUSE_MS = Number(requireEnv("FLR_MAINNET_SCAN_PAUSE_MS"));
const XDC_PAUSE_MS = Number(requireEnv("XDC_MAINNET_SCAN_PAUSE_MS"));

const OVERLAP_BLOCKS = Number(requireEnv("SCAN_OVERLAP_BLOCKS"));
const REDEMP_DEBT_AHEAD_LOW_PCT = Number(requireEnv("REDEMP_DEBT_AHEAD_LOW_PCT"));
const REDEMP_DEBT_AHEAD_MED_PCT = Number(requireEnv("REDEMP_DEBT_AHEAD_MED_PCT"));
const REDEMP_DEBT_AHEAD_HIGH_PCT = Number(requireEnv("REDEMP_DEBT_AHEAD_HIGH_PCT"));
const REDEMP_SNAPSHOT_MINUTES = Number(requireEnv("REDEMP_SNAPSHOT_MINUTES"));
const REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT = Number(
  requireEnv("REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT")
);
const REDEMP_SNAPSHOT_REQUIRE_LOANS = Number(requireEnv("REDEMP_SNAPSHOT_REQUIRE_LOANS"));
const REDEMP_SNAPSHOT_DEBT_GATE_ENABLED = Number(
  requireEnv("REDEMP_SNAPSHOT_DEBT_GATE_ENABLED")
);
const LP_SNAPSHOT_MINUTES = Number(requireEnv("LP_SNAPSHOT_MINUTES"));

function requirePositiveInt(name, n) {
  if (!Number.isInteger(n) || n <= 0) {
    logger.error(`[scanLoanLpPositions] ${name} must be a positive integer`);
    process.exit(1);
  }
}
function requireNonNegativeInt(name, n) {
  if (!Number.isInteger(n) || n < 0) {
    logger.error(`[scanLoanLpPositions] ${name} must be a non-negative integer`);
    process.exit(1);
  }
}

function requireFiniteNumber(name, n) {
  if (!Number.isFinite(n)) {
    logger.error(`[scanLoanLpPositions] ${name} must be numeric`);
    process.exit(1);
  }
}

requirePositiveInt("FLR_MAINNET_SCAN_BLOCKS", FLR_SCAN_BLOCKS);
requirePositiveInt("XDC_MAINNET_SCAN_BLOCKS", XDC_SCAN_BLOCKS);
requireNonNegativeInt("FLR_MAINNET_SCAN_PAUSE_MS", FLR_PAUSE_MS);
requireNonNegativeInt("XDC_MAINNET_SCAN_PAUSE_MS", XDC_PAUSE_MS);
requireNonNegativeInt("SCAN_OVERLAP_BLOCKS", OVERLAP_BLOCKS);
requireFiniteNumber("REDEMP_DEBT_AHEAD_LOW_PCT", REDEMP_DEBT_AHEAD_LOW_PCT);
requireFiniteNumber("REDEMP_DEBT_AHEAD_MED_PCT", REDEMP_DEBT_AHEAD_MED_PCT);
requireFiniteNumber("REDEMP_DEBT_AHEAD_HIGH_PCT", REDEMP_DEBT_AHEAD_HIGH_PCT);
requireNonNegativeInt("REDEMP_SNAPSHOT_MINUTES", REDEMP_SNAPSHOT_MINUTES);
requireFiniteNumber("REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT", REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT);
requireNonNegativeInt("REDEMP_SNAPSHOT_REQUIRE_LOANS", REDEMP_SNAPSHOT_REQUIRE_LOANS);
requireNonNegativeInt("REDEMP_SNAPSHOT_DEBT_GATE_ENABLED", REDEMP_SNAPSHOT_DEBT_GATE_ENABLED);
requireNonNegativeInt("LP_SNAPSHOT_MINUTES", LP_SNAPSHOT_MINUTES);

if (![0, 1].includes(REDEMP_SNAPSHOT_REQUIRE_LOANS)) {
  logger.error("[scanLoanLpPositions] REDEMP_SNAPSHOT_REQUIRE_LOANS must be 0 or 1");
  process.exit(1);
}
if (![0, 1].includes(REDEMP_SNAPSHOT_DEBT_GATE_ENABLED)) {
  logger.error("[scanLoanLpPositions] REDEMP_SNAPSHOT_DEBT_GATE_ENABLED must be 0 or 1");
  process.exit(1);
}
if (REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT < 0) {
  logger.error("[scanLoanLpPositions] REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT must be >= 0");
  process.exit(1);
}

function parseSqliteUtc(ts) {
  if (!ts) return null;
  const iso = ts.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function minutesSince(ts) {
  const ms = parseSqliteUtc(ts);
  if (!ms) return Infinity;
  return (Date.now() - ms) / 60000;
}

// Output mapping:
// - SCAN_DEBUG=0: errors only
// - SCAN_DEBUG=1: errors + warnings
// - SCAN_DEBUG=2: normal progress
// - SCAN_DEBUG=3: per-window verbose logs
function log(...a) {
  logger.info(...a);
}
function vlog(...a) {
  logger.debug(...a);
}

// =========================================================
// LOCK
// =========================================================
const lockPath = acquireLock("scan-loan-lp-positions");
if (!lockPath) {
  logger.warn("[scanLoanLpPositions] another instance is running, exiting");
  process.exit(0);
}

let lockReleased = false;
function safeReleaseLock() {
  if (lockReleased) return;
  lockReleased = true;
  try {
    releaseLock(lockPath);
  } catch (_) {}
}

process.once("exit", safeReleaseLock);
process.once("SIGINT", () => {
  safeReleaseLock();
  process.exit(130);
});
process.once("SIGTERM", () => {
  safeReleaseLock();
  process.exit(143);
});
process.once("uncaughtException", (err) => {
  logger.error("[scanLoanLpPositions] FATAL (uncaughtException):", err);
  safeReleaseLock();
  process.exit(1);
});
process.once("unhandledRejection", (err) => {
  logger.error("[scanLoanLpPositions] FATAL (unhandledRejection):", err);
  safeReleaseLock();
  process.exit(1);
});

// =========================================================
// CONSTANTS
// =========================================================
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const BURN_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

// =========================================================
// UTILS
// =========================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(err) {
  const msg = String(err?.message || "");
  const m = msg.match(/retry in\s+(\d+)\s*s/i);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

function isRateLimitError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("-32090")
  );
}

async function getLogsWithRetry(provider, filter, { maxAttempts = 6 } = {}) {
  let attempt = 0;
  let backoffMs = 750;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      return { ok: true, logs: await provider.getLogs(filter) };
    } catch (err) {
      const retryAfter = parseRetryAfterMs(err);
      const shouldRetry = isRateLimitError(err) || retryAfter != null;

      logger.warn(
        `      ❌ getLogs failed (attempt ${attempt}/${maxAttempts}): ${err.message}`
      );

      if (!shouldRetry || attempt >= maxAttempts) {
        return { ok: false, error: err };
      }

      await sleep(retryAfter ?? backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10000);
    }
  }

  return { ok: false, error: new Error("exhausted retries") };
}

function providerForChain(chainId) {
  if (chainId === "FLR") return new ethers.JsonRpcProvider(FLR_RPC_URL);
  if (chainId === "XDC") return new ethers.JsonRpcProvider(XDC_RPC_URL);
  throw new Error(`Unsupported chain_id: ${chainId}`);
}

async function initProvider(chainId, { maxAttempts = 3, backoffMs = 1000 } = {}) {
  let attempt = 0;
  let delay = backoffMs;
  while (attempt < maxAttempts) {
    attempt++;
    const provider = providerForChain(chainId);
    try {
      await provider.getNetwork();
      return provider;
    } catch (err) {
      logger.warn(
        `[scanLoanLpPositions] ${chainId} provider init failed (attempt ${attempt}/${maxAttempts}): ${err?.message || err}`
      );
      if (attempt >= maxAttempts) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 10000);
    }
  }
  throw new Error(`Failed to init provider for ${chainId}`);
}

function scanBlocksForChain(chainId) {
  if (chainId === "FLR") return FLR_SCAN_BLOCKS;
  if (chainId === "XDC") return XDC_SCAN_BLOCKS;
  throw new Error(`Unsupported chain_id: ${chainId}`);
}

function pauseMsForChain(chainId) {
  if (chainId === "FLR") return FLR_PAUSE_MS;
  if (chainId === "XDC") return XDC_PAUSE_MS;
  throw new Error(`Unsupported chain_id: ${chainId}`);
}

function addressFromTopic(t) {
  // topic is 32-byte right-padded hex; address is last 20 bytes
  return ethers.getAddress("0x" + t.slice(26));
}
function tokenIdFromTopic(t) {
  return BigInt(t).toString();
}
function isBurn(addrLower) {
  return BURN_ADDRS.has(addrLower);
}

/**
 * FIX #3: Ensure we ALWAYS use a stable, real log index.
 * - ethers v6: lg.index is a number
 * - some RPCs: lg.logIndex can be number or hex string
 * If neither is available, we skip the log to avoid collisions with UNIQUE(contract_id, tx_hash, log_index).
 */
function getStableLogIndex(lg) {
  if (Number.isInteger(lg?.index) && lg.index >= 0) return lg.index;

  const li = lg?.logIndex;
  if (typeof li === "number" && Number.isInteger(li) && li >= 0) return li;

  if (typeof li === "string") {
    const n = li.startsWith("0x")
      ? Number.parseInt(li, 16)
      : Number.parseInt(li, 10);
    if (Number.isInteger(n) && n >= 0) return n;
  }

  return null;
}

// =========================================================
// DB HELPERS
// =========================================================
function selectContracts(db, { chainId, kind, limit }) {
  const sql = `
    SELECT id AS contract_id, chain_id, kind, contract_key, protocol,
           address_eip55, default_start_block
    FROM contracts
    WHERE is_enabled = 1
      ${chainId ? "AND chain_id = ?" : ""}
      ${kind ? "AND kind = ?" : ""}
    ORDER BY chain_id, kind, contract_key
    LIMIT ?
  `;
  const args = [];
  if (chainId) args.push(chainId);
  if (kind) args.push(kind);
  args.push(limit);
  return db.prepare(sql).all(...args);
}

function ensureCursor(db, contractId, startBlock) {
  db.prepare(`
    INSERT INTO contract_scan_cursors (contract_id, start_block, last_scanned_block)
    VALUES (?, ?, 0)
    ON CONFLICT(contract_id) DO NOTHING
  `).run(contractId, startBlock);
}

/**
 * FIX #2: Do NOT set updated_at manually when you have an AFTER UPDATE trigger.
 * Let trg_contract_scan_cursors_updated_at handle updated_at.
 */
function updateCursor(db, contractId, lastBlock) {
  db.prepare(`
    UPDATE contract_scan_cursors
    SET last_scanned_block = ?, last_scanned_at = datetime('now')
    WHERE contract_id = ?
  `).run(lastBlock, contractId);
}

// =========================================================
// REDEMPTION RATE SNAPSHOTS (DB cache for /redemption-rate)
// =========================================================
async function getActivePoolStats(provider, troveManagerAddr) {
  const tm = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const activePoolAddr = await tm.activePool();
  if (!activePoolAddr || activePoolAddr === ethers.ZeroAddress) return null;
  const ap = new ethers.Contract(activePoolAddr, activePoolAbi, provider);
  const sum = await callWithRetry(() => ap.aggWeightedDebtSum(), "activePool.aggWeightedDebtSum");
  const debt = await callWithRetry(() => ap.aggRecordedDebt(), "activePool.aggRecordedDebt");
  const sumNum = Number(ethers.formatUnits(sum, 18));
  const debtNum = Number(ethers.formatUnits(debt, 18));
  if (!Number.isFinite(sumNum) || !Number.isFinite(debtNum) || debtNum <= 0) return null;
  return { avgIrPct: (sumNum / debtNum) * 100.0, totalDebt: debtNum };
}

async function computeTierTargets(provider, troveManagerAddr, totalDebt) {
  const tm = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const sortedAddr = await callWithRetry(() => tm.sortedTroves(), "troveManager.sortedTroves");
  if (!sortedAddr || sortedAddr === ethers.ZeroAddress) return null;

  const sorted = new ethers.Contract(sortedAddr, sortedTrovesAbi, provider);
  const thresholds = [
    { tier: "HIGH", pct: REDEMP_DEBT_AHEAD_HIGH_PCT },
    { tier: "MEDIUM", pct: REDEMP_DEBT_AHEAD_MED_PCT },
    { tier: "LOW", pct: REDEMP_DEBT_AHEAD_LOW_PCT },
  ].sort((a, b) => a.pct - b.pct);

  const targets = {};
  const pctAt = {};
  const irDebts = [];

  let current = await callWithRetry(() => sorted.getLast(), "sortedTroves.getLast");
  let currentId = current != null ? BigInt(current).toString() : "0";
  let cumulativeDebt = 0;
  let idx = 0;
  const maxSteps = 50000;
  let steps = 0;

  while (currentId !== "0") {
    let latest = null;
    let attempt = 0;
    const maxAttempts = 3;
    let lastErr = null;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        latest = await tm.getLatestTroveData(currentId);
        break;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || "");
        const rateLimited = msg.toLowerCase().includes("rate limit") || msg.includes("-32090");
        logger.debug(
          `[scanLoanLpPositions] getLatestTroveData failed (${attempt}/${maxAttempts}) ` +
            `id=${currentId} rateLimited=${rateLimited} msg=${msg}`
        );
        if (attempt >= maxAttempts) break;
        const retryAfter = parseRetryAfterMs(err);
        const baseDelay = rateLimited ? 1200 : 350;
        await sleep(retryAfter ?? baseDelay);
      }
    }
    if (!latest) {
      const msg = String(lastErr?.message || lastErr || "unknown error");
      logger.warn(
        `[scanLoanLpPositions] getLatestTroveData skipped id=${currentId}: ${msg}`
      );
      const prev = await callWithRetry(
        () => sorted.getPrev(currentId),
        "sortedTroves.getPrev",
        { context: `id=${currentId}` }
      );
      const nextId = prev != null ? BigInt(prev).toString() : "0";
      if (nextId === currentId) break;
      currentId = nextId;
      steps += 1;
      if (steps > maxSteps) break;
      if (steps % 25 === 0) {
        await sleep(50);
      }
      continue;
    }

    const debtNorm = Number(ethers.formatUnits(latest.entireDebt, 18));
    if (Number.isFinite(debtNorm)) cumulativeDebt += debtNorm;
    const pctAhead = totalDebt > 0 ? cumulativeDebt / totalDebt : 0;

    const irPct = Number(ethers.formatUnits(latest.annualInterestRate, 18)) * 100.0;
    if (Number.isFinite(irPct) && Number.isFinite(debtNorm) && debtNorm > 0) {
      irDebts.push({ irPct, debt: debtNorm });
    }

    while (idx < thresholds.length && pctAhead >= thresholds[idx].pct) {
      targets[thresholds[idx].tier] = irPct;
      pctAt[thresholds[idx].tier] = pctAhead;
      idx += 1;
    }

    const prev = await callWithRetry(
      () => sorted.getPrev(currentId),
      "sortedTroves.getPrev",
      { context: `id=${currentId}` }
    );
    const nextId = prev != null ? BigInt(prev).toString() : "0";
    if (nextId === currentId) break;
    currentId = nextId;
    steps += 1;
    if (steps > maxSteps) break;
    if (steps % 250 === 0) {
      logger.debug(
        `[scanLoanLpPositions] redemption-rate progress: steps=${steps} ` +
          `cumDebt=${cumulativeDebt.toFixed(2)} pctAhead=${(pctAhead * 100).toFixed(2)}%`
      );
    }
    if (steps % 25 === 0) {
      await sleep(100);
    }
  }

  return { targets, pctAt, irDebts };
}

async function callWithRetry(fn, label, { context = "", maxAttempts = 3, sleepMs = 350 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.shortMessage || err?.message || err);
      const rateLimited = /rate limit|too many requests/i.test(msg) || msg.includes("-32090");
      logger.debug(
        `[scanLoanLpPositions] ${label} failed (${attempt}/${maxAttempts})` +
          (context ? ` ${context}` : "") +
          (rateLimited ? " rateLimited=true" : "") +
          ` msg=${msg}`
      );
      if (attempt < maxAttempts) {
        const retryAfter = parseRetryAfterMs(err);
        const baseDelay = rateLimited ? 1200 : sleepMs;
        await sleep(retryAfter ?? baseDelay);
      }
    }
  }
  throw lastErr;
}

function computeIrRange(irDebts) {
  if (!Array.isArray(irDebts) || !irDebts.length) return null;
  const irs = irDebts.map((r) => r.irPct).filter((v) => Number.isFinite(v));
  if (!irs.length) return null;
  const min = Math.min(...irs);
  const max = Math.max(...irs);

  const sorted = [...irDebts].sort((a, b) => a.irPct - b.irPct);
  const totalDebt = sorted.reduce((sum, r) => sum + r.debt, 0);
  let acc = 0;
  let median = null;
  for (const r of sorted) {
    acc += r.debt;
    if (acc / totalDebt >= 0.5) {
      median = r.irPct;
      break;
    }
  }

  return { min, median, max };
}

function computeBuckets(irDebts, totalDebt) {
  const bucketCount = 10;
  const bucketMin = 0;
  const bucketMax = 25;
  const step = (bucketMax - bucketMin) / bucketCount;
  const buckets = [];
  for (let i = 0; i < bucketCount; i += 1) {
    buckets.push({ min: bucketMin + i * step, max: bucketMin + (i + 1) * step, debt: 0 });
  }
  for (const r of irDebts) {
    const idx = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((r.irPct - bucketMin) / step))
    );
    buckets[idx].debt += r.debt;
  }
  return buckets.map((b) => ({
    min: b.min,
    max: b.max,
    pct: totalDebt > 0 ? (b.debt / totalDebt) * 100 : 0,
  }));
}

async function refreshRedemptionRateSnapshots(db, providers) {
  const loanContracts = selectContracts(db, { chainId: null, kind: "LOAN_NFT", limit: 500 });
  if (!loanContracts.length) return;

  const hasLoanSnapshot = db.prepare(
    `SELECT 1 FROM loan_position_snapshots WHERE contract_id = ? LIMIT 1`
  );
  const hasPendingLoanSnapshot = db.prepare(`
    SELECT 1
    FROM nft_tokens t
    JOIN contracts c ON c.id = t.contract_id
    JOIN user_wallets w ON t.owner_lower = w.address_lower AND w.chain_id = c.chain_id
    LEFT JOIN position_ignores pi
      ON pi.user_id        = w.user_id
     AND pi.position_kind  = 'LOAN'
     AND pi.wallet_id      = w.id
     AND pi.contract_id    = t.contract_id
     AND (pi.token_id IS NULL OR pi.token_id = t.token_id)
    WHERE t.contract_id = ?
      AND t.is_burned = 0
      AND w.is_enabled = 1
      AND c.is_enabled = 1
      AND pi.id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM loan_position_snapshots s
        WHERE s.contract_id = t.contract_id
          AND s.token_id = t.token_id
          AND s.wallet_id = w.id
      )
    LIMIT 1
  `);
  const selectLastSnapshot = db.prepare(
    `SELECT snapshot_at, snapshot_json FROM redemption_rate_snapshots WHERE contract_id = ?`
  );

  const upsert = db.prepare(`
    INSERT INTO redemption_rate_snapshots (
      contract_id, chain_id, protocol, snapshot_at, snapshot_json
    ) VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(contract_id) DO UPDATE SET
      chain_id = excluded.chain_id,
      protocol = excluded.protocol,
      snapshot_at = datetime('now'),
      snapshot_json = excluded.snapshot_json
  `);

  for (const c of loanContracts) {
    if (REDEMP_SNAPSHOT_REQUIRE_LOANS && !hasLoanSnapshot.get(c.contract_id)) {
      logger.debug(
        `[scanLoanLpPositions] redemption-rate skip ${c.protocol}: no loan snapshots`
      );
      continue;
    }

    const pendingLoan = hasPendingLoanSnapshot.get(c.contract_id);
    if (pendingLoan) {
      logger.debug(
        `[scanLoanLpPositions] redemption-rate ${c.protocol} forced refresh: new tracked loan(s) pending snapshot`
      );
    }
    const lastSnapshot = selectLastSnapshot.get(c.contract_id);
    const ageMin = minutesSince(lastSnapshot?.snapshot_at);
    if (!pendingLoan && Number.isFinite(ageMin) && ageMin < REDEMP_SNAPSHOT_MINUTES) {
      logger.debug(
        `[scanLoanLpPositions] redemption-rate skip ${c.protocol}: last snapshot ${ageMin.toFixed(
          1
        )}m ago`
      );
      continue;
    }

    const chainId = c.chain_id;
    const provider = providers[chainId] || (providers[chainId] = await initProvider(chainId));

    let attempt = 0;
    let lastErr = null;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const nft = new ethers.Contract(c.address_eip55, troveNftAbi, provider);
        const troveManagerAddr = await nft.troveManager();

        const poolStats = await getActivePoolStats(provider, troveManagerAddr);
        if (!poolStats) break;

        logger.debug(
          `[scanLoanLpPositions] redemption-rate ${c.protocol} totalDebt=${poolStats.totalDebt.toFixed(
            2
          )} globalIR=${poolStats.avgIrPct.toFixed(4)}`
        );

        if (
          REDEMP_SNAPSHOT_DEBT_GATE_ENABLED &&
          !pendingLoan &&
          lastSnapshot?.snapshot_json &&
          REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT > 0
        ) {
          try {
            const prev = JSON.parse(lastSnapshot.snapshot_json);
            const prevDebt = Number(prev?.totalDebt);
            if (Number.isFinite(prevDebt) && prevDebt > 0) {
              const deltaPct = (Math.abs(poolStats.totalDebt - prevDebt) / prevDebt) * 100;
              if (deltaPct < REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT) {
                logger.debug(
                  `[scanLoanLpPositions] redemption-rate skip ${c.protocol}: debt delta ${deltaPct.toFixed(
                    3
                  )}% < ${REDEMP_SNAPSHOT_MIN_DEBT_DELTA_PCT}%`
                );
                lastErr = null;
                break;
              }
            }
          } catch (err) {
            logger.debug(
              `[scanLoanLpPositions] redemption-rate ${c.protocol} prev snapshot parse failed: ${err?.message || err}`
            );
          }
        }

        const tierData = await computeTierTargets(provider, troveManagerAddr, poolStats.totalDebt);
        if (!tierData) break;

        const range = computeIrRange(tierData.irDebts);
        const buckets = computeBuckets(tierData.irDebts, poolStats.totalDebt);

        const aheadAt = {
          LOW:
            tierData.pctAt.LOW != null ? tierData.pctAt.LOW * poolStats.totalDebt : null,
          MEDIUM:
            tierData.pctAt.MEDIUM != null ? tierData.pctAt.MEDIUM * poolStats.totalDebt : null,
          HIGH:
            tierData.pctAt.HIGH != null ? tierData.pctAt.HIGH * poolStats.totalDebt : null,
        };

        const snapshot = {
          contractId: c.contract_id,
          chainId,
          protocol: c.protocol,
          globalIrPct: poolStats.avgIrPct,
          totalDebt: poolStats.totalDebt,
          targets: tierData.targets,
          aheadAt,
          irRange: range,
          buckets,
        };

    upsert.run(c.contract_id, chainId, c.protocol, JSON.stringify(snapshot));
    logger.info(
      `[scanLoanLpPositions] redemption-rate snapshot saved for ${c.protocol}`
    );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || "");
        const rateLimited = msg.toLowerCase().includes("rate limit") || msg.includes("-32090");
        if (!rateLimited || attempt >= maxAttempts) break;
        const retryAfter = parseRetryAfterMs(err);
        await sleep(retryAfter ?? 1500 * attempt);
      }
    }

    if (lastErr) {
      logger.warn(
        `[scanLoanLpPositions] redemption-rate snapshot failed for ${c.protocol}: ${lastErr?.message || lastErr}`
      );
    }

    // small throttle between contracts to avoid bursts
    await sleep(250);
  }
}

// =========================================================
// SCAN ONE CONTRACT (WITH VERBOSE PROGRESS)
// =========================================================
async function scanContract(db, provider, c) {
  ensureCursor(db, c.contract_id, c.default_start_block);

  const cursor = db
    .prepare(
      `
    SELECT start_block, last_scanned_block
    FROM contract_scan_cursors
    WHERE contract_id = ?
  `
    )
    .get(c.contract_id);

  const startBlock = cursor.start_block;
  const lastScanned = cursor.last_scanned_block;

  log(`\n=== ${c.chain_id} ${c.kind} ${c.contract_key} ===`);
  log(`  start_block=${startBlock} last_scanned=${lastScanned}`);

  const latestBlock = await provider.getBlockNumber();
  log(`  latestBlock=${latestBlock}`);

  let fromBlock =
    lastScanned > 0
      ? Math.max(startBlock, lastScanned - OVERLAP_BLOCKS)
      : startBlock;

  if (fromBlock > latestBlock) {
    log("  ⏭️ nothing to scan");
    return;
  }

  const maxBlocks = scanBlocksForChain(c.chain_id);
  const pauseMs = pauseMsForChain(c.chain_id);
  const totalWindows = Math.ceil((latestBlock - fromBlock + 1) / (maxBlocks + 1));

  vlog(
    `  windows=${totalWindows} window_size=${maxBlocks} overlap=${OVERLAP_BLOCKS} pause=${pauseMs}ms`
  );

  let lastGoodBlock = fromBlock - 1;
  let windowIndex = 0;
  let blocksScanned = 0;

  const addr = ethers.getAddress(c.address_eip55);

  /**
   * FIX #5: Don't swallow insert errors.
   * Use ON CONFLICT DO NOTHING for the expected duplicates from overlap scans.
   * Any other DB error will throw and stop the job (good).
   */
  const insertTransfer = db.prepare(`
    INSERT INTO nft_transfers (
      contract_id, block_number, tx_hash, log_index,
      from_lower, from_eip55, to_lower, to_eip55, token_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_id, tx_hash, log_index) DO NOTHING
  `);

  const upsertToken = db.prepare(`
    INSERT INTO nft_tokens (
      contract_id, token_id,
      owner_lower, owner_eip55,
      is_burned,
      last_block, last_tx_hash, last_log_index,
      first_seen_block, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(contract_id, token_id) DO UPDATE SET
      owner_lower = excluded.owner_lower,
      owner_eip55 = excluded.owner_eip55,
      is_burned   = excluded.is_burned,
      last_block  = excluded.last_block,
      last_tx_hash= excluded.last_tx_hash,
      last_log_index = excluded.last_log_index,
      updated_at = datetime('now')
    WHERE
      nft_tokens.last_block IS NULL
      OR excluded.last_block > nft_tokens.last_block
      OR (
        excluded.last_block = nft_tokens.last_block
        AND excluded.last_log_index > nft_tokens.last_log_index
      )
  `);

  const txApply = db.transaction((events) => {
    for (const e of events) {
      // duplicates are handled by ON CONFLICT DO NOTHING; other DB issues throw (good)
      insertTransfer.run(
        c.contract_id,
        e.blockNumber,
        e.txHash,
        e.logIndex,
        e.fromLower,
        e.fromEip55,
        e.toLower,
        e.toEip55,
        e.tokenId
      );

      // upsert is expected to always succeed; if it doesn't, fail loudly
      upsertToken.run(
        c.contract_id,
        e.tokenId,
        e.toLower,
        e.toEip55,
        e.isBurned ? 1 : 0,
        e.blockNumber,
        e.txHash,
        e.logIndex,
        e.blockNumber
      );
    }
  });

  for (let b = fromBlock; b <= latestBlock; b += maxBlocks + 1) {
    const toBlock = Math.min(b + maxBlocks, latestBlock);
    windowIndex++;
    blocksScanned += toBlock - b + 1;

    vlog(`      [${windowIndex}/${totalWindows}] blocks ${b} → ${toBlock}`);

    const res = await getLogsWithRetry(provider, {
      address: addr,
      fromBlock: b,
      toBlock,
      topics: [TRANSFER_TOPIC],
    });

    if (!res.ok) {
      log(`      🚫 window failed permanently ${b}-${toBlock}`);
      break;
    }

    vlog(`        logs=${res.logs.length}`);

    const events = [];
    let skippedNoIndex = 0;

    for (const lg of res.logs) {
      if (!lg.topics || lg.topics.length < 4) continue;

      const li = getStableLogIndex(lg);
      if (li == null) {
        skippedNoIndex++;
        continue;
      }

      // ethers v6 logs should always include these, but guard anyway
      const txHash = lg.transactionHash;
      if (!txHash) continue;

      const from = addressFromTopic(lg.topics[1]);
      const to = addressFromTopic(lg.topics[2]);

      const toLower = to.toLowerCase();
      events.push({
        blockNumber: lg.blockNumber,
        txHash,
        logIndex: li,
        fromLower: from.toLowerCase(),
        fromEip55: from,
        toLower,
        toEip55: to,
        tokenId: tokenIdFromTopic(lg.topics[3]),
        isBurned: isBurn(toLower),
      });
    }

    if (skippedNoIndex > 0) {
      logger.warn(
        `        ⚠️ skipped ${skippedNoIndex} logs with missing/invalid log index (tx receipt index unavailable)`
      );
    }

    if (events.length) {
      try {
        txApply(events);
      } catch (err) {
        // Make DB failures loud with context
        logger.error(
          `      💥 DB transaction failed for window ${b}-${toBlock} contract=${c.contract_id}: ${err.message}`
        );
        throw err;
      }
    }

    lastGoodBlock = toBlock;

    if (pauseMs > 0) {
      vlog(`        pause ${pauseMs}ms`);
      await sleep(pauseMs);
    }
  }

  if (lastGoodBlock >= fromBlock) {
    updateCursor(db, c.contract_id, lastGoodBlock);
    log(`  ✅ advanced cursor to ${lastGoodBlock} (scanned ${blocksScanned} blocks)`);
  } else {
    log("  ⏭️ cursor NOT advanced");
  }
}

// =========================================================
// MAIN
// =========================================================
async function main() {
  const args = process.argv.slice(2);
  const chain = args.find((a) => a.startsWith("--chain="))?.split("=")[1];
  const kind = args.find((a) => a.startsWith("--kind="))?.split("=")[1];

  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    logger.error("[scanLoanLpPositions] --limit must be a positive integer");
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  initSchema(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  try {
    const contracts = selectContracts(db, {
      chainId: chain ? chain.toUpperCase() : null,
      kind: kind ? kind.toUpperCase() : null,
      limit: limit ?? 200,
    });

    if (!contracts.length) {
      log("[scanLoanLpPositions] no contracts found");
      return;
    }

    const providers = {};
    for (const c of contracts) {
      if (!providers[c.chain_id]) {
        providers[c.chain_id] = await initProvider(c.chain_id);
      }
      await scanContract(db, providers[c.chain_id], c);
    }

    log("\n[scanLoanLpPositions] DONE");
    log("[scanLoanLpPositions] Refreshing cached snapshots...");
    await refreshLoanSnapshots();

    let lpAgeMin = Infinity;
    const lpAgeRow = db
      .prepare(`SELECT MAX(snapshot_at) AS snapshot_at FROM lp_position_snapshots`)
      .get();
    if (lpAgeRow?.snapshot_at) {
      lpAgeMin = minutesSince(lpAgeRow.snapshot_at);
    }
    const hasPendingLpSnapshot = db.prepare(`
      SELECT 1
      FROM nft_tokens t
      JOIN contracts c ON c.id = t.contract_id
      JOIN user_wallets w ON t.owner_lower = w.address_lower AND w.chain_id = c.chain_id
      LEFT JOIN position_ignores pi
        ON pi.user_id        = w.user_id
       AND pi.position_kind  = 'LP'
       AND pi.wallet_id      = w.id
       AND pi.contract_id    = t.contract_id
       AND (pi.token_id IS NULL OR pi.token_id = t.token_id)
      WHERE c.kind = 'LP_NFT'
        AND t.is_burned = 0
        AND w.is_enabled = 1
        AND c.is_enabled = 1
        AND pi.id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM lp_position_snapshots s
          WHERE s.contract_id = t.contract_id
            AND s.token_id = t.token_id
            AND s.wallet_id = w.id
        )
      LIMIT 1
    `).get();

    if (!hasPendingLpSnapshot && Number.isFinite(lpAgeMin) && lpAgeMin < LP_SNAPSHOT_MINUTES) {
      logger.debug(
        `[scanLoanLpPositions] LP snapshot refresh skipped: last snapshot ${lpAgeMin.toFixed(
          1
        )}m ago`
      );
    } else {
      if (hasPendingLpSnapshot) {
        logger.debug(
          "[scanLoanLpPositions] LP snapshot refresh forced: new tracked LP(s) pending snapshot"
        );
      }
      await refreshLpSnapshots();
    }

    log("[scanLoanLpPositions] Refreshing redemption-rate snapshots...");
    await refreshRedemptionRateSnapshots(db, providers);
    log("[scanLoanLpPositions] Snapshot refresh complete.");
  } finally {
    db.close();
  }
}

main()
  .catch((err) => {
    logger.error("[scanLoanLpPositions] FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    safeReleaseLock();
  });
