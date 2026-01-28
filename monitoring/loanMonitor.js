// monitoring/loanMonitor.js
//
// DB-driven loans monitor (NEW SCHEMA, v2):
// - Ownership via nft_tokens (current owner index)
// - Identity via (user_id, wallet_id, contract_id, token_id)
// - Ignores via position_ignores (token_id NULL or exact match) + position_kind='LOAN'
// - Alerts via alertEngine (state persisted in alert_state.state_json)
// - Summaries via getLoanSummaries() (read-only) for /my-loans + heartbeat
//
// Strict env: fail if missing (as in your v2)

const { ethers } = require("ethers");
const https = require("https");

const troveNftAbi = require("../abi/troveNFT.json");
const troveManagerAbi = require("../abi/troveManager.json");
const priceFeedAbi = require("../abi/priceFeed.json");
const erc20MetadataAbi = require("../abi/erc20Metadata.json");
const uniswapV3PoolAbi = require("../abi/uniswapV3Pool.json");
const sortedTrovesAbi = require("../abi/sortedTroves.json");
const activePoolAbi = require("../abi/activePool.json");

const { getDb } = require("../db");
const { getProviderForChain } = require("../utils/ethers/providers");
const { handleLiquidationAlert, handleRedemptionAlert } = require("./alertEngine");
const {
  applyGlobalIrOffset,
  applyPriceMultiplier,
  applyDebtAheadOffsetPct,
  setDebtAheadBase,
  setDebtAheadTierThresholds,
  logRunApplied,
  getTestOffsets,
} = require("./testOffsets");
const logger = require("../utils/logger");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");

// -----------------------------
// Chains
// -----------------------------
const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
  XDC: { rpcEnvKey: "XDC_MAINNET" },
};

// -----------------------------
// Env helpers (strict like v2)
// -----------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}
function requireNumberEnv(name) {
  const raw = requireEnv(name);
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return v;
}

// -----------------------------
// Config (strict)
// -----------------------------
const LIQ_BUFFER_WARN = requireNumberEnv("LIQ_BUFFER_WARN");
const LIQ_BUFFER_HIGH = requireNumberEnv("LIQ_BUFFER_HIGH");
const LIQ_BUFFER_CRIT = requireNumberEnv("LIQ_BUFFER_CRIT");

const REDEMP_BELOW_CRITICAL = requireNumberEnv("REDEMP_BELOW_CRITICAL");
const REDEMP_ABOVE_MED = requireNumberEnv("REDEMP_ABOVE_MED");
const REDEMP_DEBT_AHEAD_LOW_PCT = requireNumberEnv("REDEMP_DEBT_AHEAD_LOW_PCT");
const REDEMP_DEBT_AHEAD_MED_PCT = requireNumberEnv("REDEMP_DEBT_AHEAD_MED_PCT");
const REDEMP_DEBT_AHEAD_HIGH_PCT = requireNumberEnv("REDEMP_DEBT_AHEAD_HIGH_PCT");

const CDP_REDEMPTION_TRIGGER = requireNumberEnv("CDP_REDEMPTION_TRIGGER");

const CDP_PRICE_MODE = requireEnv("CDP_PRICE_MODE").toUpperCase();
if (!["POOL", "ENV"].includes(CDP_PRICE_MODE)) {
  throw new Error(`CDP_PRICE_MODE must be POOL or ENV (got ${CDP_PRICE_MODE})`);
}
const CDP_POOL_ADDR_FLR = CDP_PRICE_MODE === "POOL" ? requireEnv("CDP_POOL_ADDR_FLR") : null;
const CDP_PRICE_USD_ENV = CDP_PRICE_MODE === "ENV" ? requireNumberEnv("CDP_PRICE_USD") : null;

const GLOBAL_IR_URL = requireEnv("GLOBAL_IR_URL");
const GLOBAL_IR_BRANCHES = requireEnv("GLOBAL_IR_BRANCHES")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LIQ_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];
const REDEMP_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];

setDebtAheadTierThresholds(
  REDEMP_DEBT_AHEAD_LOW_PCT,
  REDEMP_DEBT_AHEAD_MED_PCT,
  REDEMP_DEBT_AHEAD_HIGH_PCT
);


// -----------------------------
// Helpers
// -----------------------------
function isTierAtLeast(tier, minTier, order) {
  const t = (tier || "UNKNOWN").toUpperCase();
  const m = (minTier || "UNKNOWN").toUpperCase();
  const idx = order.indexOf(t);
  const minIdx = order.indexOf(m);
  if (idx === -1 || minIdx === -1) return false;
  return idx >= minIdx;
}

