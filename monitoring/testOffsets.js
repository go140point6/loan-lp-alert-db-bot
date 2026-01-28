// monitoring/testOffsets.js
// In-memory offsets for testing alerts; resets on process restart.

const logger = require("../utils/logger");

const state = {
  irOffsetPp: 0, // additive percentage-points to global IR
  irOffsetByProtocol: {}, // per-protocol additive percentage-points
  liqPriceMultiplier: 1, // multiplicative on price (e.g., 0.98 for -2%)
  liqPriceMultiplierByProtocol: {}, // per-protocol multiplicative on price
  lpRangeShiftPct: 0, // fraction of position width (e.g., 0.25 = 25%)
  debtAheadOffsetPp: 0, // additive percentage-points to debt-ahead pct
  debtAheadOffsetByProtocol: {}, // per-protocol additive percentage-points
};

const debtAheadThresholds = {
  low: null,
  med: null,
  high: null,
};

const lastSeen = {
  globalIrPp: null,
  globalIrPpByProtocol: {},
  price: null,
  priceByProtocol: {},
  lpTick: null,
  lpWidth: null,
  debtAheadPctByProtocol: {},
  debtTotalByProtocol: {},
};

function resetTestOffsets() {
  state.irOffsetPp = 0;
  state.irOffsetByProtocol = {};
  state.liqPriceMultiplier = 1;
  state.liqPriceMultiplierByProtocol = {};
  state.lpRangeShiftPct = 0;
  state.debtAheadOffsetPp = 0;
  state.debtAheadOffsetByProtocol = {};
}

function getTestOffsets() {
  return { ...state };
}

function getLastSeenBases() {
  return { ...lastSeen };
}

function normalizeProtocol(protocol) {
  if (!protocol) return null;
  return String(protocol).trim().toUpperCase();
}

function getIrOffsetPpForProtocol(protocol) {
  const key = normalizeProtocol(protocol);
  const per = key ? Number(state.irOffsetByProtocol[key] || 0) : 0;
  return state.irOffsetPp + per;
}

function getLiqPriceMultiplierForProtocol(protocol) {
  const key = normalizeProtocol(protocol);
  const per = key ? Number(state.liqPriceMultiplierByProtocol[key] || 1) : 1;
  return state.liqPriceMultiplier * per;
}

function getDebtAheadOffsetPpForProtocol(protocol) {
  const key = normalizeProtocol(protocol);
  const per = key ? Number(state.debtAheadOffsetByProtocol[key] || 0) : 0;
  return state.debtAheadOffsetPp + per;
}

function adjustGlobalIrOffsetPp(deltaPp, protocol) {
  const n = Number(deltaPp);
  if (!Number.isFinite(n)) return;
  const key = normalizeProtocol(protocol);
  if (key) {
    state.irOffsetByProtocol[key] = Number(state.irOffsetByProtocol[key] || 0) + n;
  } else {
    state.irOffsetPp += n;
  }
}

function adjustLiqPriceMultiplier(factor, protocol) {
  const n = Number(factor);
  if (!Number.isFinite(n) || n <= 0) return;
  const key = normalizeProtocol(protocol);
  if (key) {
    state.liqPriceMultiplierByProtocol[key] =
      Number(state.liqPriceMultiplierByProtocol[key] || 1) * n;
  } else {
    state.liqPriceMultiplier *= n;
  }
}

function adjustLpRangeShiftPct(deltaPct) {
  const n = Number(deltaPct);
  if (!Number.isFinite(n)) return;
  state.lpRangeShiftPct += n;
}

function adjustDebtAheadOffsetPp(deltaPp, protocol) {
  const n = Number(deltaPp);
  if (!Number.isFinite(n)) return;
  const key = normalizeProtocol(protocol);
  if (key) {
    state.debtAheadOffsetByProtocol[key] =
      Number(state.debtAheadOffsetByProtocol[key] || 0) + n;
  } else {
    state.debtAheadOffsetPp += n;
  }
}

