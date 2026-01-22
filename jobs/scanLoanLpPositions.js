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

requirePositiveInt("FLR_MAINNET_SCAN_BLOCKS", FLR_SCAN_BLOCKS);
requirePositiveInt("XDC_MAINNET_SCAN_BLOCKS", XDC_SCAN_BLOCKS);
requireNonNegativeInt("FLR_MAINNET_SCAN_PAUSE_MS", FLR_PAUSE_MS);
requireNonNegativeInt("XDC_MAINNET_SCAN_PAUSE_MS", XDC_PAUSE_MS);
requireNonNegativeInt("SCAN_OVERLAP_BLOCKS", OVERLAP_BLOCKS);

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
      providers[c.chain_id] ||= providerForChain(c.chain_id);
      await scanContract(db, providers[c.chain_id], c);
    }

    log("\n[scanLoanLpPositions] DONE");
  } finally {
    db.close();
  }
}

main()
  .catch((err) => {
    logger.error("[scanLoanLpPositions] FATAL:", err);
    process.exit(1);
  })
  .finally(() => {
    releaseLock(lockPath);
  });
