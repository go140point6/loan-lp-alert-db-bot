// monitoring/alertEngine.js
// DB-backed alert state + logging + Discord DM alerts (NEW SCHEMA)

const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");
const { getDb } = require("../db");
const { sendLongDM } = require("../utils/discord/sendLongDM");
const logger = require("../utils/logger");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");

function trendLabel(prevTier, newTier, order) {
  const p = (prevTier || "").toString().toUpperCase();
  const n = (newTier || "").toString().toUpperCase();
  const pi = order.indexOf(p);
  const ni = order.indexOf(n);
  if (pi === -1 || ni === -1 || pi === ni) return { emoji: "⚪", label: "Steady" };
  if (ni < pi) return { emoji: "🟢", label: "Improving" };
  return { emoji: "🔴", label: "Worsening" };
}

let _client = null;
function setAlertEngineClient(client) {
  _client = client;
}

function assertPresent(name, v) {
  if (v === undefined || v === null || v === "") {
    throw new Error(`[alertEngine] Missing required field: ${name}`);
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") {
    throw new Error(`[alertEngine] Missing required env var ${name}`);
  }
  return String(v).trim();
}

function requireNumberEnv(name) {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`[alertEngine] Env var ${name} must be numeric (got "${raw}")`);
  }
  return n;
}

// -----------------------------
// LP debounce/cooldown config (STRICT)
// -----------------------------
const LP_OOR_DEBOUNCE_SEC = requireNumberEnv("LP_OOR_DEBOUNCE_SEC");
const LP_IN_DEBOUNCE_SEC = requireNumberEnv("LP_IN_DEBOUNCE_SEC");
const LP_ALERT_COOLDOWN_SEC = requireNumberEnv("LP_ALERT_COOLDOWN_SEC");

const LP_OOR_DEBOUNCE_MS = Math.max(0, Math.floor(LP_OOR_DEBOUNCE_SEC * 1000));
const LP_IN_DEBOUNCE_MS = Math.max(0, Math.floor(LP_IN_DEBOUNCE_SEC * 1000));
const LP_ALERT_COOLDOWN_MS = Math.max(0, Math.floor(LP_ALERT_COOLDOWN_SEC * 1000));

// -----------------------------
// LOAN debounce/cooldown config (STRICT)
// -----------------------------
const LOAN_LIQ_DEBOUNCE_SEC = requireNumberEnv("LOAN_LIQ_DEBOUNCE_SEC");
const LOAN_LIQ_RESOLVE_DEBOUNCE_SEC = requireNumberEnv("LOAN_LIQ_RESOLVE_DEBOUNCE_SEC");
const LOAN_LIQ_ALERT_COOLDOWN_SEC = requireNumberEnv("LOAN_LIQ_ALERT_COOLDOWN_SEC");

const LOAN_REDEMP_DEBOUNCE_SEC = requireNumberEnv("LOAN_REDEMP_DEBOUNCE_SEC");
const LOAN_REDEMP_RESOLVE_DEBOUNCE_SEC = requireNumberEnv("LOAN_REDEMP_RESOLVE_DEBOUNCE_SEC");
const LOAN_REDEMP_ALERT_COOLDOWN_SEC = requireNumberEnv("LOAN_REDEMP_ALERT_COOLDOWN_SEC");

const LOAN_LIQ_DEBOUNCE_MS = Math.max(0, Math.floor(LOAN_LIQ_DEBOUNCE_SEC * 1000));
const LOAN_LIQ_RESOLVE_DEBOUNCE_MS = Math.max(
  0,
  Math.floor(LOAN_LIQ_RESOLVE_DEBOUNCE_SEC * 1000)
);
const LOAN_LIQ_ALERT_COOLDOWN_MS = Math.max(
  0,
  Math.floor(LOAN_LIQ_ALERT_COOLDOWN_SEC * 1000)
);

const LOAN_REDEMP_DEBOUNCE_MS = Math.max(0, Math.floor(LOAN_REDEMP_DEBOUNCE_SEC * 1000));
const LOAN_REDEMP_RESOLVE_DEBOUNCE_MS = Math.max(
  0,
  Math.floor(LOAN_REDEMP_RESOLVE_DEBOUNCE_SEC * 1000)
);
const LOAN_REDEMP_ALERT_COOLDOWN_MS = Math.max(
  0,
  Math.floor(LOAN_REDEMP_ALERT_COOLDOWN_SEC * 1000)
);

// -----------------------------
// Helpers
// -----------------------------

// Stable stringify to avoid phantom signature changes
function stableStringify(obj) {
  if (obj == null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj.map(stableStringify));
  const keys = Object.keys(obj).sort();
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}