function applyGlobalIrOffset(globalIrPct, protocol) {
  if (globalIrPct == null || !Number.isFinite(globalIrPct)) return globalIrPct;
  const key = normalizeProtocol(protocol);
  if (key) {
    lastSeen.globalIrPpByProtocol[key] = globalIrPct;
  } else {
    lastSeen.globalIrPp = globalIrPct;
  }
  const next = globalIrPct + getIrOffsetPpForProtocol(protocol);
  return next;
}

function applyPriceMultiplier(priceNorm, protocol) {
  if (priceNorm == null || !Number.isFinite(priceNorm)) return priceNorm;
  const key = normalizeProtocol(protocol);
  if (key) {
    lastSeen.priceByProtocol[key] = priceNorm;
  } else {
    lastSeen.price = priceNorm;
  }
  const next = priceNorm * getLiqPriceMultiplierForProtocol(protocol);
  return next;
}

function applyLpTickShift(currentTick, tickLower, tickUpper) {
  if (!Number.isFinite(currentTick)) return currentTick;
  const width = Number(tickUpper) - Number(tickLower);
  if (!Number.isFinite(width) || width === 0) return currentTick;
  lastSeen.lpTick = currentTick;
  lastSeen.lpWidth = width;
  if (!Number.isFinite(state.lpRangeShiftPct) || state.lpRangeShiftPct === 0) return currentTick;
  const delta = Math.round(width * state.lpRangeShiftPct);
  return currentTick + delta;
}

function applyDebtAheadOffsetPct(debtAheadPct, protocol) {
  if (debtAheadPct == null || !Number.isFinite(debtAheadPct)) return debtAheadPct;
  const key = normalizeProtocol(protocol);
  if (key) lastSeen.debtAheadPctByProtocol[key] = debtAheadPct;
  const next = debtAheadPct + getDebtAheadOffsetPpForProtocol(protocol) / 100;
  return Math.max(0, Math.min(1, next));
}

function setDebtAheadBase(protocol, debtAheadPct, totalDebt) {
  const key = normalizeProtocol(protocol);
  if (!key) return;
  if (debtAheadPct != null && Number.isFinite(debtAheadPct)) {
    lastSeen.debtAheadPctByProtocol[key] = debtAheadPct;
  }
  if (totalDebt != null && Number.isFinite(totalDebt)) {
    lastSeen.debtTotalByProtocol[key] = totalDebt;
  }
}

function setPriceBase(protocol, priceNorm) {
  const key = normalizeProtocol(protocol);
  if (!key) return;
  if (priceNorm != null && Number.isFinite(priceNorm)) {
    lastSeen.priceByProtocol[key] = priceNorm;
  }
}

function setDebtAheadTierThresholds(lowPct, medPct, highPct) {
  const low = Number(lowPct);
  const med = Number(medPct);
  const high = Number(highPct);
  if (Number.isFinite(low)) debtAheadThresholds.low = low;
  if (Number.isFinite(med)) debtAheadThresholds.med = med;
  if (Number.isFinite(high)) debtAheadThresholds.high = high;
}

function classifyDebtAheadTier(debtAheadPct) {
  const v = Number(debtAheadPct);
  if (!Number.isFinite(v)) return "UNKNOWN";
  if (debtAheadThresholds.low == null) return "UNKNOWN";
  if (v >= debtAheadThresholds.low) return "LOW";
  if (debtAheadThresholds.med == null) return "UNKNOWN";
  if (v >= debtAheadThresholds.med) return "MEDIUM";
  if (debtAheadThresholds.high == null) return "UNKNOWN";
  if (v >= debtAheadThresholds.high) return "HIGH";
  return "CRITICAL";
}