function troveStatusToString(code) {
  return {
    1: "ACTIVE",
    2: "CLOSED_BY_OWNER",
    3: "CLOSED_BY_LIQUIDATION",
    4: "CLOSED_BY_REDEMPTION",
  }[Number(code)] || `UNKNOWN(${code})`;
}

// v1 behavior (best): try fetchPrice -> lastGoodPrice -> fetchRedemptionPrice
async function getOraclePrice(priceFeedContract) {
  try {
    const [price, isValid] = await priceFeedContract.fetchPrice();
    if (isValid && price && price.toString() !== "0") {
      return { rawPrice: price, source: "fetchPrice()" };
    }
  } catch (_) {}

  try {
    const last = await priceFeedContract.lastGoodPrice();
    if (last && last.toString() !== "0") {
      return { rawPrice: last, source: "lastGoodPrice()" };
    }
  } catch (_) {}

  try {
    const [redPrice, isValidRed] = await priceFeedContract.fetchRedemptionPrice();
    if (isValidRed && redPrice && redPrice.toString() !== "0") {
      return { rawPrice: redPrice, source: "fetchRedemptionPrice()" };
    }
  } catch (_) {}

  return { rawPrice: null, source: null };
}

// -----------------------------
// Global IR (FIXED: numeric-string tolerant + cache)
// -----------------------------
function fetchJsonHttps(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { accept: "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} when fetching ${url}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e?.message || e}`));
          }
        });
      }
    );
    req.on("error", reject);
  });
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Returns map of { BRANCHKEY: pctNumber } where pctNumber is percent points (e.g., 6.03)
 * - Logs HTTP/JSON failures
 * - Keeps a short in-memory cache so transient fetch issues don't null out alerts
 */
let _globalIrCache = { atMs: 0, map: null };
const GLOBAL_IR_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchGlobalIrPctMap() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is not available (need Node 18+ or a fetch polyfill).");
  }

  const now = Date.now();
  if (_globalIrCache.map && now - _globalIrCache.atMs < GLOBAL_IR_TTL_MS) {
    logger.debug(`[loanMonitor] Global IR map cache hit: ${JSON.stringify(_globalIrCache.map)}`);
    return _globalIrCache.map;
  }

  let res;
  try {
    res = await fetch(GLOBAL_IR_URL, { headers: { accept: "application/json" } });
  } catch (e) {
    logger.warn(`[loanMonitor] Global IR fetch failed (network): ${e?.message || e}`);
    return _globalIrCache.map || null;
  }

  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch (_) {}
    const bodyShort = body ? String(body).slice(0, 200) : "";
    logger.warn(
      `[loanMonitor] Global IR fetch failed (HTTP ${res.status}). Body: ${bodyShort || "(empty)"}`
    );
    return _globalIrCache.map || null;
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    logger.warn(`[loanMonitor] Global IR fetch failed (bad JSON): ${e?.message || e}`);
    return _globalIrCache.map || null;
  }

  const out = {};
  for (const k of GLOBAL_IR_BRANCHES) {
    const raw = json?.branch?.[k]?.interest_rate_avg;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out[String(k).toUpperCase()] = n * 100.0;
  }

  logger.debug(
    `[loanMonitor] Global IR map fetched: ${Object.keys(out).length ? JSON.stringify(out) : "(empty)"}`
  );

  _globalIrCache = { atMs: Date.now(), map: out };
  return out;
}

function inferBranchKeyFromProtocol(protocol) {
  const p = (protocol || "").toUpperCase();
  if (p.includes("FXRP")) return "FXRP";
  if (p.includes("WFLR")) return "WFLR";
  return null;
}

function getGlobalInterestRatePctFromMap(protocol, globalIrMap) {
  if (!globalIrMap) return null;
  const branchKey = inferBranchKeyFromProtocol(protocol);
  if (!branchKey) return null;
  const v = globalIrMap[branchKey];
  const out = typeof v === "number" && Number.isFinite(v) ? v : null;
  return applyGlobalIrOffset(out, protocol);
}

// -----------------------------
// Tier classifiers
// -----------------------------
function classifyRedemptionTier(interestPct, globalPct) {
  if (globalPct == null) return { tier: "UNKNOWN", diffPct: null };

  const diff = interestPct - globalPct;

  let tier;
  if (diff <= REDEMP_BELOW_CRITICAL) tier = "CRITICAL";
  else if (diff <= 0) tier = "HIGH";
  else if (diff <= REDEMP_ABOVE_MED) tier = "MEDIUM";
  else tier = "LOW";

  return { tier, diffPct: diff };
}

