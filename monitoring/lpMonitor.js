// monitoring/lpMonitor.js
//
// DB-driven LP monitor (NEW SCHEMA):
// - Reads LP positions via (user_wallets + contracts(kind=LP_NFT) + nft_tokens current owner)
// - Uses lp_token_meta.pair_label when available
// - Persists previous range status in alert_state.state_json (via alertEngine) - no extra tables
// - Provider endpoints come from .env (FLR_MAINNET, XDC_MAINNET, etc.)
// - Keeps existing range-tier logic + alertEngine integration intact
//
// Enhancements:
// - amount0/amount1 principal amounts (Uniswap v3 math) from liquidity + slot0.sqrtPriceX96
// - fees: prefer "callStatic collect" (simulated) to show current uncollected fees,
//         fallback to tokensOwed0/tokensOwed1 when collect isn't available.

const { ethers } = require("ethers");

const positionManagerAbi = require("../abi/positionManager.json");
const uniswapV3FactoryAbi = require("../abi/uniswapV3Factory.json");
const uniswapV3PoolAbi = require("../abi/uniswapV3Pool.json");
const erc20MetadataAbi = require("../abi/erc20Metadata.json");
const JSBI = require("jsbi");
const { TickMath, SqrtPriceMath } = require("@uniswap/v3-sdk");

const { getDb } = require("../db");
const { getProviderForChain } = require("../utils/ethers/providers");
const { handleLpRangeAlert } = require("./alertEngine");
const { applyLpTickShift, logRunApplied } = require("./testOffsets");
const logger = require("../utils/logger");