function logRunApplied() {
  if (state.irOffsetPp !== 0 && lastSeen.globalIrPp != null) {
    const next = lastSeen.globalIrPp + state.irOffsetPp;
    logger.debug(
      `[test-alerts] Run IR applied: ${lastSeen.globalIrPp.toFixed(2)}pp -> ${next.toFixed(2)}pp`
    );
  } else if (state.irOffsetPp !== 0) {
    logger.debug(`[test-alerts] Run IR offset: ${state.irOffsetPp.toFixed(2)}pp`);
  }

  const priceEntries = Object.entries(lastSeen.priceByProtocol || {});
  if (priceEntries.length) {
    for (const [protocol, basePrice] of priceEntries) {
      if (!Number.isFinite(basePrice)) continue;
      const mult = getLiqPriceMultiplierForProtocol(protocol);
      if (mult === 1) continue;
      const next = basePrice * mult;
      logger.debug(
        `[test-alerts] Run price applied: ${protocol} ${basePrice.toFixed(4)} -> ${next.toFixed(4)}`
      );
    }
  } else if (state.liqPriceMultiplier !== 1 && lastSeen.price != null) {
    const next = lastSeen.price * state.liqPriceMultiplier;
    logger.debug(
      `[test-alerts] Run price applied: ${lastSeen.price.toFixed(4)} -> ${next.toFixed(4)}`
    );
  } else if (state.liqPriceMultiplier !== 1) {
    logger.debug(`[test-alerts] Run price multiplier: ${state.liqPriceMultiplier.toFixed(6)}x`);
  }

  if (state.lpRangeShiftPct !== 0 && lastSeen.lpTick != null && lastSeen.lpWidth != null) {
    const delta = Math.round(lastSeen.lpWidth * state.lpRangeShiftPct);
    const next = lastSeen.lpTick + delta;
    logger.debug(
      `[test-alerts] Run LP tick applied: ${lastSeen.lpTick} -> ${next} (${(state.lpRangeShiftPct * 100).toFixed(2)}% of width)`
    );
  } else if (state.lpRangeShiftPct !== 0) {
    logger.debug(
      `[test-alerts] Run LP range shift: ${(state.lpRangeShiftPct * 100).toFixed(2)}%`
    );
  }

  const debtEntries = Object.entries(lastSeen.debtAheadPctByProtocol || {});
  if (debtEntries.length) {
    const fmt = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    for (const [protocol, basePct] of debtEntries) {
      const base = Number(basePct);
      if (!Number.isFinite(base)) continue;
      const totalDebt = Number(lastSeen.debtTotalByProtocol?.[protocol]);
      const offsetPp = getDebtAheadOffsetPpForProtocol(protocol);
      const nextPct = Math.max(0, Math.min(1, base + offsetPp / 100));
      const baseTier = classifyDebtAheadTier(base);
      const nextTier = classifyDebtAheadTier(nextPct);
      const baseDebt = Number.isFinite(totalDebt) ? base * totalDebt : null;
      const nextDebt = Number.isFinite(totalDebt) ? nextPct * totalDebt : null;
      logger.debug(
        `[test-alerts] Run debt-ahead applied: ${protocol} ` +
          `(live: ${(base * 100).toFixed(2)}% (${baseTier}) -> ${(nextPct * 100).toFixed(2)}% (${nextTier})` +
          (baseDebt != null && nextDebt != null
            ? `, debt ${fmt.format(baseDebt)} -> ${fmt.format(nextDebt)}`
            : "") +
          `)`
      );
    }
  }
}

module.exports = {
  resetTestOffsets,
  getTestOffsets,
  getLastSeenBases,
  getIrOffsetPpForProtocol,
  getLiqPriceMultiplierForProtocol,
  getDebtAheadOffsetPpForProtocol,
  adjustGlobalIrOffsetPp,
  adjustLiqPriceMultiplier,
  adjustLpRangeShiftPct,
  adjustDebtAheadOffsetPp,
  applyGlobalIrOffset,
  applyPriceMultiplier,
  applyLpTickShift,
  applyDebtAheadOffsetPct,
  setDebtAheadBase,
  setPriceBase,
  setDebtAheadTierThresholds,
  classifyDebtAheadTier,
  logRunApplied,
};