function classifyRedemptionTierByDebtAhead(debtAheadPct) {
  if (debtAheadPct == null || !Number.isFinite(debtAheadPct)) {
    return { tier: "UNKNOWN", debtAheadPct: null };
  }
  if (debtAheadPct >= REDEMP_DEBT_AHEAD_LOW_PCT) {
    return { tier: "LOW", debtAheadPct };
  }
  if (debtAheadPct >= REDEMP_DEBT_AHEAD_MED_PCT) {
    return { tier: "MEDIUM", debtAheadPct };
  }
  if (debtAheadPct >= REDEMP_DEBT_AHEAD_HIGH_PCT) {
    return { tier: "HIGH", debtAheadPct };
  }
  return { tier: "CRITICAL", debtAheadPct };
}

function classifyLiquidationRisk(bufferFrac) {
  if (bufferFrac == null || !Number.isFinite(bufferFrac)) return { tier: "UNKNOWN" };
  if (bufferFrac <= LIQ_BUFFER_CRIT) return { tier: "CRITICAL" };
  if (bufferFrac <= LIQ_BUFFER_HIGH) return { tier: "HIGH" };
  if (bufferFrac <= LIQ_BUFFER_WARN) return { tier: "MEDIUM" };
  return { tier: "LOW" };
}

async function getActivePoolStats(provider, troveManagerAddr) {
  const tm = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const activePoolAddr = await tm.activePool();
  if (!activePoolAddr || activePoolAddr === ethers.ZeroAddress) return null;
  const ap = new ethers.Contract(activePoolAddr, activePoolAbi, provider);
  const [sum, debt] = await Promise.all([ap.aggWeightedDebtSum(), ap.aggRecordedDebt()]);
  const sumNum = Number(ethers.formatUnits(sum, 18));
  const debtNum = Number(ethers.formatUnits(debt, 18));
  if (!Number.isFinite(sumNum) || !Number.isFinite(debtNum) || debtNum <= 0) return null;
  return { avgIrPct: (sumNum / debtNum) * 100.0, totalDebt: debtNum };
}

async function computeDebtInFront(provider, troveManagerAddr, troveId) {
  const tm = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const sortedAddr = await tm.sortedTroves();
  if (!sortedAddr || sortedAddr === ethers.ZeroAddress) return null;

  const sorted = new ethers.Contract(sortedAddr, sortedTrovesAbi, provider);
  const target = BigInt(troveId).toString();

  const first = await sorted.getFirst();
  const last = await sorted.getLast();
  const firstId = first != null ? BigInt(first).toString() : "0";
  const lastId = last != null ? BigInt(last).toString() : "0";

  const fetchIrPct = async (id) => {
    if (!id || id === "0") return null;
    try {
      const latest = await tm.getLatestTroveData(id);
      return Number(ethers.formatUnits(latest.annualInterestRate, 18)) * 100.0;
    } catch (_) {
      return null;
    }
  };
  const [firstIr, lastIr] = await Promise.all([fetchIrPct(firstId), fetchIrPct(lastId)]);

  let current = await sorted.getLast();
  let currentId = current != null ? BigInt(current).toString() : "0";
  let totalDebt = 0;
  let count = 0;
  const maxSteps = 50000;

  while (currentId !== "0" && currentId !== target) {
    const latest = await tm.getLatestTroveData(currentId);
    const debtNorm = Number(ethers.formatUnits(latest.entireDebt, 18));
    if (Number.isFinite(debtNorm)) totalDebt += debtNorm;

    const prev = await sorted.getPrev(currentId);
    const nextId = prev != null ? BigInt(prev).toString() : "0";
    if (nextId === currentId) break;

    currentId = nextId;
    count += 1;
    if (count > maxSteps) break;
  }

  return {
    debtInFront: totalDebt,
    trovesAhead: count,
    found: currentId === target,
    firstId,
    lastId,
    firstIr,
    lastIr,
  };
}

// -----------------------------
// CDP price/state (v1-compatible helpers; strict env remains v2)
// -----------------------------
function getCdpPriceFromEnv() {
  if (CDP_PRICE_MODE !== "ENV") return null;
  return CDP_PRICE_USD_ENV;
}