function makeSignature(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function disableUserDm(userId, reason = null) {
  try {
    const db = getDb();
    db.prepare(
      `
      UPDATE users
      SET accepts_dm = 0
      WHERE id = ?
    `
    ).run(userId);

    if (reason) console.warn(`[dm] Disabled DMs for userId=${userId} (${reason})`);
    else console.warn(`[dm] Disabled DMs for userId=${userId}`);
  } catch (e) {
    console.error(`[dm] Failed to disable DMs for userId=${userId}:`, e.message);
  }
}

/**
 * Discord DM failure classifier.
 * Only disable DMs for strong signals that user can't be messaged.
 */
function shouldDisableDmForError(err) {
  const code = err?.code;
  const status = err?.status;

  // Strong Discord API signals
  if (code === 50007) return { disable: true, reason: "Cannot send messages to this user (50007)" };
  if (code === 10013) return { disable: true, reason: "Unknown user (10013)" };

  // discord.js sometimes yields REST/HTTP statuses
  if (status === 403 || status === 401) return { disable: true, reason: `HTTP ${status}` };

  const msg = String(err?.message || "").toLowerCase();

  if (msg.includes("cannot send messages to this user")) {
    return { disable: true, reason: "cannot send messages to this user" };
  }
  if (msg.includes("missing access") || msg.includes("missing permissions")) {
    return { disable: true, reason: "missing access/permissions" };
  }

  // Do NOT disable on timeouts / 5xx / rate limits
  if (msg.includes("timeout") || msg.includes("timed out")) return { disable: false, reason: null };
  if (status && status >= 500) return { disable: false, reason: null };
  if (status === 429) return { disable: false, reason: null };

  return { disable: false, reason: null };
}

function getUserDmTarget(userId) {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT discord_id, discord_name, accepts_dm
      FROM users
      WHERE id = ?
      LIMIT 1
    `
    )
    .get(userId);

  if (!row) return null;
  if (Number(row.accepts_dm) !== 1) return null;
  if (!row.discord_id) return null;

  return { discordId: row.discord_id, discordName: row.discord_name || null };
}

async function sendDmToUser({ userId, phase, alertType, logPrefix, message, meta }) {
  const target = getUserDmTarget(userId);
  if (!target) return;

  const client = _client;
  if (!client || !client.users) {
    console.error(
      `${logPrefix} [dm] Discord client not set. Call setAlertEngineClient(client) in onReady.`
    );
    return;
  }

  let user;
  try {
    user = await client.users.fetch(target.discordId);
  } catch (err) {
    console.error(`${logPrefix} [dm] Cannot fetch user ${target.discordId}:`, err?.message || err);
    const verdict = shouldDisableDmForError(err);
    if (verdict.disable) disableUserDm(userId, verdict.reason);
    return;
  }
  if (!user) return;

  try {
    if (alertType === "REDEMPTION") {
      const fmt2 = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "n/a");
      const prevTier = meta?.prevTier || "UNKNOWN";
      const newTier = meta?.newTier || "UNKNOWN";
      const trend = trendLabel(prevTier, newTier, ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
      const phaseTag =
        phase === "UPDATED"
          ? ` ${trend.emoji} ${trend.label}`
          : phase === "NEW"
          ? " ⚠️"
          : phase === "RESOLVED"
          ? " ✅"
          : "";

      const embed = new EmbedBuilder()
        .setTitle(`Redemption Alert (${phase}${phaseTag})`)
        .setDescription(message)
        .setColor(phase === "RESOLVED" ? "DarkGrey" : phase === "UPDATED" ? "Orange" : "Red")
        .setTimestamp();

      if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

      const fields = [
        { name: "Trove", value: meta?.troveId || "n/a", inline: true },
        { name: "Wallet", value: meta?.wallet || "n/a", inline: true },
      ];
      if (meta?.walletLabel) fields.push({ name: "Label", value: meta.walletLabel, inline: true });
      fields.push(
        { name: "Tier", value: `${prevTier} -> ${newTier}`, inline: false },
        { name: "Loan IR", value: `${fmt2(meta?.loanIR)}%`, inline: true },
        { name: "Global IR", value: `${fmt2(meta?.globalIR)}%`, inline: true }
      );
      embed.addFields(fields);

      await user.send({ embeds: [embed] });
      return;
    }

    if (alertType === "LIQUIDATION") {
      const fmt2 = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "n/a");
      const prevTier = meta?.prevTier || "UNKNOWN";
      const newTier = meta?.newTier || "UNKNOWN";
      const trend = trendLabel(prevTier, newTier, ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
      const phaseTag =
        phase === "UPDATED"
          ? ` ${trend.emoji} ${trend.label}`
          : phase === "NEW"
          ? " ⚠️"
          : phase === "RESOLVED"
          ? " ✅"
          : "";
      const bufferPct =
        typeof meta?.liquidationBufferFrac === "number" && Number.isFinite(meta?.liquidationBufferFrac)
          ? `${(meta.liquidationBufferFrac * 100).toFixed(2)}%`
          : "n/a";

      const embed = new EmbedBuilder()
        .setTitle(`Liquidation Alert (${phase}${phaseTag})`)
        .setDescription(message)
        .setColor(phase === "RESOLVED" ? "DarkGrey" : phase === "UPDATED" ? "Orange" : "Red")
        .setTimestamp();

      if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

      const fields = [
        { name: "Trove", value: meta?.troveId || "n/a", inline: true },
        { name: "Wallet", value: meta?.wallet || "n/a", inline: true },
      ];
      if (meta?.walletLabel) fields.push({ name: "Label", value: meta.walletLabel, inline: true });
      fields.push(
        { name: "Tier", value: `${prevTier} -> ${newTier}`, inline: false },
        { name: "LTV", value: `${fmt2(meta?.ltvPct)}%`, inline: true },
        { name: "Buffer", value: bufferPct, inline: true },
        {
          name: "Price / Liq",
          value: `${fmt2(meta?.currentPrice)} / ${fmt2(meta?.liquidationPrice)}`,
          inline: true,
        }
      );
      embed.addFields(fields);

      await user.send({ embeds: [embed] });
      return;
    }

    if (alertType === "LP_RANGE") {
      const prevTier = meta?.prevTier || "UNKNOWN";
      const newTier = meta?.newTier || "UNKNOWN";
      const prevStatus = meta?.prevStatus || "UNKNOWN";
      const currentStatus = meta?.currentStatus || "UNKNOWN";
      const trend = trendLabel(prevTier, newTier, ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
      const phaseTag =
        phase === "UPDATED"
          ? ` ${trend.emoji} ${trend.label}`
          : phase === "NEW"
          ? " ⚠️"
          : phase === "RESOLVED"
          ? " ✅"
          : "";

      const embed = new EmbedBuilder()
        .setTitle(`LP Range Alert (${phase}${phaseTag})`)
        .setDescription(message)
        .setColor(phase === "RESOLVED" ? "DarkGrey" : phase === "UPDATED" ? "Orange" : "Red")
        .setTimestamp();

      if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

      const fields = [
        { name: "Position", value: meta?.positionId || "n/a", inline: true },
        { name: "Wallet", value: meta?.wallet || "n/a", inline: true },
      ];
      if (meta?.walletLabel) fields.push({ name: "Label", value: meta.walletLabel, inline: true });
      fields.push(
        { name: "Status", value: `${prevStatus} -> ${currentStatus}`, inline: false },
        { name: "Tier", value: `${prevTier} -> ${newTier}`, inline: false }
      );
      embed.addFields(fields);

      await user.send({ embeds: [embed] });
      return;
    }

    const lines = [];
    lines.push(`${logPrefix} ${phase} ${alertType} ALERT`);
    lines.push(message);

    if (meta && Object.keys(meta).length > 0) {
      lines.push("");
      lines.push("Details:");
      for (const [k, v] of Object.entries(meta)) {
        lines.push(`• ${k}: ${v}`);
      }
    }

    await sendLongDM(user, lines.join("\n"));
  } catch (err) {
    console.error(`${logPrefix} [dm] Failed to send DM to ${target.discordId}:`, err?.message || err);
    const verdict = shouldDisableDmForError(err);
    if (verdict.disable) disableUserDm(userId, verdict.reason);
  }
}

// -----------------------------
// Structured alert state/log (NEW SCHEMA)
// -----------------------------
function getPrevState({ userId, walletId, contractId, tokenId, alertType }) {
  const db = getDb();

  const alertTypeU = (alertType || "GENERIC").toString().toUpperCase();
  const row = db
    .prepare(
      `
      SELECT is_active AS isActive, signature, state_json AS stateJson
      FROM alert_state
      WHERE user_id = ?
        AND wallet_id = ?
        AND contract_id = ?
        AND token_id = ?
        AND alert_type = ?
      LIMIT 1
    `
    )
    .get(userId, walletId, contractId, tokenId, alertTypeU);

  if (!row) return { isActive: 0, signature: null, stateJson: null, exists: false };
  return { ...row, exists: true };
}

function upsertAlertState({
  userId,
  walletId,
  contractId,
  tokenId,
  alertType,
  isActive,
  signature,
  stateJson,
}) {
  const db = getDb();
  const alertTypeU = (alertType || "GENERIC").toString().toUpperCase();

  db.prepare(
    `
    INSERT INTO alert_state (
      user_id, wallet_id, contract_id, token_id, alert_type,
      is_active, signature, state_json,
      last_seen_at, created_at
    ) VALUES (
      @userId, @walletId, @contractId, @tokenId, @alertType,
      @isActive, @signature, @stateJson,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(user_id, wallet_id, contract_id, token_id, alert_type) DO UPDATE SET
      is_active    = excluded.is_active,
      signature    = excluded.signature,
      state_json   = excluded.state_json,
      last_seen_at = datetime('now')
  `
  ).run({
    userId,
    walletId,
    contractId,
    tokenId,
    alertType: alertTypeU,
    isActive: isActive ? 1 : 0,
    signature: signature ?? null,
    stateJson: stateJson ?? null,
  });
}

function insertAlertLog({
  userId,
  walletId,
  contractId,
  tokenId,
  alertType,
  phase,
  message,
  meta,
  signature,
}) {
  const db = getDb();
  const metaJson = meta && Object.keys(meta).length ? JSON.stringify(meta) : null;

  db.prepare(
    `
    INSERT INTO alert_log (
      user_id, wallet_id, contract_id, token_id,
      alert_type, phase, message, meta_json, signature, created_at
    )
    VALUES (
      @userId, @walletId, @contractId, @tokenId,
      @alertType, @phase, @message, @metaJson, @signature, datetime('now')
    )
  `
  ).run({
    userId,
    walletId,
    contractId,
    tokenId,
    alertType,
    phase,
    message,
    metaJson,
    signature: signature ?? null,
  });
}

// -----------------------------
// Core engine
// -----------------------------
async function processAlert({
  userId,
  walletId,
  contractId,
  tokenId,

  isActive,
  signaturePayload,
  state = null,
  logPrefix,
  message,
  meta = {},
  alertType = "GENERIC",

  // allow DM on RESOLVED for LP “back in range”
  notifyOnResolved = false,
}) {
  assertPresent("userId", userId);
  assertPresent("walletId", walletId);
  assertPresent("contractId", contractId);
  assertPresent("tokenId", tokenId);

  const signature = makeSignature(signaturePayload);
  const stateJson = state && typeof state === "object" ? JSON.stringify(state) : null;

  const prev = getPrevState({ userId, walletId, contractId, tokenId, alertType });
  const prevActive = prev.isActive === 1;

  if (isActive && !prevActive) {
    console.warn(`${logPrefix} NEW ALERT: ${message}`, { ...meta });

    upsertAlertState({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      isActive: true,
      signature,
      stateJson,
    });
    insertAlertLog({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      phase: "NEW",
      message,
      meta,
      signature,
    });

    await sendDmToUser({ userId, phase: "NEW", alertType, logPrefix, message, meta });
    return;
  }

  if (isActive && prevActive && prev.signature !== signature) {
    console.warn(`${logPrefix} ALERT UPDATED: ${message}`, { ...meta });

    upsertAlertState({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      isActive: true,
      signature,
      stateJson,
    });
    insertAlertLog({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      phase: "UPDATED",
      message,
      meta,
      signature,
    });

    await sendDmToUser({ userId, phase: "UPDATED", alertType, logPrefix, message, meta });
    return;
  }

  if (isActive && prevActive && prev.signature === signature) {
    upsertAlertState({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      isActive: true,
      signature,
      stateJson,
    });
    return;
  }

  if (!isActive && prevActive) {
    console.log(`${logPrefix} RESOLVED: ${message}`, { ...meta });

    upsertAlertState({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      isActive: false,
      signature: null,
      stateJson,
    });
    insertAlertLog({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      phase: "RESOLVED",
      message,
      meta,
      signature: null,
    });

    if (notifyOnResolved) {
      await sendDmToUser({ userId, phase: "RESOLVED", alertType, logPrefix, message, meta });
    }
    return;
  }

  if (!isActive && !prevActive) {
    upsertAlertState({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      isActive: false,
      signature: null,
      stateJson,
    });
  }
}

// Small helper: coarsen a fraction into an integer bucket (prevents signature spam)
function fracBucket(x, step = 0.01) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x / step);
}

// Tier escalation helper (generic)
function isTierEscalation(prevTierU, tierU, order) {
  const p = (prevTierU || "UNKNOWN").toString().toUpperCase();
  const c = (tierU || "UNKNOWN").toString().toUpperCase();
  const pi = order.indexOf(p);
  const ci = order.indexOf(c);
  if (pi === -1 || ci === -1) return false;
  return ci > pi;
}

function normLpStatus(s) {
  const x = (s || "").toString().toUpperCase().replace(/\s+/g, "_");
  if (!x) return "UNKNOWN";
  if (x === "IN_RANGE" || x === "OUT_OF_RANGE" || x === "INACTIVE" || x === "UNKNOWN") return x;
  return x;
}

/* ---------------------------
 * Public alert handlers
 * -------------------------- */

async function handleLiquidationAlert(data) {
  const {
    userId,
    walletId,
    contractId,
    positionId,
    isActive: observedActive,
    tier,
    ltvPct,
    liquidationPrice,
    currentPrice,
    liquidationBufferFrac,
    protocol,
    wallet,
    walletLabel,
  } = data;

  const tokenId = String(positionId);
  const alertType = "LIQUIDATION";

  const nowMs = Date.now();

  let observedActiveFinal = Boolean(observedActive);
  let tierU = (tier || "UNKNOWN").toString().toUpperCase();

  const LIQ_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];

  // pull prev state
  const prev = getPrevState({ userId, walletId, contractId, tokenId, alertType });
  const prevActive = prev.isActive === 1;

  let prevObj = null;
  try {
    prevObj = prev.stateJson ? JSON.parse(prev.stateJson) : null;
  } catch (_) {
    prevObj = null;
  }

  const lastAlertAtMs = Number(prevObj?.lastAlertAtMs || 0) || 0;
  const prevTierU = (prevObj?.lastTier || "UNKNOWN").toString().toUpperCase();

  let cand = prevObj?.candidateStatus ? String(prevObj.candidateStatus) : null;
  let candSinceMs = Number(prevObj?.candidateSinceMs || 0) || 0;

  const sigPayload = {
    tier: tierU,
    bufB: fracBucket(liquidationBufferFrac, 0.01),
  };

  const baseState = {
    kind: "LOAN",
    tier: tierU,
    ltvPct,
    liquidationPrice,
    currentPrice,
    liquidationBufferFrac,
  };

  // Active condition is "liquidation risk tier >= min tier" as decided by caller (or overridden).
  if (observedActiveFinal) {
    // Debounce ON: if not already active, require sustained
    if (!prevActive) {
      if (cand !== "ON") {
        cand = "ON";
        candSinceMs = nowMs;
      }

      const age = nowMs - candSinceMs;
      if (age < LOAN_LIQ_DEBOUNCE_MS) {
        await processAlert({
          userId,
          walletId,
          contractId,
          tokenId,
          isActive: false,
          signaturePayload: { pending: true, kind: "LIQ_ON" },
          state: {
            ...baseState,
            confirmedStatus: "OFF",
            candidateStatus: "ON",
            candidateSinceMs: candSinceMs,
            lastAlertAtMs,
            lastTier: prevTierU,
          },
          logPrefix: "[LIQ]",
          message: `Loan pending liquidation debounce ${protocol}`,
          meta: {
            wallet: shortenAddress(wallet),
            walletLabel,
            troveId: shortenTroveId(tokenId),
            prevTier: prevTierU,
            newTier: tierU,
            ltvPct,
            liquidationPrice,
            currentPrice,
            liquidationBufferFrac,
          },
          alertType,
        });
        return;
      }

      if (!prev.exists) {
        const signature = makeSignature(sigPayload);
        upsertAlertState({
          userId,
          walletId,
          contractId,
          tokenId,
          alertType,
          isActive: true,
          signature,
          stateJson: JSON.stringify({
            ...baseState,
            confirmedStatus: "ON",
            candidateStatus: null,
            candidateSinceMs: 0,
            lastAlertAtMs: nowMs,
            lastTier: tierU,
          }),
        });
        return;
      }

      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: true,
        signaturePayload: sigPayload,
        state: {
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: null,
          candidateSinceMs: 0,
          lastAlertAtMs: nowMs,
          lastTier: tierU,
        },
        logPrefix: "[LIQ]",
        message: `Loan at risk of liquidation ${protocol}`,
        meta: {
          wallet: shortenAddress(wallet),
            walletLabel,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          ltvPct,
          liquidationPrice,
          currentPrice,
          liquidationBufferFrac,
        },
        alertType,
      });
      return;
    }

    // prevActive=true: keep active, but suppress noisy UPDATEDs during cooldown unless escalation
    const signature = makeSignature(sigPayload);
    const wouldUpdate = prev.signature !== signature;

    const cooldownOk = nowMs - lastAlertAtMs >= LOAN_LIQ_ALERT_COOLDOWN_MS;
    const escalated = isTierEscalation(prevTierU, tierU, LIQ_TIER_ORDER);

    const tierChanged = prevTierU !== tierU;
    const allowNotifyUpdate = wouldUpdate && (cooldownOk || escalated) && tierChanged;
    const newLastAlertAtMs = allowNotifyUpdate ? nowMs : lastAlertAtMs;

    if (!wouldUpdate) {
      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: true,
        signaturePayload: sigPayload,
        state: {
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: null,
          candidateSinceMs: 0,
          lastAlertAtMs: newLastAlertAtMs,
          lastTier: tierU,
        },
        logPrefix: "[LIQ]",
        message: `Loan at risk of liquidation ${protocol}`,
        meta: {
          wallet: shortenAddress(wallet),
            walletLabel,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          ltvPct,
          liquidationPrice,
          currentPrice,
          liquidationBufferFrac,
        },
        alertType,
      });
      return;
    }

    if (!allowNotifyUpdate) {
      upsertAlertState({
        userId,
        walletId,
        contractId,
        tokenId,
        alertType,
        isActive: true,
        signature,
        stateJson: JSON.stringify({
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: null,
          candidateSinceMs: 0,
          lastAlertAtMs: newLastAlertAtMs,
          lastTier: tierU,
        }),
      });
      return;
    }

    await processAlert({
      userId,
      walletId,
      contractId,
      tokenId,
      isActive: true,
      signaturePayload: sigPayload,
      state: {
        ...baseState,
        confirmedStatus: "ON",
        candidateStatus: null,
        candidateSinceMs: 0,
        lastAlertAtMs: newLastAlertAtMs,
        lastTier: tierU,
      },
      logPrefix: "[LIQ]",
      message: `Loan at risk of liquidation ${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
            walletLabel,
        troveId: shortenTroveId(tokenId),
        prevTier: prevTierU,
        newTier: tierU,
        ltvPct,
        liquidationPrice,
        currentPrice,
        liquidationBufferFrac,
      },
      alertType,
    });
    return;
  }

  // observedActiveFinal=false
  if (prevActive) {
    // Debounce OFF: require sustained safe before resolve
    if (cand !== "OFF") {
      cand = "OFF";
      candSinceMs = nowMs;
    }

    const age = nowMs - candSinceMs;
    if (age < LOAN_LIQ_RESOLVE_DEBOUNCE_MS) {
      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: true,
        signaturePayload: { keep: true },
        state: {
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: "OFF",
          candidateSinceMs: candSinceMs,
          lastAlertAtMs,
          lastTier: prevTierU,
        },
        logPrefix: "[LIQ]",
        message: `Loan pending liquidation resolve debounce ${protocol}`,
        meta: {
          wallet: shortenAddress(wallet),
            walletLabel,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          ltvPct,
          liquidationPrice,
          currentPrice,
          liquidationBufferFrac,
        },
        alertType,
      });
      return;
    }

    await processAlert({
      userId,
      walletId,
      contractId,
      tokenId,
      isActive: false,
      signaturePayload: { resolved: true, kind: "LIQ" },
      state: {
        ...baseState,
        confirmedStatus: "OFF",
        candidateStatus: null,
        candidateSinceMs: 0,
        lastAlertAtMs,
        lastTier: prevTierU,
      },
      logPrefix: "[LIQ]",
      message: `Loan liquidation risk cleared ${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
            walletLabel,
        troveId: shortenTroveId(tokenId),
        prevTier: prevTierU,
        newTier: tierU,
        ltvPct,
        liquidationPrice,
        currentPrice,
        liquidationBufferFrac,
      },
      alertType,
      notifyOnResolved: false,
    });
    return;
  }

  await processAlert({
    userId,
    walletId,
    contractId,
    tokenId,
    isActive: false,
    signaturePayload: { steady: true, kind: "LIQ" },
    state: {
      ...baseState,
      confirmedStatus: "OFF",
      candidateStatus: null,
      candidateSinceMs: 0,
      lastAlertAtMs,
      lastTier: tierU,
    },
    logPrefix: "[LIQ]",
    message: `Loan liquidation steady ${protocol}`,
    meta: {
      wallet: shortenAddress(wallet),
            walletLabel,
      troveId: shortenTroveId(tokenId),
      prevTier: prevTierU,
      newTier: tierU,
      ltvPct,
      liquidationPrice,
      currentPrice,
      liquidationBufferFrac,
    },
    alertType,
  });
}

async function handleRedemptionAlert(data) {
  const {
    userId,
    walletId,
    contractId,
    positionId,
    isActive: observedActive,
    tier,
    cdpIR,
    globalIR,
    isCDPActive,
    protocol,
    wallet,
    walletLabel,
  } = data;

  const tokenId = String(positionId);
  const alertType = "REDEMPTION";

  const nowMs = Date.now();

  let observedActiveFinal = Boolean(observedActive);
  let tierU = (tier || "UNKNOWN").toString().toUpperCase();

  const REDEMP_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];

  // pull prev state
  const prev = getPrevState({ userId, walletId, contractId, tokenId, alertType });
  const prevActive = prev.isActive === 1;

  let prevObj = null;
  try {
    prevObj = prev.stateJson ? JSON.parse(prev.stateJson) : null;
  } catch (_) {
    prevObj = null;
  }

  const lastAlertAtMs = Number(prevObj?.lastAlertAtMs || 0) || 0;
  const prevTierU = (prevObj?.lastTier || "UNKNOWN").toString().toUpperCase();

  let cand = prevObj?.candidateStatus ? String(prevObj.candidateStatus) : null;
  let candSinceMs = Number(prevObj?.candidateSinceMs || 0) || 0;
  let candTier = prevObj?.candidateTier ? String(prevObj.candidateTier) : null;
  let candTierSinceMs = Number(prevObj?.candidateTierSinceMs || 0) || 0;

  const diff = typeof cdpIR === "number" && typeof globalIR === "number" ? cdpIR - globalIR : null;

  const sigPayload = {
    tier: tierU,
    isCDPActive: Boolean(isCDPActive),
    diffB: diff == null || !Number.isFinite(diff) ? null : Math.round(diff * 2),
  };

  const baseState = { kind: "LOAN", tier: tierU, cdpIR, globalIR, isCDPActive };

  if (observedActiveFinal) {
    if (!prevActive) {
      if (cand !== "ON") {
        cand = "ON";
        candSinceMs = nowMs;
      }

      const age = nowMs - candSinceMs;
      if (age < LOAN_REDEMP_DEBOUNCE_MS) {
        await processAlert({
          userId,
          walletId,
          contractId,
          tokenId,
          isActive: false,
          signaturePayload: { pending: true, kind: "REDEMP_ON" },
          state: {
            ...baseState,
            confirmedStatus: "OFF",
            candidateStatus: "ON",
            candidateSinceMs: candSinceMs,
            candidateTier: null,
            candidateTierSinceMs: 0,
            lastAlertAtMs,
            lastTier: prevTierU,
          },
          logPrefix: "[REDEMP]",
          message: `Redemption pending debounce ${protocol}`,
          meta: {
            wallet: shortenAddress(wallet),
            walletLabel,
            troveId: shortenTroveId(tokenId),
            prevTier: prevTierU,
            newTier: tierU,
            loanIR: cdpIR,
            globalIR,
          },
          alertType,
        });
        return;
      }

      if (!prev.exists) {
        const signature = makeSignature(sigPayload);
        upsertAlertState({
          userId,
          walletId,
          contractId,
          tokenId,
          alertType,
          isActive: true,
          signature,
          stateJson: JSON.stringify({
            ...baseState,
            confirmedStatus: "ON",
            candidateStatus: null,
            candidateSinceMs: 0,
            candidateTier: null,
            candidateTierSinceMs: 0,
            lastAlertAtMs: nowMs,
            lastTier: tierU,
          }),
        });
        return;
      }

      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: true,
        signaturePayload: sigPayload,
        state: {
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: null,
          candidateSinceMs: 0,
          candidateTier: null,
          candidateTierSinceMs: 0,
          lastAlertAtMs: nowMs,
          lastTier: tierU,
        },
        logPrefix: "[REDEMP]",
        message: `CDP redemption candidate ${protocol}`,
        meta: {
          wallet: shortenAddress(wallet),
            walletLabel,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          loanIR: cdpIR,
          globalIR,
        },
        alertType,
      });
      return;
    }

    const immediateCritical = tierU === "CRITICAL" && prevTierU !== "CRITICAL";

    if (tierU !== prevTierU && !immediateCritical) {
      if ((candTier || "").toUpperCase() !== tierU) {
        candTier = tierU;
        candTierSinceMs = nowMs;
      }

      const age = nowMs - candTierSinceMs;
      if (age < LOAN_REDEMP_DEBOUNCE_MS) {
        upsertAlertState({
          userId,
          walletId,
          contractId,
          tokenId,
          alertType,
          isActive: true,
          signature: prev.signature,
          stateJson: JSON.stringify({
            ...baseState,
            confirmedStatus: "ON",
            candidateStatus: null,
            candidateSinceMs: 0,
            candidateTier: candTier,
            candidateTierSinceMs: candTierSinceMs,
            lastAlertAtMs,
            lastTier: prevTierU,
          }),
        });
        return;
      }
    }

    const signature = makeSignature(sigPayload);
    const wouldUpdate = prev.signature !== signature;

    const cooldownOk = nowMs - lastAlertAtMs >= LOAN_REDEMP_ALERT_COOLDOWN_MS;
    const escalated = isTierEscalation(prevTierU, tierU, REDEMP_TIER_ORDER);

    const tierChanged = prevTierU !== tierU;
    const allowNotifyUpdate =
      immediateCritical || (wouldUpdate && (cooldownOk || escalated) && tierChanged);
    const newLastAlertAtMs = allowNotifyUpdate ? nowMs : lastAlertAtMs;

    if (!wouldUpdate) {
      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: true,
        signaturePayload: sigPayload,
        state: {
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: null,
          candidateSinceMs: 0,
          candidateTier: null,
          candidateTierSinceMs: 0,
          lastAlertAtMs: newLastAlertAtMs,
          lastTier: tierU,
        },
        logPrefix: "[REDEMP]",
        message: `CDP redemption candidate ${protocol}`,
        meta: {
          wallet: shortenAddress(wallet),
            walletLabel,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          loanIR: cdpIR,
          globalIR,
        },
        alertType,
      });
      return;
    }

    if (!allowNotifyUpdate) {
      upsertAlertState({
        userId,
        walletId,
        contractId,
        tokenId,
        alertType,
        isActive: true,
        signature,
        stateJson: JSON.stringify({
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: null,
          candidateSinceMs: 0,
          candidateTier: null,
          candidateTierSinceMs: 0,
          lastAlertAtMs: newLastAlertAtMs,
          lastTier: tierU,
        }),
      });
      return;
    }

    await processAlert({
      userId,
      walletId,
      contractId,
      tokenId,
      isActive: true,
      signaturePayload: sigPayload,
      state: {
        ...baseState,
        confirmedStatus: "ON",
        candidateStatus: null,
        candidateSinceMs: 0,
        candidateTier: null,
        candidateTierSinceMs: 0,
        lastAlertAtMs: newLastAlertAtMs,
        lastTier: tierU,
      },
      logPrefix: "[REDEMP]",
      message: `CDP redemption candidate ${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
            walletLabel,
        troveId: shortenTroveId(tokenId),
        prevTier: prevTierU,
        newTier: tierU,
        loanIR: cdpIR,
        globalIR,
      },
      alertType,
    });
    return;
  }

  if (prevActive) {
    if (cand !== "OFF") {
      cand = "OFF";
      candSinceMs = nowMs;
    }

    const age = nowMs - candSinceMs;
    if (age < LOAN_REDEMP_RESOLVE_DEBOUNCE_MS) {
      upsertAlertState({
        userId,
        walletId,
        contractId,
        tokenId,
        alertType,
        isActive: true,
        signature: prev.signature,
        stateJson: JSON.stringify({
          ...baseState,
          confirmedStatus: "ON",
          candidateStatus: "OFF",
          candidateSinceMs: candSinceMs,
          candidateTier: null,
          candidateTierSinceMs: 0,
          lastAlertAtMs,
          lastTier: prevTierU,
        }),
      });
      return;
    }

    const cooldownOk = nowMs - lastAlertAtMs >= LOAN_REDEMP_ALERT_COOLDOWN_MS;
    const allowResolveNotify = cooldownOk && Number.isFinite(globalIR);

    await processAlert({
      userId,
      walletId,
      contractId,
      tokenId,
      isActive: false,
      signaturePayload: { resolved: true, kind: "REDEMP" },
      state: {
        ...baseState,
        confirmedStatus: "OFF",
        candidateStatus: null,
        candidateSinceMs: 0,
        candidateTier: null,
        candidateTierSinceMs: 0,
        lastAlertAtMs,
        lastTier: prevTierU,
      },
      logPrefix: "[REDEMP]",
      message: `CDP redemption no longer economically attractive ${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
            walletLabel,
        troveId: shortenTroveId(tokenId),
        prevTier: prevTierU,
        newTier: tierU,
        loanIR: cdpIR,
        globalIR,
      },
      alertType,
      notifyOnResolved: allowResolveNotify,
    });
    return;
  }

  await processAlert({
    userId,
    walletId,
    contractId,
    tokenId,
    isActive: false,
    signaturePayload: { steady: true, kind: "REDEMP" },
    state: {
      ...baseState,
      confirmedStatus: "OFF",
      candidateStatus: null,
      candidateSinceMs: 0,
      candidateTier: null,
      candidateTierSinceMs: 0,
      lastAlertAtMs,
      lastTier: tierU,
    },
    logPrefix: "[REDEMP]",
    message: `Redemption steady ${protocol}`,
    meta: {
      wallet: shortenAddress(wallet),
            walletLabel,
      troveId: shortenTroveId(tokenId),
      prevTier: prevTierU,
      newTier: tierU,
      loanIR: cdpIR,
      globalIR,
    },
    alertType,
  });
}

async function handleLpRangeAlert(data) {
  const {
    userId,
    walletId,
    contractId,
    positionId,

    prevStatus,
    currentStatus,

    isActive: observedActive,

    lpRangeTier,
    tickLower,
    tickUpper,
    currentTick,
    protocol,
    wallet,
    walletLabel,
  } = data;

  const tokenId = String(positionId);
  const alertType = "LP_RANGE";

  const nowMs = Date.now();

  let currStatus = normLpStatus(currentStatus);
  let tierU = (lpRangeTier || "UNKNOWN").toString().toUpperCase();
  let observedActiveFinal = Boolean(observedActive);

  const prev = getPrevState({ userId, walletId, contractId, tokenId, alertType });
  const prevActive = prev.isActive === 1;

  let prevObj = null;
  try {
    prevObj = prev.stateJson ? JSON.parse(prev.stateJson) : null;
  } catch (_) {
    prevObj = null;
  }

  const lastAlertAtMs = Number(prevObj?.lastAlertAtMs || 0) || 0;
  const prevTierU = (prevObj?.lastTier || "UNKNOWN").toString().toUpperCase();

  let candidateStatus = prevObj?.candidateStatus ? normLpStatus(prevObj.candidateStatus) : null;
  let candidateSinceMs = Number(prevObj?.candidateSinceMs || 0) || 0;

  if (observedActiveFinal) {
    if (!prevActive) {
      if (candidateStatus !== "OUT_OF_RANGE") {
        candidateStatus = "OUT_OF_RANGE";
        candidateSinceMs = nowMs;
      }

      const age = nowMs - candidateSinceMs;
      if (age >= LP_OOR_DEBOUNCE_MS) {
        const sigPayload = {
          currentStatus: "OUT_OF_RANGE",
          lpRangeTier: tierU,
        };
        const signature = makeSignature(sigPayload);
        const wouldNotify = !prevActive || prev.signature !== signature;

        const message = `LP is OUT OF RANGE ${protocol}`;
        const newLastAlertAtMs = wouldNotify ? nowMs : lastAlertAtMs;

        if (!prev.exists) {
          upsertAlertState({
            userId,
            walletId,
            contractId,
            tokenId,
            alertType,
            isActive: true,
            signature,
            stateJson: JSON.stringify({
              kind: "LP",
              rangeStatus: "OUT_OF_RANGE",
              confirmedStatus: "OUT_OF_RANGE",
              candidateStatus: null,
              candidateSinceMs: 0,
              lastAlertAtMs: newLastAlertAtMs,
              lastTier: tierU,
            }),
          });
          return;
        }

        await processAlert({
          userId,
          walletId,
          contractId,
          tokenId,
          isActive: true,
          signaturePayload: sigPayload,
          state: {
            kind: "LP",
            rangeStatus: "OUT_OF_RANGE",
            confirmedStatus: "OUT_OF_RANGE",
            candidateStatus: null,
            candidateSinceMs: 0,
            lastAlertAtMs: newLastAlertAtMs,
            lastTier: tierU,
          },
          logPrefix: "[LP]",
          message,
          meta: {
            positionId: shortenTroveId(tokenId),
            wallet: shortenAddress(wallet),
            walletLabel,
            prevStatus,
            currentStatus: "OUT_OF_RANGE",
            prevTier: prevTierU,
            newTier: tierU,
            lpRangeTier: tierU,
          },
          alertType,
          notifyOnResolved: true,
        });

        return;
      }

      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: false,
        signaturePayload: { pending: true },
        state: {
          kind: "LP",
          rangeStatus: currStatus,
          confirmedStatus: prevObj?.confirmedStatus || (prevActive ? "OUT_OF_RANGE" : "UNKNOWN"),
          candidateStatus: "OUT_OF_RANGE",
          candidateSinceMs,
          lastAlertAtMs,
          lastTier: prevTierU,
        },
        logPrefix: "[LP]",
        message: `LP pending OUT_OF_RANGE debounce ${protocol}`,
        meta: {
          positionId: shortenTroveId(tokenId),
          wallet: shortenAddress(wallet),
            walletLabel,
          prevStatus,
          currentStatus: currStatus,
          prevTier: prevTierU,
          newTier: tierU,
          lpRangeTier: tierU,
        },
        alertType,
        notifyOnResolved: true,
      });

      return;
    }

    const sigPayload = {
      currentStatus: "OUT_OF_RANGE",
      lpRangeTier: tierU,
    };
    const signature = makeSignature(sigPayload);
    const wouldNotify = prevActive && prev.signature !== signature;

    const LP_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];
    const escalated = isTierEscalation(prevTierU, tierU, LP_TIER_ORDER);

    const cooldownOk = nowMs - lastAlertAtMs >= LP_ALERT_COOLDOWN_MS;
    const tierChanged = prevTierU !== tierU;
    const statusChanged = prevObj?.confirmedStatus && prevObj.confirmedStatus !== "OUT_OF_RANGE";
    const allowUpdateNotify =
      wouldNotify && (cooldownOk || escalated) && (tierChanged || statusChanged);

    const message = `LP is OUT OF RANGE ${protocol}`;
    const newLastAlertAtMs = allowUpdateNotify ? nowMs : lastAlertAtMs;

    if (!wouldNotify) {
      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: true,
        signaturePayload: sigPayload,
        state: {
          kind: "LP",
          rangeStatus: "OUT_OF_RANGE",
          confirmedStatus: "OUT_OF_RANGE",
          candidateStatus: null,
          candidateSinceMs: 0,
          lastAlertAtMs: newLastAlertAtMs,
          lastTier: tierU,
        },
        logPrefix: "[LP]",
        message,
        meta: {
          positionId: shortenTroveId(tokenId),
          wallet: shortenAddress(wallet),
            walletLabel,
          prevStatus,
          currentStatus: "OUT_OF_RANGE",
          prevTier: prevTierU,
          newTier: tierU,
          lpRangeTier: tierU,
        },
        alertType,
        notifyOnResolved: true,
      });
      return;
    }

    if (!allowUpdateNotify) {
      upsertAlertState({
        userId,
        walletId,
        contractId,
        tokenId,
        alertType,
        isActive: true,
        signature,
        stateJson: JSON.stringify({
          kind: "LP",
          rangeStatus: "OUT_OF_RANGE",
          confirmedStatus: "OUT_OF_RANGE",
          candidateStatus: null,
          candidateSinceMs: 0,
          lastAlertAtMs: newLastAlertAtMs,
          lastTier: tierU,
        }),
      });
      return;
    }

    await processAlert({
      userId,
      walletId,
      contractId,
      tokenId,
      isActive: true,
      signaturePayload: sigPayload,
      state: {
        kind: "LP",
        rangeStatus: "OUT_OF_RANGE",
        confirmedStatus: "OUT_OF_RANGE",
        candidateStatus: null,
        candidateSinceMs: 0,
        lastAlertAtMs: newLastAlertAtMs,
        lastTier: tierU,
      },
      logPrefix: "[LP]",
      message,
        meta: {
          positionId: shortenTroveId(tokenId),
          wallet: shortenAddress(wallet),
            walletLabel,
          prevStatus,
          currentStatus: "OUT_OF_RANGE",
        prevTier: prevTierU,
        newTier: tierU,
        lpRangeTier: tierU,
      },
      alertType,
      notifyOnResolved: true,
    });

    return;
  }

  if (prevActive) {
    const desired = currStatus === "INACTIVE" ? "INACTIVE" : "IN_RANGE";

    if (candidateStatus !== desired) {
      candidateStatus = desired;
      candidateSinceMs = nowMs;
    }

    const age = nowMs - candidateSinceMs;
    if (age >= LP_IN_DEBOUNCE_MS) {
      const cooldownOk = nowMs - lastAlertAtMs >= LP_ALERT_COOLDOWN_MS;

      const message =
        desired === "INACTIVE" ? `LP is now INACTIVE ${protocol}` : `LP is back IN RANGE ${protocol}`;

      await processAlert({
        userId,
        walletId,
        contractId,
        tokenId,
        isActive: false,
        signaturePayload: { resolved: true },
        state: {
          kind: "LP",
          rangeStatus: desired === "INACTIVE" ? "INACTIVE" : "IN_RANGE",
          confirmedStatus: desired,
          candidateStatus: null,
          candidateSinceMs: 0,
          lastAlertAtMs,
          lastTier: prevTierU,
        },
        logPrefix: "[LP]",
        message,
        meta: {
          positionId: shortenTroveId(tokenId),
          wallet: shortenAddress(wallet),
            walletLabel,
          prevStatus,
          currentStatus: currStatus,
          prevTier: prevTierU,
          newTier: tierU,
          lpRangeTier: tierU,
        },
        alertType,
        notifyOnResolved: cooldownOk,
      });

      return;
    }

    await processAlert({
      userId,
      walletId,
      contractId,
      tokenId,
      isActive: true,
      signaturePayload: {
        currentStatus: "OUT_OF_RANGE",
        lpRangeTier: prevTierU || "UNKNOWN",
      },
      state: {
        kind: "LP",
        rangeStatus: "OUT_OF_RANGE",
        confirmedStatus: "OUT_OF_RANGE",
        candidateStatus,
        candidateSinceMs,
        lastAlertAtMs,
        lastTier: prevTierU,
      },
      logPrefix: "[LP]",
      message: `LP pending IN_RANGE debounce ${protocol}`,
      meta: {
        positionId: shortenTroveId(tokenId),
        wallet: shortenAddress(wallet),
            walletLabel,
        prevStatus,
        currentStatus: currStatus,
        prevTier: prevTierU,
        newTier: tierU,
        lpRangeTier: tierU,
      },
      alertType,
      notifyOnResolved: true,
    });

    return;
  }

  await processAlert({
    userId,
    walletId,
    contractId,
    tokenId,
    isActive: false,
    signaturePayload: { steady: true },
    state: {
      kind: "LP",
      rangeStatus: currStatus,
      confirmedStatus: currStatus,
      candidateStatus: null,
      candidateSinceMs: 0,
      lastAlertAtMs,
      lastTier: tierU,
    },
    logPrefix: "[LP]",
    message: `LP steady ${protocol}`,
    meta: {
      positionId: shortenTroveId(tokenId),
      wallet: shortenAddress(wallet),
            walletLabel,
      prevStatus,
      currentStatus: currStatus,
      prevTier: prevTierU,
      newTier: tierU,
      lpRangeTier: tierU,
    },
    alertType,
    notifyOnResolved: true,
  });
}

module.exports = {
  setAlertEngineClient,
  handleLiquidationAlert,
  handleRedemptionAlert,
  handleLpRangeAlert,
};
