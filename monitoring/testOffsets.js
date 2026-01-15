// monitoring/testOffsets.js
// In-memory offsets for testing alerts; resets on process restart.

const logger = require("../utils/logger");

const state = {
  irOffsetPp: 0, // additive percentage-points to global IR
  liqPriceMultiplier: 1, // multiplicative on price (e.g., 0.98 for -2%)
  lpRangeShiftPct: 0, // fraction of position width (e.g., 0.25 = 25%)
};

const lastSeen = {
  globalIrPp: null,
  price: null,
  lpTick: null,
  lpWidth: null,
};

function resetTestOffsets() {
  state.irOffsetPp = 0;
  state.liqPriceMultiplier = 1;
  state.lpRangeShiftPct = 0;
}

function getTestOffsets() {
  return { ...state };
}

function getLastSeenBases() {
  return { ...lastSeen };
}

function adjustGlobalIrOffsetPp(deltaPp) {
  const n = Number(deltaPp);
  if (!Number.isFinite(n)) return;
  state.irOffsetPp += n;
}

function adjustLiqPriceMultiplier(factor) {
  const n = Number(factor);
  if (!Number.isFinite(n) || n <= 0) return;
  state.liqPriceMultiplier *= n;
}

function adjustLpRangeShiftPct(deltaPct) {
  const n = Number(deltaPct);
  if (!Number.isFinite(n)) return;
  state.lpRangeShiftPct += n;
}

function applyGlobalIrOffset(globalIrPct) {
  if (globalIrPct == null || !Number.isFinite(globalIrPct)) return globalIrPct;
  lastSeen.globalIrPp = globalIrPct;
  const next = globalIrPct + state.irOffsetPp;
  return next;
}

function applyPriceMultiplier(priceNorm) {
  if (priceNorm == null || !Number.isFinite(priceNorm)) return priceNorm;
  lastSeen.price = priceNorm;
  const next = priceNorm * state.liqPriceMultiplier;
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

function logRunApplied() {
  if (state.irOffsetPp !== 0 && lastSeen.globalIrPp != null) {
    const next = lastSeen.globalIrPp + state.irOffsetPp;
    logger.debug(
      `[test-alerts] Run IR applied: ${lastSeen.globalIrPp.toFixed(2)}pp -> ${next.toFixed(2)}pp`
    );
  } else if (state.irOffsetPp !== 0) {
    logger.debug(`[test-alerts] Run IR offset: ${state.irOffsetPp.toFixed(2)}pp`);
  }

  if (state.liqPriceMultiplier !== 1 && lastSeen.price != null) {
    const next = lastSeen.price * state.liqPriceMultiplier;
    logger.debug(
      `[test-alerts] Run price applied: ${lastSeen.price.toFixed(2)} -> ${next.toFixed(2)}`
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
}

module.exports = {
  resetTestOffsets,
  getTestOffsets,
  getLastSeenBases,
  adjustGlobalIrOffsetPp,
  adjustLiqPriceMultiplier,
  adjustLpRangeShiftPct,
  applyGlobalIrOffset,
  applyPriceMultiplier,
  applyLpTickShift,
  logRunApplied,
};