async function getCdpPriceFromPool(provider) {
  if (CDP_PRICE_MODE !== "POOL") return null;

  if (!provider) {
    throw new Error("CDP price mode=POOL requires an FLR provider");
  }

  const pool = new ethers.Contract(CDP_POOL_ADDR_FLR, uniswapV3PoolAbi, provider);
  const [token0, token1, slot0] = await Promise.all([pool.token0(), pool.token1(), pool.slot0()]);

  const rawTick = slot0.tick !== undefined ? slot0.tick : slot0[1];
  const tick = Number(rawTick);
  if (!Number.isFinite(tick)) throw new Error(`Invalid tick from pool slot0: ${rawTick}`);

  const token0Contract = new ethers.Contract(token0, erc20MetadataAbi, provider);
  const token1Contract = new ethers.Contract(token1, erc20MetadataAbi, provider);

  const [sym0, sym1, dec0, dec1] = await Promise.all([
    token0Contract.symbol(),
    token1Contract.symbol(),
    token0Contract.decimals(),
    token1Contract.decimals(),
  ]);

  const sym0U = String(sym0 || "").toUpperCase();
  const sym1U = String(sym1 || "").toUpperCase();

  const price1Over0NoDecimals = Math.pow(1.0001, tick);
  const decimalFactor = Math.pow(10, Number(dec0) - Number(dec1));
  const price1Over0 = price1Over0NoDecimals * decimalFactor;

  let priceCdpUsd = null;

  if (sym0U.includes("CDP")) {
    priceCdpUsd = price1Over0;
  } else if (sym1U.includes("CDP")) {
    if (price1Over0 === 0) throw new Error("price1Over0 is zero; cannot invert");
    priceCdpUsd = 1 / price1Over0;
  } else {
    throw new Error(`Could not identify CDP token by symbol (token0=${sym0}, token1=${sym1})`);
  }

  if (!Number.isFinite(priceCdpUsd) || priceCdpUsd <= 0) {
    throw new Error(`Computed non-finite/negative CDP price: ${priceCdpUsd}`);
  }

  return priceCdpUsd;
}

async function getCdpPrice(providerFLR = null) {
  if (CDP_PRICE_MODE === "ENV") return getCdpPriceFromEnv();

  const provider = providerFLR || getProviderForChain("FLR", CHAINS_CONFIG);
  return getCdpPriceFromPool(provider);
}

function classifyCdpRedemptionState(cdpPrice) {
  const trigger = CDP_REDEMPTION_TRIGGER;

  if (cdpPrice == null) {
    return { state: "UNKNOWN", trigger, diff: null, label: "no CDP price available" };
  }

  const diff = cdpPrice - trigger;
  const state = cdpPrice < trigger ? "ACTIVE" : "DORMANT";
  const label =
    diff >= 0
      ? `above trigger by ${diff.toFixed(4)}`
      : `below trigger by ${Math.abs(diff).toFixed(4)}`;

  return { state, trigger, diff, label };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return n;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function getDebtAheadSnapshot({ userId, walletId, contractId, troveId }) {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT snapshot_json, snapshot_at
      FROM loan_position_snapshots
      WHERE user_id = ?
        AND wallet_id = ?
        AND contract_id = ?
        AND token_id = ?
      `
    )
    .get(userId, walletId, contractId, String(troveId));
  if (!row?.snapshot_json) return null;
  try {
    return { ...JSON.parse(row.snapshot_json), snapshotAt: row.snapshot_at };
  } catch (_) {
    return null;
  }
}

// -----------------------------
// DB rows (v2 schema)
// -----------------------------
function getMonitoredLoanRows(userId = null) {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT
      u.id              AS userId,
      uw.id             AS walletId,
      c.id              AS contractId,
      c.chain_id        AS chainId,
      c.protocol        AS protocol,
      uw.address_eip55  AS owner,
      uw.address_lower  AS ownerLower,
      uw.label          AS walletLabel,
      c.address_eip55   AS contract,
      nt.token_id       AS troveId
    FROM user_wallets uw
    JOIN users u ON u.id = uw.user_id
    JOIN contracts c
      ON c.chain_id = uw.chain_id
     AND c.kind = 'LOAN_NFT'
     AND c.is_enabled = 1
    JOIN nft_tokens nt
      ON nt.contract_id = c.id
     AND nt.owner_lower = uw.address_lower
     AND nt.is_burned = 0
    LEFT JOIN position_ignores pi
      ON pi.user_id = u.id
     AND pi.wallet_id = uw.id
     AND pi.contract_id = c.id
     AND pi.position_kind = 'LOAN'
     AND (pi.token_id IS NULL OR pi.token_id = nt.token_id)
    WHERE
      uw.is_enabled = 1
      AND (? IS NULL OR u.id = ?)
      AND pi.id IS NULL
    ORDER BY c.chain_id, c.protocol, uw.address_eip55, nt.token_id
  `
    )
    .all(userId, userId);
}