function getLpSnapshotAt({ userId, walletId, contractId, tokenId }) {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT snapshot_at
      FROM lp_position_snapshots
      WHERE user_id = ?
        AND wallet_id = ?
        AND contract_id = ?
        AND token_id = ?
      `
    )
    .get(userId, walletId, contractId, String(tokenId));
  return row?.snapshot_at || null;
}

// -----------------------------
// Chains config for getProviderForChain()
// -----------------------------
const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
  XDC: { rpcEnvKey: "XDC_MAINNET" },
};

// -----------------------------
// Env parsing
// -----------------------------
const LP_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];

const LP_EDGE_WARN_FRAC = Number(process.env.LP_EDGE_WARN_FRAC);
const LP_EDGE_HIGH_FRAC = Number(process.env.LP_EDGE_HIGH_FRAC);
const LP_OUT_WARN_FRAC = Number(process.env.LP_OUT_WARN_FRAC);
const LP_OUT_HIGH_FRAC = Number(process.env.LP_OUT_HIGH_FRAC);

// -----------------------------
// Standard Uniswap v3 math
// -----------------------------
function toJSBI(x) {
  if (typeof x === "bigint") return JSBI.BigInt(x.toString());
  return JSBI.BigInt(String(x));
}

function amountsForPosition({ sqrtPriceX96, tickLower, tickUpper, liquidity }) {
  const L = toJSBI(liquidity);
  const sqrtP = toJSBI(sqrtPriceX96);

  const sqrtA = TickMath.getSqrtRatioAtTick(Number(tickLower));
  const sqrtB = TickMath.getSqrtRatioAtTick(Number(tickUpper));

  const sqrtLower = JSBI.lessThan(sqrtA, sqrtB) ? sqrtA : sqrtB;
  const sqrtUpper = JSBI.lessThan(sqrtA, sqrtB) ? sqrtB : sqrtA;

  let amount0 = JSBI.BigInt(0);
  let amount1 = JSBI.BigInt(0);

  if (JSBI.lessThanOrEqual(sqrtP, sqrtLower)) {
    amount0 = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, L, true);
  } else if (JSBI.lessThan(sqrtP, sqrtUpper)) {
    amount0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtUpper, L, true);
    amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtP, L, true);
  } else {
    amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, L, true);
  }

  return { amount0Raw: amount0.toString(), amount1Raw: amount1.toString() };
}

function formatBandRuler(positionFrac, width = 20) {
  if (typeof positionFrac !== "number" || !Number.isFinite(positionFrac)) {
    return "0% |--------------------| 100%";
  }
  const clamped = Math.max(0, Math.min(1, positionFrac));
  const steps = Math.max(6, Math.floor(width));
  const idx = Math.round(clamped * (steps - 1));
  let bar = "";
  for (let i = 0; i < steps; i++) bar += i === idx ? "o" : "-";
  return `0% |${bar}| 100%`;
}

// -----------------------------
// Tier compare
// -----------------------------
function isLpTierAtLeast(tier, minTier) {
  const idx = LP_TIER_ORDER.indexOf((tier || "UNKNOWN").toUpperCase());
  const minIdx = LP_TIER_ORDER.indexOf((minTier || "UNKNOWN").toUpperCase());
  if (idx === -1 || minIdx === -1) return false;
  return idx >= minIdx;
}

// -----------------------------
// Token caches (best-effort)
// -----------------------------
const tokenSymbolCache = new Map();
const tokenDecimalsCache = new Map();

async function getTokenSymbol(provider, address) {
  const key = (address || "").toLowerCase();
  if (tokenSymbolCache.has(key)) return tokenSymbolCache.get(key);

  const token = new ethers.Contract(address, erc20MetadataAbi, provider);
  const symbol = await token.symbol();
  tokenSymbolCache.set(key, symbol);
  return symbol;
}

async function getTokenDecimals(provider, address) {
  const key = (address || "").toLowerCase();
  if (tokenDecimalsCache.has(key)) return tokenDecimalsCache.get(key);

  const token = new ethers.Contract(address, erc20MetadataAbi, provider);
  const decRaw = await token.decimals();
  const dec = Number(decRaw);
  const out = Number.isFinite(dec) ? dec : 18;
  tokenDecimalsCache.set(key, out);
  return out;
}

// -----------------------------
// Compute fees owed from pool feeGrowth
// -----------------------------

const Q128 = 1n << 128n;

function toBigIntish(v) {
  // ethers v6 returns native bigint for uint256; v5 returns BigNumber-ish
  if (typeof v === "bigint") return v;
  return BigInt(v.toString());
}

async function computeFeesOwedFromPool({
  pool,
  currentTick,
  tickLower,
  tickUpper,
  liquidity,
  feeGrowthInside0LastX128,
  feeGrowthInside1LastX128,
  tokensOwed0,
  tokensOwed1,
}) {
  const feeGrowthGlobal0X128 = toBigIntish(await pool.feeGrowthGlobal0X128());
  const feeGrowthGlobal1X128 = toBigIntish(await pool.feeGrowthGlobal1X128());

  const lower = await pool.ticks(Number(tickLower));
  const upper = await pool.ticks(Number(tickUpper));

  const lowerOut0 = toBigIntish(lower.feeGrowthOutside0X128 ?? lower[2]);
  const lowerOut1 = toBigIntish(lower.feeGrowthOutside1X128 ?? lower[3]);
  const upperOut0 = toBigIntish(upper.feeGrowthOutside0X128 ?? upper[2]);
  const upperOut1 = toBigIntish(upper.feeGrowthOutside1X128 ?? upper[3]);

  const tickCur = Number(currentTick);

  // feeGrowthBelow/Above depends on where current tick is relative to bounds
  const belowSub0 = feeGrowthGlobal0X128 > lowerOut0 ? (feeGrowthGlobal0X128 - lowerOut0) : 0n;
  const belowSub1 = feeGrowthGlobal1X128 > lowerOut1 ? (feeGrowthGlobal1X128 - lowerOut1) : 0n;

  const aboveSub0 = feeGrowthGlobal0X128 > upperOut0 ? (feeGrowthGlobal0X128 - upperOut0) : 0n;
  const aboveSub1 = feeGrowthGlobal1X128 > upperOut1 ? (feeGrowthGlobal1X128 - upperOut1) : 0n;

  const feeGrowthBelow0 = tickCur >= Number(tickLower) ? lowerOut0 : belowSub0;
  const feeGrowthBelow1 = tickCur >= Number(tickLower) ? lowerOut1 : belowSub1;

  const feeGrowthAbove0 = tickCur < Number(tickUpper) ? upperOut0 : aboveSub0;
  const feeGrowthAbove1 = tickCur < Number(tickUpper) ? upperOut1 : aboveSub1;

  const feeGrowthInside0X128 = feeGrowthGlobal0X128 - feeGrowthBelow0 - feeGrowthAbove0;
  const feeGrowthInside1X128 = feeGrowthGlobal1X128 - feeGrowthBelow1 - feeGrowthAbove1;

  const L = toBigIntish(liquidity);

  const last0 = toBigIntish(feeGrowthInside0LastX128);
  const last1 = toBigIntish(feeGrowthInside1LastX128);

  const owed0Base = toBigIntish(tokensOwed0);
  const owed1Base = toBigIntish(tokensOwed1);

  const delta0 = feeGrowthInside0X128 > last0 ? (feeGrowthInside0X128 - last0) : 0n;
  const delta1 = feeGrowthInside1X128 > last1 ? (feeGrowthInside1X128 - last1) : 0n;

  const fees0 = owed0Base + (L * delta0) / Q128;
  const fees1 = owed1Base + (L * delta1) / Q128;

  return { fee0Raw: fees0.toString(), fee1Raw: fees1.toString() };
}

// -----------------------------
// Fees helper: simulate collect() (no state change)
// -----------------------------
const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * Try to compute current uncollected fees by simulating a collect().
 * Works on Uniswap v3 NonfungiblePositionManager-style contracts.
 *
 * Returns: { fee0Raw: string, fee1Raw: string } or null if not supported.
 */
async function simulateCollectFees(pm, tokenIdBN, recipientEip55) {
  // Some ABIs use collect(tuple), others expose collect(...) directly.
  // Ethers v6: contract.collect.staticCall(...)
  // Ethers v5: contract.callStatic.collect(...)
  const params = {
    tokenId: tokenIdBN,
    recipient: recipientEip55,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  try {
    // v6 style (preferred)
    if (pm?.collect?.staticCall) {
      const out = await pm.collect.staticCall(params);
      const a0 = out?.amount0 ?? out?.[0];
      const a1 = out?.amount1 ?? out?.[1];
      if (a0 != null && a1 != null) return { fee0Raw: a0.toString(), fee1Raw: a1.toString() };
    }
  } catch (_) {}

  try {
    // v5 style fallback
    if (pm?.callStatic?.collect) {
      const out = await pm.callStatic.collect(params);
      const a0 = out?.amount0 ?? out?.[0];
      const a1 = out?.amount1 ?? out?.[1];
      if (a0 != null && a1 != null) return { fee0Raw: a0.toString(), fee1Raw: a1.toString() };
    }
  } catch (_) {}

  // If your ABI doesn't include collect, this will always be null.
  return null;
}

// -----------------------------
// LP range tier classification
// -----------------------------
function classifyLpRangeTier(rangeStatus, tickLower, tickUpper, currentTick) {
  const normStatus = (rangeStatus || "").toString().toUpperCase().replace(/\s+/g, "_");

  const width = tickUpper - tickLower;
  const hasTicks =
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(tickLower) &&
    Number.isFinite(tickUpper) &&
    Number.isFinite(currentTick);

  const edgeWarn = LP_EDGE_WARN_FRAC;
  const edgeHigh = LP_EDGE_HIGH_FRAC;
  const outWarn = LP_OUT_WARN_FRAC;
  const outHigh = LP_OUT_HIGH_FRAC;

  if (normStatus === "IN_RANGE" && hasTicks) {
    const positionFrac = (currentTick - tickLower) / width;
    const centerDist = Math.min(positionFrac, 1 - positionFrac);

    if (!Number.isFinite(centerDist) || centerDist < 0) {
      return { tier: "UNKNOWN", positionFrac: null, distanceFrac: null, label: "invalid in-range tick geometry" };
    }

    let tier = "LOW";
    if (Number.isFinite(edgeHigh) && centerDist <= edgeHigh) tier = "HIGH";
    else if (Number.isFinite(edgeWarn) && centerDist <= edgeWarn) tier = "MEDIUM";

    const label =
      tier === "LOW"
        ? "comfortably in range."
        : tier === "MEDIUM"
        ? "in range but starting to drift."
        : "in range but close to the edge.";

    return { tier, positionFrac, distanceFrac: centerDist, label };
  }

  if (normStatus === "OUT_OF_RANGE" && hasTicks) {
    let distanceFrac = null;

    if (currentTick < tickLower) distanceFrac = (tickLower - currentTick) / width;
    else if (currentTick >= tickUpper) distanceFrac = (currentTick - tickUpper) / width;

    if (!Number.isFinite(distanceFrac) || distanceFrac < 0) {
      return { tier: "HIGH", positionFrac: null, distanceFrac: null, label: "out of range (distance unknown)" };
    }

    let tier;
    if (Number.isFinite(outWarn) && distanceFrac <= outWarn) tier = "MEDIUM";
    else if (Number.isFinite(outHigh) && distanceFrac <= outHigh) tier = "HIGH";
    else tier = "CRITICAL";

    const label =
      tier === "MEDIUM"
        ? "slightly out of range."
        : tier === "HIGH"
        ? "far out of range."
        : "deeply out of range.";

    return { tier, positionFrac: null, distanceFrac, label };
  }

  return {
    tier: normStatus === "IN_RANGE" ? "LOW" : "UNKNOWN",
    positionFrac: null,
    distanceFrac: null,
    label: normStatus === "IN_RANGE" ? "in range (no detailed geometry)." : "range not computed.",
  };
}

// -----------------------------
// DB: fetch monitored LP rows (NEW SCHEMA)
// -----------------------------
function getMonitoredLpRows(userId = null) {
  const db = getDb();

  const sql = `
    SELECT
      u.id                 AS userId,
      uw.id                AS walletId,
      c.id                 AS contractId,

      c.chain_id           AS chainId,
      c.protocol           AS protocol,

      uw.address_eip55     AS owner,
      uw.label            AS walletLabel,
      uw.lp_alerts_status_only AS lpStatusOnly,
      c.address_eip55      AS contract,

      nt.token_id          AS tokenId,
      lpm.pair_label       AS pairLabel,

      ast.state_json       AS prevStateJson
    FROM user_wallets uw
    JOIN users u
      ON u.id = uw.user_id
    JOIN contracts c
      ON c.chain_id = uw.chain_id
     AND c.kind = 'LP_NFT'
    JOIN nft_tokens nt
      ON nt.contract_id = c.id
     AND nt.owner_lower = uw.address_lower
     AND nt.is_burned = 0
    LEFT JOIN lp_token_meta lpm
      ON lpm.contract_id = nt.contract_id
     AND lpm.token_id    = nt.token_id
    LEFT JOIN alert_state ast
      ON ast.user_id     = u.id
     AND ast.wallet_id   = uw.id
     AND ast.contract_id = c.id
     AND ast.token_id    = nt.token_id
     AND ast.alert_type  = 'LP_RANGE'
    LEFT JOIN position_ignores pi
      ON pi.user_id        = u.id
     AND pi.position_kind  = 'LP'
     AND pi.wallet_id      = uw.id
     AND pi.contract_id    = c.id
     AND (pi.token_id IS NULL OR pi.token_id = nt.token_id)
    WHERE
      uw.is_enabled = 1
      AND c.is_enabled = 1
      AND (? IS NULL OR u.id = ?)
      AND pi.id IS NULL
    ORDER BY c.chain_id, c.protocol, uw.address_eip55, nt.token_id
  `;

  return db.prepare(sql).all(userId, userId);
}

let _lpSnapshotStmt = null;
function upsertLpSnapshot(snapshot, runId) {
  if (!runId || !snapshot) return;
  const db = getDb();
  if (!_lpSnapshotStmt) {
    _lpSnapshotStmt = db.prepare(`
      INSERT INTO lp_position_snapshots (
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

  _lpSnapshotStmt.run({
    user_id: snapshot.userId,
    wallet_id: snapshot.walletId,
    contract_id: snapshot.contractId,
    token_id: snapshot.tokenId,
    chain_id: snapshot.chainId,
    protocol: snapshot.protocol,
    wallet_label: snapshot.walletLabel || null,
    snapshot_run_id: runId,
    snapshot_json: JSON.stringify(snapshot),
  });
}

function cleanupLpSnapshots(runId) {
  if (!runId) return;
  const db = getDb();
  db.prepare(`DELETE FROM lp_position_snapshots WHERE snapshot_run_id != ?`).run(runId);
}

function extractPrevRangeStatus(prevStateJson) {
  if (!prevStateJson) return "UNKNOWN";
  try {
    const obj = JSON.parse(prevStateJson);
    if (!obj || obj.kind !== "LP") return "UNKNOWN";
    const s = obj.rangeStatus ?? obj.status ?? obj.range ?? null;
    const out = (s || "UNKNOWN").toString().toUpperCase();
    if (out === "INACTIVE") return "INACTIVE";
    if (out === "OUT_OF_RANGE" || out === "IN_RANGE" || out === "UNKNOWN") return out;
    return out;
  } catch {
    return "UNKNOWN";
  }
}

// -----------------------------
// LP summary builder (no logging)
// -----------------------------
async function summarizeLpPosition(provider, chainId, protocol, row) {
  const {
    userId,
    walletId,
    contractId,
    contract,
    owner,
    tokenId,
    pairLabel: dbPairLabel,
    walletLabel,
  } = row;
  const tokenIdBN = BigInt(tokenId);

  const pm = new ethers.Contract(contract, positionManagerAbi, provider);
  const pos = await pm.positions(tokenIdBN);

  const liquidity = BigInt(pos.liquidity.toString());

  const token0 = pos.token0;
  const token1 = pos.token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  // raw "owed" fields (often stale / 0)
  const tokensOwed0Raw = pos.tokensOwed0 != null ? pos.tokensOwed0.toString() : "0";
  const tokensOwed1Raw = pos.tokensOwed1 != null ? pos.tokensOwed1.toString() : "0";

  // symbols + decimals (best-effort)
  let token0Symbol = token0;
  let token1Symbol = token1;
  let dec0 = 18;
  let dec1 = 18;

  try { token0Symbol = await getTokenSymbol(provider, token0); } catch (_) {}
  try { token1Symbol = await getTokenSymbol(provider, token1); } catch (_) {}
  try { dec0 = await getTokenDecimals(provider, token0); } catch (_) {}
  try { dec1 = await getTokenDecimals(provider, token1); } catch (_) {}

  const pairLabel = dbPairLabel || `${token0Symbol}-${token1Symbol}`;

  if (liquidity === 0n) {
    return {
      userId,
      walletId,
      contractId,
      protocol,
      chainId,
      owner,
      walletLabel,
      tokenId,
      nftContract: contract,
      token0,
      token1,
      token0Symbol,
      token1Symbol,
      pairLabel,
      fee,
      tickLower,
      tickUpper,
      currentTick: null,
      liquidity: "0",
      status: "INACTIVE",
      rangeStatus: "INACTIVE",
      poolAddr: null,
      amount0: null,
      amount1: null,
      fees0: null,
      fees1: null,
      lpRangeTier: "UNKNOWN",
      lpRangeLabel: "inactive",
      lpPositionFrac: null,
      lpDistanceFrac: null,
    };
  }

  let poolAddr = null;
  let currentTick = null;
  let sqrtPriceX96 = null;
  let rangeStatus = "UNKNOWN";

  try {
    const factoryAddr = await pm.factory();
    if (factoryAddr && factoryAddr !== ethers.ZeroAddress) {
      const factory = new ethers.Contract(factoryAddr, uniswapV3FactoryAbi, provider);
      poolAddr = await factory.getPool(token0, token1, fee);

      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);
        const slot0 = await pool.slot0();

        const tick = slot0.tick !== undefined ? slot0.tick : slot0[1];
        const sp = slot0.sqrtPriceX96 !== undefined ? slot0.sqrtPriceX96 : slot0[0];

        currentTick = Number(tick);
        sqrtPriceX96 = sp ? sp.toString() : null;

        if (Number.isFinite(currentTick)) {
          currentTick = applyLpTickShift(currentTick, tickLower, tickUpper);
          rangeStatus =
            currentTick >= tickLower && currentTick < tickUpper ? "IN_RANGE" : "OUT_OF_RANGE";
        }
      }
    }
  } catch (_) {}

  const lpClass = classifyLpRangeTier(rangeStatus, tickLower, tickUpper, currentTick);

  // principal token amounts (best-effort)
  let amount0 = null;
  let amount1 = null;
  if (sqrtPriceX96) {
    try {
      const { amount0Raw, amount1Raw } = amountsForPosition({
        sqrtPriceX96,
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
      });
      amount0 = Number(ethers.formatUnits(amount0Raw, dec0));
      amount1 = Number(ethers.formatUnits(amount1Raw, dec1));
    } catch (_) {}
  }

  // ✅ fees: prefer simulated collect() (live), fallback to tokensOwed*
  let fee0Raw = tokensOwed0Raw;
  let fee1Raw = tokensOwed1Raw;

  let simWorked = false;
  let feeSource = "tokensOwed";
  try {
    const sim = await simulateCollectFees(pm, tokenIdBN, owner);
    if (sim?.fee0Raw != null && sim?.fee1Raw != null) {
      fee0Raw = sim.fee0Raw;
      fee1Raw = sim.fee1Raw;
      simWorked = true;
      feeSource = "collectSim";
    } else {
      logger.debug(
        `[LP][${chainId}] collectSim unavailable tokenId=${tokenId}: no fee data returned`
      );
    }
  } catch (err) {
    logger.debug(
      `[LP][${chainId}] collectSim FAILED tokenId=${tokenId}: ${err?.shortMessage || err?.message || err}`
    );
  }

  // If sim gives 0/0 (or doesn’t work) but we have a pool + tick, compute via feeGrowth math
  try {
    const bothZero = (fee0Raw === "0" && fee1Raw === "0");
    if ((bothZero || !simWorked) && poolAddr && Number.isFinite(currentTick)) {
      const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);

      const MAX_UINT256 = (1n << 256n) - 1n;
      const SANE_MAX = 1n << 255n;
      const fg0Raw = toBigIntish(pos.feeGrowthInside0LastX128);
      const fg1Raw = toBigIntish(pos.feeGrowthInside1LastX128);
      const fg0 = fg0Raw > SANE_MAX ? 0n : fg0Raw;
      const fg1 = fg1Raw > SANE_MAX ? 0n : fg1Raw;
      if (fg0Raw === MAX_UINT256 || fg1Raw === MAX_UINT256 || fg0Raw > SANE_MAX || fg1Raw > SANE_MAX) {
        logger.debug(
          `[LP][${chainId}] feeGrowthInside out-of-range tokenId=${tokenId}; treating as 0`
        );
      }

      const computed = await computeFeesOwedFromPool({
        pool,
        currentTick,
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
        feeGrowthInside0LastX128: fg0,
        feeGrowthInside1LastX128: fg1,
        tokensOwed0: pos.tokensOwed0,
        tokensOwed1: pos.tokensOwed1,
      });

      fee0Raw = computed.fee0Raw;
      fee1Raw = computed.fee1Raw;
      feeSource = "feeGrowth";
    }
  } catch (err) {
    logger.warn(
      `[LP][${chainId}] feeGrowth fallback FAILED tokenId=${tokenId}: ${err.shortMessage || err.message}`
    );
  }


  let fees0 = null;
  let fees1 = null;
  try { fees0 = Number(ethers.formatUnits(fee0Raw, dec0)); } catch (_) {}
  try { fees1 = Number(ethers.formatUnits(fee1Raw, dec1)); } catch (_) {}

  logger.debug(
    `[LP][${chainId}] fee source=${feeSource} tokenId=${tokenId} ` +
      `pool=${poolAddr || "n/a"} tick=${Number.isFinite(currentTick) ? currentTick : "n/a"} ` +
      `fees0=${fees0 ?? "n/a"} fees1=${fees1 ?? "n/a"}`
  );
  logger.debug(
    `[LP][${chainId}] fee debug tokenId=${tokenId} tickLower=${tickLower} tickUpper=${tickUpper} ` +
      `liq=${liquidity?.toString?.() || liquidity || "n/a"} ` +
      `tokensOwed0=${tokensOwed0Raw} tokensOwed1=${tokensOwed1Raw} ` +
      `feeGrowthInside0=${pos.feeGrowthInside0LastX128?.toString?.() || pos.feeGrowthInside0LastX128} ` +
      `feeGrowthInside1=${pos.feeGrowthInside1LastX128?.toString?.() || pos.feeGrowthInside1LastX128}`
  );

  return {
    userId,
    walletId,
    contractId,

    protocol,
    chainId,
    owner,
    walletLabel,
    tokenId,
    nftContract: contract,

    token0,
    token1,
    token0Symbol,
    token1Symbol,
    pairLabel,

    fee,
    tickLower,
    tickUpper,
    currentTick,
    liquidity: liquidity.toString(),
    status: "ACTIVE",
    rangeStatus,
    poolAddr,

    amount0,
    amount1,

    fees0,
    fees1,

    lpRangeTier: lpClass.tier,
    lpRangeLabel: lpClass.label,
    lpPositionFrac: lpClass.positionFrac,
    lpDistanceFrac: lpClass.distanceFrac,
  };
}