let _loanSnapshotStmt = null;
function upsertLoanSnapshot(snapshot, runId) {
  if (!runId || !snapshot) return;
  const db = getDb();
  if (!_loanSnapshotStmt) {
    _loanSnapshotStmt = db.prepare(`
      INSERT INTO loan_position_snapshots (
        user_id, wallet_id, contract_id, token_id,
        chain_id, protocol, wallet_label,
        snapshot_run_id, snapshot_at, snapshot_json
      )
      VALUES (
        @user_id, @wallet_id, @contract_id, @token_id,
        @chain_id, @protocol, @wallet_label,
        @snapshot_run_id, datetime('now'), @snapshot_json
      )
      ON CONFLICT(user_id, wallet_id, contract_id, token_id) DO UPDATE SET
        chain_id = excluded.chain_id,
        protocol = excluded.protocol,
        wallet_label = excluded.wallet_label,
        snapshot_run_id = excluded.snapshot_run_id,
        snapshot_at = datetime('now'),
        snapshot_json = excluded.snapshot_json
    `);
  }

  _loanSnapshotStmt.run({
    user_id: snapshot.userId,
    wallet_id: snapshot.walletId,
    contract_id: snapshot.contractId,
    token_id: snapshot.troveId,
    chain_id: snapshot.chainId,
    protocol: snapshot.protocol,
    wallet_label: snapshot.walletLabel || null,
    snapshot_run_id: runId,
    snapshot_json: JSON.stringify(snapshot),
  });
}

function cleanupLoanSnapshots(runId) {
  if (!runId) return;
  const db = getDb();
  db.prepare(
    `DELETE FROM loan_position_snapshots WHERE snapshot_run_id != ?`
  ).run(runId);
}

// -----------------------------
// Summary builder (no logging, for /my-loans and heartbeat)
// -----------------------------
async function summarizeLoanPosition(provider, chainId, protocol, row, globalIrMap) {
  const { userId, walletId, contractId, contract, owner, troveId, walletLabel } = row;

  const troveNFT = new ethers.Contract(contract, troveNftAbi, provider);

  const [troveManagerAddr, collTokenAddr] = await Promise.all([
    troveNFT.troveManager(),
    troveNFT.collToken(),
  ]);

  const troveManager = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const collToken = new ethers.Contract(collTokenAddr, erc20MetadataAbi, provider);

  let collDecimals = 18;
  let collSymbol = "";
  try {
    [collDecimals, collSymbol] = await Promise.all([
      collToken.decimals().catch(() => 18),
      collToken.symbol().catch(() => ""),
    ]);
  } catch (_) {}

  const [latest, statusCode] = await Promise.all([
    troveManager.getLatestTroveData(troveId),
    troveManager.getTroveStatus(troveId),
  ]);

  const debtNorm = Number(ethers.formatUnits(latest.entireDebt, 18));
  const collNorm = Number(ethers.formatUnits(latest.entireColl, collDecimals));
  const interestPct = Number(ethers.formatUnits(latest.annualInterestRate, 18)) * 100.0;
  const lastInterestRateAdjTime = Number(latest.lastInterestRateAdjTime);

  const statusStr = troveStatusToString(statusCode);

  const globalIrPct = getGlobalInterestRatePctFromMap(protocol, globalIrMap);
  const redClass = classifyRedemptionTier(interestPct, globalIrPct);

  const base = {
    userId,
    walletId,
    contractId,

    protocol,
    chainId,
    owner,
    walletLabel,
    troveId: String(troveId),
    nftContract: contract,

    collToken: collTokenAddr,
    collSymbol,
    collAmount: collNorm,
    debtAmount: debtNorm,

    interestPct,
    globalIrPct,
    redemptionTier: redClass.tier,
    redemptionDiffPct: redClass.diffPct,
    lastInterestRateAdjTime,

    status: statusStr,

    priceSource: null,
    hasPrice: false,
    price: null,
    ltv: null,
    ltvPct: null,
    liquidationPrice: null,
    liquidationBufferFrac: null,
    liquidationTier: "UNKNOWN",
    mcr: null,
    icr: null,
  };

  const priceFeedAddr = await troveManager.priceFeed();
  const priceFeed = new ethers.Contract(priceFeedAddr, priceFeedAbi, provider);
  const { rawPrice, source } = await getOraclePrice(priceFeed);

  if (!rawPrice) return base;

  const priceNormRaw = Number(ethers.formatUnits(rawPrice, 18));
  const priceNorm = applyPriceMultiplier(priceNormRaw, protocol);
  const mcrNorm = Number(ethers.formatUnits(await troveManager.MCR(), 18));

  const collValue = collNorm * priceNorm;
  const ltv = collValue > 0 ? debtNorm / collValue : 0;
  const liquidationPrice = collNorm > 0 ? (debtNorm * mcrNorm) / collNorm : 0;

  let icrNorm = null;
  try {
    const icrRaw = await troveManager.getCurrentICR(troveId, rawPrice);
    icrNorm = icrRaw != null ? Number(ethers.formatUnits(icrRaw, 18)) : null;
  } catch (_) {}

  const bufferFrac = priceNorm > 0 ? (priceNorm - liquidationPrice) / priceNorm : null;
  const liqClass = classifyLiquidationRisk(bufferFrac);

  return {
    ...base,
    priceSource: source || null,
    hasPrice: true,
    price: priceNorm,
    ltv,
    ltvPct: ltv * 100,
    liquidationPrice,
    liquidationBufferFrac: bufferFrac,
    liquidationTier: liqClass.tier,
    mcr: mcrNorm,
    icr: icrNorm,
  };
}