// -----------------------------
// Public API: getLpSummaries
// -----------------------------
async function getLpSummaries(userId = null) {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT snapshot_json, snapshot_at
      FROM lp_position_snapshots
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

async function refreshLpSnapshots() {
  const runId = String(Date.now());
  const rows = getMonitoredLpRows();
  if (!rows || rows.length === 0) return;
  let ok = 0;
  let failed = 0;

  const providers = new Map();
  const getP = (chainId) => {
    if (providers.has(chainId)) return providers.get(chainId);
    const p = getProviderForChain(chainId, CHAINS_CONFIG);
    providers.set(chainId, p);
    return p;
  };

  for (const row of rows) {
    const chainId = (row.chainId || "").toUpperCase();
    let provider;
    try {
      provider = getP(chainId);
    } catch (err) {
      logger.warn(`[LP] Skipping chain ${chainId} for snapshots: ${err?.message || err}`);
      continue;
    }

    try {
      const summary = await summarizeLpPosition(
        provider,
        chainId,
        row.protocol || "UNKNOWN_PROTOCOL",
        row
      );
      if (summary) {
        upsertLpSnapshot(summary, runId);
        ok += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
      logger.error(
        `[LP] Failed snapshot tokenId=${row.tokenId} on ${chainId}:`,
        err?.message || err
      );
    }
  }

  cleanupLpSnapshots(runId);
  logger.debug(
    `[LP] Snapshot refresh complete: rows=${rows.length} ok=${ok} failed=${failed}`
  );
}

// -----------------------------
// Core LP description (logging + alerts) - unchanged
// -----------------------------
async function describeLpPosition(provider, chainId, protocol, row, options = {}) {
  const { verbose = false } = options;

  const {
    userId,
    walletId,
    contractId,
    contract,
    owner,
    tokenId,
    pairLabel: dbPairLabel,
    prevStateJson,
    walletLabel,
    lpStatusOnly,
  } = row;
  const prevStatus = extractPrevRangeStatus(prevStateJson);
  const snapshotAt = getLpSnapshotAt({ userId, walletId, contractId, tokenId });

  const tokenIdBN = BigInt(tokenId);
  const pm = new ethers.Contract(contract, positionManagerAbi, provider);
  const pos = await pm.positions(tokenIdBN);

  const tokensOwed0Raw = pos.tokensOwed0 != null ? pos.tokensOwed0.toString() : "0";
  const tokensOwed1Raw = pos.tokensOwed1 != null ? pos.tokensOwed1.toString() : "0";
  
  const liquidity = BigInt(pos.liquidity.toString());
  const token0 = pos.token0;
  const token1 = pos.token1;
  let dec0 = 18;
  let dec1 = 18;
  let sym0 = token0;
  let sym1 = token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  try {
    [dec0, dec1] = await Promise.all([
      getTokenDecimals(provider, token0).catch(() => 18),
      getTokenDecimals(provider, token1).catch(() => 18),
    ]);
  } catch (_) {}

  try {
    [sym0, sym1] = await Promise.all([
      getTokenSymbol(provider, token0).catch(() => token0),
      getTokenSymbol(provider, token1).catch(() => token1),
    ]);
  } catch (_) {}

  const pairLabelFallback = dbPairLabel || `${sym0}-${sym1}`;

  if (liquidity === 0n) {
    if (verbose) {
      logger.debug(
        `${protocol} tokenId=${tokenId} on ${chainId} has zero liquidity; treating as INACTIVE.`
      );
    }

    await handleLpRangeAlert({
      userId,
      walletId,
      contractId,
      positionId: tokenId,
      prevStatus,
      currentStatus: "INACTIVE",
      isActive: false,
      lpRangeTier: "UNKNOWN",
      lpRangeLabel: null,
      tickLower: null,
      tickUpper: null,
      currentTick: null,
      protocol,
      wallet: owner,
      walletLabel,
      walletAddress: owner,
      chainId,
      lpStatusOnly,
      pairLabel: pairLabelFallback,
      priceLower: null,
      priceUpper: null,
      currentPrice: null,
      priceBaseSymbol: sym0,
      priceQuoteSymbol: sym1,
      snapshotAt,
    });
    return;
  }

  const pairLabel = dbPairLabel || `${sym0}-${sym1}`;

  if (verbose) {
    logger.debug("========================================");
    logger.debug(`LP POSITION (${protocol})`);
    logger.debug("----------------------------------------");
    logger.debug(`UserId:    ${userId}`);
    logger.debug(`WalletId:  ${walletId}`);
    logger.debug(`ContractId:${contractId}`);
    logger.debug(`Owner:     ${owner}`);
    logger.debug(`Chain:     ${chainId}`);
    logger.debug(`NFT:       ${contract}`);
    logger.debug(`tokenId:   ${tokenId}`);
    logger.debug("");
    logger.debug("  --- Basic Position Data ---");
    logger.debug(`  token0:        ${token0}`);
    logger.debug(`  token1:        ${token1}`);
    logger.debug(`  fee:           ${fee}`);
    logger.debug(`  tickLower:     ${tickLower}`);
    logger.debug(`  tickUpper:     ${tickUpper}`);
    logger.debug(`  liquidity:     ${liquidity.toString()}`);
    logger.debug(`  status:        ACTIVE`);
    if (pairLabel) logger.debug(`  pairLabel:     ${pairLabel}`);
  }

  let currentStatus = "UNKNOWN";
  let poolAddr = null;
  let currentTick = null;
  let sqrtPriceX96 = null;

  const tickToPrice = (tick) => {
    if (!Number.isFinite(tick)) return null;
    return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
  };

  const priceLower = tickToPrice(tickLower);
  const priceUpper = tickToPrice(tickUpper);
  let currentPrice = null;

  try {
    const factoryAddr = await pm.factory();
    if (factoryAddr && factoryAddr !== ethers.ZeroAddress) {
      const factory = new ethers.Contract(factoryAddr, uniswapV3FactoryAbi, provider);
      poolAddr = await factory.getPool(token0, token1, fee);

      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);
        const slot0 = await pool.slot0();
        const tick = slot0.tick !== undefined ? slot0.tick : slot0[1];
        const sp = slot0.sqrtPriceX96 !== undefined ? slot0.sqrtPriceX96 : slot0[0];
        currentTick = Number(tick);
        sqrtPriceX96 = sp ? sp.toString() : null;

        if (Number.isFinite(currentTick)) {
          currentTick = applyLpTickShift(currentTick, tickLower, tickUpper);
          currentPrice = tickToPrice(currentTick);
          currentStatus =
            currentTick >= tickLower && currentTick < tickUpper ? "IN_RANGE" : "OUT_OF_RANGE";
        }
      }
    }
  } catch (err) {
    logger.warn(
      `  Could not compute range for LP token ${tokenId} (${protocol}):`,
      err?.message || err
    );
  }

  const lpClass = classifyLpRangeTier(currentStatus, tickLower, tickUpper, currentTick);
  const isActive = lpClass.tier !== "UNKNOWN";

  // principal token amounts (best-effort)
  let amount0 = null;
  let amount1 = null;
  if (sqrtPriceX96) {
    try {
      const { amount0Raw, amount1Raw } = amountsForPosition({
        sqrtPriceX96,
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
      });
      amount0 = Number(ethers.formatUnits(amount0Raw, dec0));
      amount1 = Number(ethers.formatUnits(amount1Raw, dec1));
    } catch (_) {}
  }

  // fees: prefer simulated collect() (live), fallback to tokensOwed*
  let fee0Raw = tokensOwed0Raw;
  let fee1Raw = tokensOwed1Raw;

  let simWorked = false;
  let feeSource = "tokensOwed";
  try {
    const sim = await simulateCollectFees(pm, tokenIdBN, owner);
    if (sim?.fee0Raw != null && sim?.fee1Raw != null) {
      fee0Raw = sim.fee0Raw;
      fee1Raw = sim.fee1Raw;
      simWorked = true;
      feeSource = "collectSim";
    } else {
      logger.debug(
        `[LP][${chainId}] collectSim unavailable tokenId=${tokenId}: no fee data returned`
      );
    }
  } catch (err) {
    logger.debug(
      `[LP][${chainId}] collectSim FAILED tokenId=${tokenId}: ${err?.shortMessage || err?.message || err}`
    );
  }

  // If sim gives 0/0 (or doesn’t work) but we have a pool + tick, compute via feeGrowth math
  try {
    const bothZero = fee0Raw === "0" && fee1Raw === "0";
    if ((bothZero || !simWorked) && poolAddr && Number.isFinite(currentTick)) {
      const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);

      const MAX_UINT256 = (1n << 256n) - 1n;
      const SANE_MAX = 1n << 255n;
      const fg0Raw = toBigIntish(pos.feeGrowthInside0LastX128);
      const fg1Raw = toBigIntish(pos.feeGrowthInside1LastX128);
      const fg0 = fg0Raw > SANE_MAX ? 0n : fg0Raw;
      const fg1 = fg1Raw > SANE_MAX ? 0n : fg1Raw;
      if (fg0Raw === MAX_UINT256 || fg1Raw === MAX_UINT256 || fg0Raw > SANE_MAX || fg1Raw > SANE_MAX) {
        logger.debug(
          `[LP][${chainId}] feeGrowthInside out-of-range tokenId=${tokenId}; treating as 0`
        );
      }

      const computed = await computeFeesOwedFromPool({
        pool,
        currentTick,
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
        feeGrowthInside0LastX128: fg0,
        feeGrowthInside1LastX128: fg1,
        tokensOwed0: pos.tokensOwed0,
        tokensOwed1: pos.tokensOwed1,
      });

      fee0Raw = computed.fee0Raw;
      fee1Raw = computed.fee1Raw;
      feeSource = "feeGrowth";
    }
  } catch (err) {
    logger.warn(
      `[LP][${chainId}] feeGrowth fallback FAILED tokenId=${tokenId}: ${err.shortMessage || err.message}`
    );
  }

  let fees0 = null;
  let fees1 = null;
  try { fees0 = Number(ethers.formatUnits(fee0Raw, dec0)); } catch (_) {}
  try { fees1 = Number(ethers.formatUnits(fee1Raw, dec1)); } catch (_) {}

  logger.debug(
    `[LP][${chainId}] fee source=${feeSource} tokenId=${tokenId} ` +
      `pool=${poolAddr || "n/a"} tick=${Number.isFinite(currentTick) ? currentTick : "n/a"} ` +
      `fees0=${fees0 ?? "n/a"} fees1=${fees1 ?? "n/a"}`
  );

  await handleLpRangeAlert({
    userId,
    walletId,
    contractId,
    positionId: tokenId,
    prevStatus,
    currentStatus,
    isActive,
    lpRangeTier: lpClass.tier,
    lpRangeLabel: lpClass.label,
    tickLower,
    tickUpper,
    currentTick,
    protocol,
    wallet: owner,
    walletLabel,
    walletAddress: owner,
    chainId,
    lpStatusOnly,
    pairLabel,
    priceLower,
    priceUpper,
    currentPrice,
    priceBaseSymbol: sym0,
    priceQuoteSymbol: sym1,
    snapshotAt,
  });

  if (verbose) {
    logger.debug("");
    logger.debug("  --- Range Status ---");
    if (poolAddr && currentTick != null) {
      logger.debug(`  pool:          ${poolAddr}`);
      logger.debug(`  currentTick:   ${currentTick}`);
    }
    logger.debug(`  range:         ${currentStatus}`);
    logger.debug(`  range tier:    ${lpClass.tier} (${lpClass.label})`);

    if (lpClass.positionFrac != null) {
      logger.debug(
        `  position:      ${(lpClass.positionFrac * 100).toFixed(2)}% from lower bound`
      );
    }
    if (lpClass.distanceFrac != null) {
      logger.debug(`  edge/dist:     ${(lpClass.distanceFrac * 100).toFixed(2)}% of width`);
    }

    logger.debug("========================================");
    logger.debug("");
  }

  const humanRange =
    currentStatus === "UNKNOWN" ? "with unknown range" : `and ${currentStatus.replace(/_/g, " ")}`;

  const tierPart = lpClass.tier && lpClass.tier !== "UNKNOWN" ? ` (tier ${lpClass.tier})` : "";

  logger.debug(`${protocol} ${pairLabel || "UNKNOWN_PAIR"} is ACTIVE ${humanRange}${tierPart}.`);
}