// -----------------------------
// Core loan description -> alerts (v2 ids)
// -----------------------------
async function describeLoanPosition(
  provider,
  chainId,
  protocol,
  row,
  { cdpState, globalIrMap }
) {
  const { userId, walletId, contractId, contract, owner, troveId, walletLabel } = row;

  const troveNFT = new ethers.Contract(contract, troveNftAbi, provider);

  const [troveManagerAddr, collTokenAddr] = await Promise.all([
    troveNFT.troveManager(),
    troveNFT.collToken(),
  ]);

  const troveManager = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const collToken = new ethers.Contract(collTokenAddr, erc20MetadataAbi, provider);

  const [collDecimals, collSymbol, latest, statusCode] = await Promise.all([
    collToken.decimals(),
    collToken.symbol().catch(() => ""),
    troveManager.getLatestTroveData(troveId),
    troveManager.getTroveStatus(troveId),
  ]);

  const debtNorm = Number(ethers.formatUnits(latest.entireDebt, 18));
  const collNorm = Number(ethers.formatUnits(latest.entireColl, collDecimals));
  const interestPct = Number(ethers.formatUnits(latest.annualInterestRate, 18)) * 100.0;

  const statusStr = troveStatusToString(statusCode);

  const globalIrPct = getGlobalInterestRatePctFromMap(protocol, globalIrMap);
  const redClass = classifyRedemptionTier(interestPct, globalIrPct);

  const priceFeedAddr = await troveManager.priceFeed();
  const priceFeed = new ethers.Contract(priceFeedAddr, priceFeedAbi, provider);
  const { rawPrice, source } = await getOraclePrice(priceFeed);
  if (!rawPrice) return;

  const priceNormRaw = Number(ethers.formatUnits(rawPrice, 18));
  const priceNorm = applyPriceMultiplier(priceNormRaw, protocol);
  const mcrNorm = Number(ethers.formatUnits(await troveManager.MCR(), 18));

  const collValue = collNorm * priceNorm;
  const ltv = collValue > 0 ? debtNorm / collValue : 0;
  const ltvPct = ltv * 100;

  const liquidationPrice = collNorm > 0 ? (debtNorm * mcrNorm) / collNorm : null;
  const bufferFrac =
    priceNorm > 0 && liquidationPrice != null ? (priceNorm - liquidationPrice) / priceNorm : null;

  const liqClass = classifyLiquidationRisk(bufferFrac);

  const debtSnap = getDebtAheadSnapshot({ userId, walletId, contractId, troveId });
  const snapshotAt = debtSnap?.snapshotAt || null;

  // Liquidation alert (DB-stable identity)
  const liqTierFinal = liqClass.tier;
  const liqIsActiveFinal = liqTierFinal !== "UNKNOWN";

  await handleLiquidationAlert({
    userId,
    walletId,
    contractId,
    positionId: String(troveId),

    protocol,
    wallet: owner,
    walletLabel,
    walletAddress: owner,
    chainId,

    isActive: liqIsActiveFinal,
    tier: liqTierFinal,
    ltvPct,
    liquidationPrice,
    currentPrice: priceNorm,
    liquidationBufferFrac: bufferFrac,
    status: statusStr,
    snapshotAt,
  });

  // Redemption alert no longer gated by CDP active state
  const cdpIsActive = cdpState && cdpState.state === "ACTIVE";

  let debtAheadPct =
    typeof debtSnap?.redemptionDebtAheadPct === "number" &&
    Number.isFinite(debtSnap.redemptionDebtAheadPct)
      ? debtSnap.redemptionDebtAheadPct
      : null;
  const debtTotal =
    typeof debtSnap?.redemptionTotalDebt === "number" && Number.isFinite(debtSnap.redemptionTotalDebt)
      ? debtSnap.redemptionTotalDebt
      : null;
  const debtOffsetPp = getTestOffsets().debtAheadOffsetPp || 0;
  const debtOffsetByProtocol = getTestOffsets().debtAheadOffsetByProtocol || {};
  const protocolOffsetPp =
    typeof debtOffsetByProtocol?.[String(protocol || "").toUpperCase()] === "number"
      ? debtOffsetByProtocol[String(protocol || "").toUpperCase()]
      : 0;
  const totalOffsetPp = debtOffsetPp + protocolOffsetPp;
  if (debtAheadPct != null && Number.isFinite(totalOffsetPp) && totalOffsetPp !== 0) {
    debtAheadPct = clamp01(debtAheadPct + totalOffsetPp / 100);
  }
  const redDebtClass = classifyRedemptionTierByDebtAhead(debtAheadPct);
  const redTierFinal = redDebtClass.tier;
  const redIsActiveFinal = debtAheadPct != null;

  const debtAhead =
    debtAheadPct != null && debtTotal != null
      ? debtAheadPct * debtTotal
      : typeof debtSnap?.redemptionDebtAhead === "number" && Number.isFinite(debtSnap.redemptionDebtAhead)
        ? debtSnap.redemptionDebtAhead
        : null;
  const loanIR =
    typeof debtSnap?.interestPct === "number" && Number.isFinite(debtSnap.interestPct)
      ? debtSnap.interestPct
      : null;
  const globalIR =
    typeof debtSnap?.globalIrPct === "number" && Number.isFinite(debtSnap.globalIrPct)
      ? debtSnap.globalIrPct
      : null;

  await handleRedemptionAlert({
    userId,
    walletId,
    contractId,
    positionId: String(troveId),

    protocol,
    wallet: owner,
    walletLabel,
    walletAddress: owner,
    chainId,

    isActive: redIsActiveFinal,
    tier: redTierFinal,
    debtAheadPct,
    debtAhead,
    debtTotal,
    loanIR,
    globalIR,
    snapshotAt,
    isCDPActive: cdpIsActive,
    status: statusStr,
  });

}

// -----------------------------
// Public API: monitorLoans
// -----------------------------
async function monitorLoans() {
  const rows = getMonitoredLoanRows();
  if (!rows.length) return;

  const globalIrMap = await fetchGlobalIrPctMap();

  const providers = {};
  const getP = (chainId) => (providers[chainId] ||= getProviderForChain(chainId, CHAINS_CONFIG));

  let cdpState = {
    state: "UNKNOWN",
    trigger: CDP_REDEMPTION_TRIGGER,
    diff: null,
    label: "no CDP price available",
  };

  try {
    const flrProvider = getP("FLR");
    const cdpPrice = await getCdpPrice(flrProvider);
    cdpState = classifyCdpRedemptionState(cdpPrice);
  } catch (e) {
    logger.warn(`[loanMonitor] CDP price/state unavailable: ${e?.message || e}`);
  }
  const { irOffsetPp } = getTestOffsets();
  if (irOffsetPp !== 0 && cdpState) {
    cdpState = {
      ...cdpState,
      state: "ACTIVE",
      label: `${cdpState.label} (test IR override)`,
    };
  }

  const byChain = new Map();
  for (const r of rows) {
    const cid = String(r.chainId || "").toUpperCase();
    if (!byChain.has(cid)) byChain.set(cid, []);
    byChain.get(cid).push(r);
  }

  for (const [chainId, chainRows] of byChain.entries()) {
    let provider;
    try {
      provider = getP(chainId);
    } catch (e) {
      logger.warn(`[loanMonitor] Skipping chain ${chainId}: ${e?.message || e}`);
      continue;
    }

    for (const row of chainRows) {
      try {
        await describeLoanPosition(provider, chainId, row.protocol || "UNKNOWN_PROTOCOL", row, {
          cdpState,
          globalIrMap,
        });
      } catch (err) {
        logger.error(
          `[loanMonitor] Failed troveId=${row.troveId} chain=${chainId} protocol=${row.protocol}: ${err?.message || err}`
        );
      }
    }
  }

  logRunApplied();
}