// -----------------------------
// Public API: monitorLPs
// -----------------------------
async function monitorLPs(options = {}) {
  const verbose = Boolean(options.verbose);

  logger.debug("");

  const rows = getMonitoredLpRows();
  if (!rows || rows.length === 0) {
    logger.info("[LP] No enabled LP positions found in DB.");
    return;
  }

  const byChain = new Map();
  for (const r of rows) {
    const chainId = (r.chainId || "").toUpperCase();
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(r);
  }

  for (const [chainId, chainRows] of byChain.entries()) {
    let provider;
    try {
      provider = getProviderForChain(chainId, CHAINS_CONFIG);
    } catch (err) {
      logger.warn(`[LP] Skipping chain ${chainId}: ${err?.message || err}`);
      continue;
    }

    for (const row of chainRows) {
      try {
        await describeLpPosition(provider, chainId, row.protocol || "UNKNOWN_PROTOCOL", row, {
          verbose,
        });
      } catch (err) {
        logger.error(
          `  [ERROR] Failed to describe LP tokenId=${row.tokenId} on ${chainId}:`,
          err?.message || err
        );
      }
    }
  }

  logRunApplied();
}

module.exports = {
  monitorLPs,
  getLpSummaries,
  refreshLpSnapshots,
  formatBandRuler,
  classifyLpRangeTier,
};