// -----------------------------
// Public API: getLoanSummaries (needed by /my-loans)
// -----------------------------
async function getLoanSummaries(userId = null) {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT snapshot_json, snapshot_at
      FROM loan_position_snapshots
      WHERE (? IS NULL OR user_id = ?)
      ORDER BY chain_id, protocol, token_id
    `
    )
    .all(userId, userId);

  const out = [];
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.snapshot_json);
      if (obj && typeof obj === "object") {
        obj.snapshotAt = r.snapshot_at;
        out.push(obj);
      }
    } catch (_) {}
  }

  return out;
}

async function refreshLoanSnapshots() {
  const runId = String(Date.now());
  const rows = getMonitoredLoanRows();
  if (!rows.length) return;

  let globalIrMap = null;
  try {
    globalIrMap = await fetchGlobalIrPctMap();
  } catch (e) {
    logger.warn(`[loanMonitor] Global IR unavailable for snapshots: ${e?.message || e}`);
  }

  const providers = {};
  const getP = (chainId) => (providers[chainId] ||= getProviderForChain(chainId, CHAINS_CONFIG));
  const poolStatsByContract = new Map();
  const troveManagerByNft = new Map();

  for (const row of rows) {
    const chainId = String(row.chainId || "").toUpperCase();
    let provider;
    try {
      provider = getP(chainId);
    } catch (e) {
      logger.warn(`[loanMonitor] Skipping chain ${chainId} for snapshots: ${e?.message || e}`);
      continue;
    }

    const protocol = row.protocol || "UNKNOWN_PROTOCOL";
    try {
      const s = await summarizeLoanPosition(provider, chainId, protocol, row, globalIrMap);
      const nftAddr = row.contract;
      if (nftAddr) {
        if (!troveManagerByNft.has(nftAddr)) {
          try {
            const nft = new ethers.Contract(nftAddr, troveNftAbi, provider);
            const tmAddr = await nft.troveManager();
            troveManagerByNft.set(nftAddr, tmAddr);
          } catch (e) {
            troveManagerByNft.set(nftAddr, null);
          }
        }
        const troveManagerAddr = troveManagerByNft.get(nftAddr);
        if (!troveManagerAddr) return;

        if (!poolStatsByContract.has(troveManagerAddr)) {
          try {
            const stats = await getActivePoolStats(provider, troveManagerAddr);
            poolStatsByContract.set(troveManagerAddr, stats);
          } catch (e) {
            poolStatsByContract.set(troveManagerAddr, null);
          }
        }
        const stats = poolStatsByContract.get(troveManagerAddr);
        const avgIr = stats?.avgIrPct ?? null;
        const totalDebt = stats?.totalDebt ?? null;

        const debtInfo = await computeDebtInFront(provider, troveManagerAddr, row.troveId);
        const debtAheadPct =
          typeof debtInfo?.debtInFront === "number" &&
          Number.isFinite(debtInfo.debtInFront) &&
          typeof totalDebt === "number" &&
          Number.isFinite(totalDebt) &&
          totalDebt > 0
            ? debtInfo.debtInFront / totalDebt
            : null;
        if (s) {
          setDebtAheadBase(protocol, debtAheadPct, totalDebt);
          const adjustedDebtAheadPct = applyDebtAheadOffsetPct(debtAheadPct, protocol);
          const adjustedDebtAhead =
            adjustedDebtAheadPct != null &&
            typeof totalDebt === "number" &&
            Number.isFinite(totalDebt) &&
            totalDebt > 0
              ? adjustedDebtAheadPct * totalDebt
              : debtInfo?.debtInFront ?? null;
          const redDebt = classifyRedemptionTierByDebtAhead(adjustedDebtAheadPct);
          s.redemptionTier = redDebt.tier;
          s.redemptionDebtAhead = adjustedDebtAhead;
          s.redemptionDebtAheadPct = adjustedDebtAheadPct;
          s.redemptionTotalDebt = totalDebt;
          upsertLoanSnapshot(s, runId);
        }
        const fmtNum = new Intl.NumberFormat("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        let avgIrPct = avgIr;
        if (typeof avgIrPct === "number" && Number.isFinite(avgIrPct) && avgIrPct > 1e6) {
          avgIrPct = avgIrPct / 1e18;
        }
        const avgIrText =
          typeof avgIrPct === "number" && Number.isFinite(avgIrPct)
            ? `${avgIrPct.toFixed(2)}%`
            : "n/a";
        const debtText =
          typeof debtInfo?.debtInFront === "number" && Number.isFinite(debtInfo.debtInFront)
            ? fmtNum.format(debtInfo.debtInFront)
            : "n/a";
        logger.info(
          `[loanMonitor] Redemption depth ${protocol} trove=${shortenTroveId(row.troveId)} ` +
            `ahead=${debtInfo?.trovesAhead ?? "?"} debt=${debtText} ` +
            `avgIR=${avgIrText} first=${shortenTroveId(debtInfo?.firstId)} ` +
            `(${debtInfo?.firstIr != null ? debtInfo.firstIr.toFixed(2) : "n/a"}%) ` +
            `last=${shortenTroveId(debtInfo?.lastId)} ` +
            `(${debtInfo?.lastIr != null ? debtInfo.lastIr.toFixed(2) : "n/a"}%)`
        );
      }
    } catch (e) {
      logger.error(
        `[loanMonitor] Failed snapshot troveId=${row.troveId} chain=${chainId} protocol=${protocol}: ${e?.message || e}`
      );
    }
  }

  cleanupLoanSnapshots(runId);
}

module.exports = {
  monitorLoans,
  getLoanSummaries,
  refreshLoanSnapshots,
  getCdpPrice,
  classifyCdpRedemptionState,
};
