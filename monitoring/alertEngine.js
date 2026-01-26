// monitoring/alertEngine.js
// DB-backed alert state + logging + Discord DM alerts (NEW SCHEMA)

const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");
const { getDb } = require("../db");
const { sendLongDM } = require("../utils/discord/sendLongDM");
const logger = require("../utils/logger");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");
const { formatAddressLink, formatLpPositionLink, formatLoanTroveLink } = require("../utils/links");

function trendLabel(prevTier, newTier, order) {
  const p = (prevTier || "").toString().toUpperCase();
  const n = (newTier || "").toString().toUpperCase();
  const pi = order.indexOf(p);
  const ni = order.indexOf(n);
  if (pi === -1 || ni === -1 || pi === ni) return { emoji: "⚪", label: "Steady" };
  if (ni < pi) return { emoji: "🟢", label: "Improving" };
  return { emoji: "🔴", label: "Worsening" };
}

function formatTierList(currentTier) {
  const tierEmoji = (t) =>
    ({
      CRITICAL: "🟥",
      HIGH: "🟧",
      MEDIUM: "🟨",
      LOW: "🟩",
      UNKNOWN: "⬜",
    }[t] || "⬜");
  const order = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const tierU = (currentTier || "UNKNOWN").toString().toUpperCase();
  return order
    .map((t) => `${tierEmoji(t)} ${t}${t === tierU ? " ◀" : ""}`)
    .join("\n");
}

function renderPositionBar(pct) {
  if (pct == null || !Number.isFinite(pct)) return "0% |---------------------| 100%";
  const barLen = 21;
  const idx = Math.max(0, Math.min(barLen, Math.round(pct * barLen)));
  const left = "-".repeat(idx);
  const right = "-".repeat(barLen - idx);
  return `0% |${left}o${right}| 100%`;
}

function formatSnapshotLine(snapshotAt) {
  if (!snapshotAt) return null;
  const raw = String(snapshotAt);
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const tsMs = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (!Number.isFinite(tsMs)) return null;
  const ts = Math.floor(tsMs / 1000);
  const stale = Date.now() - tsMs > SNAPSHOT_STALE_WARN_MS;
  const warn = stale ? " ⚠️ Data may be stale." : "";
  return `<t:${ts}:f>${warn}`;
}

function redemptionMeaning(tier, aheadPctText) {
  const t = (tier || "UNKNOWN").toString().toUpperCase();
  const aheadSuffix = aheadPctText ? ` with ${aheadPctText} of total loan debt in front of it.` : ".";
  if (t === "LOW") return `Your loan is comfortably safe from redemption${aheadSuffix}`;
  if (t === "MEDIUM") return `Your loan is safe, but at slight risk of redemption${aheadSuffix}`;
  if (t === "HIGH") return `Your loan is at elevated risk of redemption${aheadSuffix}`;
  if (t === "CRITICAL") return `Your loan is at severe risk of redemption${aheadSuffix}`;
  return "Redemption risk is unknown.";
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

const SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("SNAPSHOT_STALE_WARN_MIN");
const SNAPSHOT_STALE_WARN_MS = Math.max(0, Math.floor(SNAPSHOT_STALE_WARN_MIN * 60 * 1000));

// -----------------------------
// LP debounce/cooldown config (STRICT)
// -----------------------------
const LP_WORSENING_DEBOUNCE_SEC = requireNumberEnv("LP_WORSENING_DEBOUNCE_SEC");
const LP_IMPROVING_DEBOUNCE_SEC = requireNumberEnv("LP_IMPROVING_DEBOUNCE_SEC");

const LP_WORSENING_DEBOUNCE_MS = Math.max(0, Math.floor(LP_WORSENING_DEBOUNCE_SEC * 1000));
const LP_IMPROVING_DEBOUNCE_MS = Math.max(0, Math.floor(LP_IMPROVING_DEBOUNCE_SEC * 1000));

// -----------------------------
// LOAN debounce/cooldown config (STRICT)
// -----------------------------
const LOAN_LIQ_WORSENING_DEBOUNCE_SEC = requireNumberEnv("LOAN_LIQ_WORSENING_DEBOUNCE_SEC");
const LOAN_LIQ_IMPROVING_DEBOUNCE_SEC = requireNumberEnv("LOAN_LIQ_IMPROVING_DEBOUNCE_SEC");

const LOAN_REDEMP_WORSENING_DEBOUNCE_SEC = requireNumberEnv("LOAN_REDEMP_WORSENING_DEBOUNCE_SEC");
const LOAN_REDEMP_IMPROVING_DEBOUNCE_SEC = requireNumberEnv("LOAN_REDEMP_IMPROVING_DEBOUNCE_SEC");

const LOAN_LIQ_WORSENING_DEBOUNCE_MS = Math.max(
  0,
  Math.floor(LOAN_LIQ_WORSENING_DEBOUNCE_SEC * 1000)
);
const LOAN_LIQ_IMPROVING_DEBOUNCE_MS = Math.max(
  0,
  Math.floor(LOAN_LIQ_IMPROVING_DEBOUNCE_SEC * 1000)
);

const LOAN_REDEMP_WORSENING_DEBOUNCE_MS = Math.max(
  0,
  Math.floor(LOAN_REDEMP_WORSENING_DEBOUNCE_SEC * 1000)
);
const LOAN_REDEMP_IMPROVING_DEBOUNCE_MS = Math.max(
  0,
  Math.floor(LOAN_REDEMP_IMPROVING_DEBOUNCE_SEC * 1000)
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
      if (phase === "NEW" || phase === "RESOLVED") return;
      const fmt2 = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "n/a");
      const fmt2c = (v) =>
        typeof v === "number" && Number.isFinite(v)
          ? new Intl.NumberFormat("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(v)
          : "n/a";
      const prevTier = meta?.prevTier || "UNKNOWN";
      const newTier = meta?.newTier || "UNKNOWN";
      const trend = trendLabel(prevTier, newTier, ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
      const headline =
        trend.label === "Improving"
          ? { text: "Improving", emoji: "🟢" }
          : trend.label === "Worsening"
          ? { text: "Worsening", emoji: "🔴" }
          : { text: "Updated", emoji: "⚪" };
      const alertColor =
        headline.text === "Improving"
          ? "Green"
          : headline.text === "Worsening"
          ? "Red"
          : "Grey";

      const embed = new EmbedBuilder()
        .setTitle(`Redemption Alert - ${headline.text} ${headline.emoji}`)
        .setDescription(message)
        .setColor(alertColor)
        .setTimestamp();

      if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

      const walletText = meta?.walletAddress
        ? formatAddressLink(meta.chainId, meta.walletAddress)
        : meta?.wallet || "n/a";
      const troveText =
        meta?.troveId && meta?.protocol
          ? formatLoanTroveLink(meta.protocol, meta.troveId, meta.troveId)
          : meta?.troveId || "n/a";
      const fields = [
        { name: "Trove", value: troveText, inline: true },
        { name: "Wallet", value: walletText, inline: true },
      ];
      if (meta?.walletLabel) fields.push({ name: "Label", value: meta.walletLabel, inline: true });
      const debtAheadPct =
        typeof meta?.debtAheadPct === "number" && Number.isFinite(meta.debtAheadPct)
          ? meta.debtAheadPct
          : null;
      const debtAheadText = fmt2c(meta?.debtAhead);
      const debtTotalText = fmt2c(meta?.debtTotal);
      const aheadPctText =
        debtAheadPct == null ? "n/a" : `${(debtAheadPct * 100).toFixed(2)}%`;
      const aheadMeaning = aheadPctText !== "n/a" ? aheadPctText : null;
      const deltaIr =
        typeof meta?.loanIR === "number" && typeof meta?.globalIR === "number"
          ? meta.loanIR - meta.globalIR
          : null;
      const deltaText =
        deltaIr == null || !Number.isFinite(deltaIr)
          ? "n/a"
          : `Δ ${deltaIr >= 0 ? "+" : ""}${deltaIr.toFixed(2)} pp`;
      fields.push(
        { name: "Loan IR", value: `${fmt2(meta?.loanIR)}%`, inline: true },
        { name: "Global IR", value: `${fmt2(meta?.globalIR)}%`, inline: true },
        { name: "Delta IR", value: deltaText, inline: true },
        { name: "Debt Ahead", value: debtAheadText, inline: true },
        { name: "Debt Total", value: debtTotalText, inline: true },
        { name: "Ahead %", value: aheadPctText, inline: true },
        {
          name: "Redemption Position - Higher % = safer",
          value: renderPositionBar(debtAheadPct),
          inline: false,
        },
        { name: "Tier", value: formatTierList(newTier), inline: false },
        {
          name: "Meaning",
          value: redemptionMeaning(newTier, aheadMeaning),
          inline: false,
        }
      );
      const snapshotLine = formatSnapshotLine(meta?.snapshotAt);
      if (snapshotLine) fields.push({ name: "Data captured", value: snapshotLine, inline: false });
      embed.addFields(fields);

      await user.send({ embeds: [embed] });
      return;
    }

    if (alertType === "LIQUIDATION") {
      if (phase === "NEW" || phase === "RESOLVED") return;
      const fmt2 = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "n/a");
      const fmt4 = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "n/a");
      const prevTier = meta?.prevTier || "UNKNOWN";
      const newTier = meta?.newTier || "UNKNOWN";
      const trend = trendLabel(prevTier, newTier, ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
      const headline =
        trend.label === "Improving"
          ? { text: "Improving", emoji: "🟢" }
          : trend.label === "Worsening"
          ? { text: "Worsening", emoji: "🔴" }
          : { text: "Updated", emoji: "⚪" };
      const alertColor =
        headline.text === "Improving"
          ? "Green"
          : headline.text === "Worsening"
          ? "Red"
          : "Grey";
      const bufferPct =
        typeof meta?.liquidationBufferFrac === "number" && Number.isFinite(meta?.liquidationBufferFrac)
          ? `${(meta.liquidationBufferFrac * 100).toFixed(2)}%`
          : "n/a";

      const embed = new EmbedBuilder()
        .setTitle(`Liquidation Alert - ${headline.text} ${headline.emoji}`)
        .setDescription(message)
        .setColor(alertColor)
        .setTimestamp();

      if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

      const walletText = meta?.walletAddress
        ? formatAddressLink(meta.chainId, meta.walletAddress)
        : meta?.wallet || "n/a";
      const troveText =
        meta?.troveId && meta?.protocol
          ? formatLoanTroveLink(meta.protocol, meta.troveId, meta.troveId)
          : meta?.troveId || "n/a";
      const fields = [
        { name: "Trove", value: troveText, inline: true },
        { name: "Wallet", value: walletText, inline: true },
      ];
      if (meta?.walletLabel) fields.push({ name: "Label", value: meta.walletLabel, inline: true });
      fields.push(
        { name: "LTV", value: `${fmt2(meta?.ltvPct)}%`, inline: true },
        { name: "Buffer", value: bufferPct, inline: true },
        {
          name: "Price / Liq",
          value: `${fmt4(meta?.currentPrice)} / ${fmt4(meta?.liquidationPrice)}`,
          inline: true,
        },
        {
          name: "Liquidation Position - Higher % = safer",
          value: renderPositionBar(meta?.liquidationBufferFrac),
          inline: false,
        },
        { name: "Tier", value: formatTierList(newTier), inline: false },
        {
          name: "Meaning",
          value:
            newTier === "LOW"
              ? "Your loan is comfortably safe from liquidation."
              : newTier === "MEDIUM"
              ? "Your loan is safe, but at slight risk of liquidation."
              : newTier === "HIGH"
              ? "Your loan is at elevated risk of liquidation."
              : newTier === "CRITICAL"
              ? "Your loan is at severe risk of liquidation."
              : "Liquidation risk is unknown.",
          inline: false,
        }
      );
      const snapshotLine = formatSnapshotLine(meta?.snapshotAt);
      if (snapshotLine) fields.push({ name: "Data captured", value: snapshotLine, inline: false });
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

      if (phase === "NEW") {
        return;
      }

      if (phase === "UPDATED" && prevStatus === currentStatus && prevTier === newTier) {
        return;
      }

      const prettyStatus = (s) => (s || "UNKNOWN").toString().replace(/_/g, " ");
      const statusEmoji = (s) =>
        ({
          IN_RANGE: "🟢",
          OUT_OF_RANGE: "🔴",
          INACTIVE: "⚪",
          UNKNOWN: "⚪",
        }[s] || "⚪");
      const tierEmoji = (t) =>
        ({
          CRITICAL: "🟥",
          HIGH: "🟧",
          MEDIUM: "🟨",
          LOW: "🟩",
          UNKNOWN: "⬜",
        }[t] || "⬜");
      const fmtPrice = (v) => {
        if (typeof v !== "number" || !Number.isFinite(v)) return "n/a";
        return v.toFixed(5);
      };
      const priceLabel =
        meta?.priceBaseSymbol && meta?.priceQuoteSymbol
          ? `${meta.priceQuoteSymbol}/${meta.priceBaseSymbol}`
          : "";
      const currentPriceText =
        meta?.currentPrice != null
          ? `${fmtPrice(meta.currentPrice)}${priceLabel ? ` ${priceLabel}` : ""}`
          : "n/a";
      const statusChanged = prevStatus !== currentStatus;
      const tierChanged = prevTier !== newTier;
      const statusValue = `${statusEmoji(currentStatus)} ${prettyStatus(currentStatus)}`;
      const statusWithPrice = `${statusValue} | Current: ${currentPriceText}`;
      const tierOrder = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
      const tierLines = tierOrder.map((t) => {
        const marker = t === newTier ? " ◀" : "";
        return `${tierEmoji(t)} ${t}${marker}`;
      });
      const tierValue = tierLines.join("\n");

      const lpRangeLabel = meta?.lpRangeLabel || null;
      let meaning = lpRangeLabel || "Status unchanged.";

      const labelFromStatus = () => {
        if (currentStatus === "IN_RANGE") return { text: "Improving", emoji: "🟢" };
        if (currentStatus === "OUT_OF_RANGE") return { text: "Worsening", emoji: "🔴" };
        return { text: "Updated", emoji: "⚪" };
      };
      const labelFromTrend = () => {
        if (trend.label === "Improving") return { text: "Improving", emoji: "🟢" };
        if (trend.label === "Worsening") return { text: "Worsening", emoji: "🔴" };
        return { text: "Updated", emoji: "⚪" };
      };
      let headline = { text: "Updated", emoji: "⚪" };
      if (statusChanged) headline = labelFromStatus();
      else if (tierChanged) headline = labelFromTrend();

      const alertColor =
        headline.text === "Improving"
          ? "Green"
          : headline.text === "Worsening"
          ? "Red"
          : "Grey";
      const embed = new EmbedBuilder()
        .setTitle(`LP Range Alert - ${headline.text} ${headline.emoji}`)
        .setDescription(message)
        .setColor(alertColor)
        .setTimestamp();

      if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

      const walletText = meta?.walletAddress
        ? formatAddressLink(meta.chainId, meta.walletAddress)
        : meta?.wallet || "n/a";
      const statusOnly = meta?.lpStatusOnly === 1 || meta?.lpStatusOnly === true;
      const fields = [
        {
          name: "Position",
          value:
            meta?.positionId && meta?.protocol
              ? formatLpPositionLink(meta.protocol, meta.positionId, meta.positionId)
              : meta?.positionId || "n/a",
          inline: true,
        },
        { name: "Wallet", value: walletText, inline: true },
      ];
      if (meta?.walletLabel) fields.push({ name: "Label", value: meta.walletLabel, inline: true });
      if (meta?.pairLabel) fields.push({ name: "Pair", value: meta.pairLabel, inline: true });
      fields.push({
        name: "Min Price",
        value: meta?.priceLower != null ? fmtPrice(meta.priceLower) : "n/a",
        inline: true,
      });
      fields.push({
        name: "Max Price",
        value: meta?.priceUpper != null ? fmtPrice(meta.priceUpper) : "n/a",
        inline: true,
      });
      fields.push(
        { name: "Status", value: statusWithPrice, inline: false },
        ...(statusOnly
          ? []
          : [
              { name: "Tier", value: tierValue, inline: false },
              { name: "Meaning", value: meaning, inline: false },
            ])
      );
      const snapshotLine = formatSnapshotLine(meta?.snapshotAt);
      if (snapshotLine) fields.push({ name: "Data captured", value: snapshotLine, inline: false });
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
  // When true, treat first active transition as UPDATED (used for loans)
  forceUpdated = false,
}) {
  assertPresent("userId", userId);
  assertPresent("walletId", walletId);
  assertPresent("contractId", contractId);
  assertPresent("tokenId", tokenId);

  const signature = makeSignature(signaturePayload);
  const stateJson = state && typeof state === "object" ? JSON.stringify(state) : null;

  const prev = getPrevState({ userId, walletId, contractId, tokenId, alertType });
  const prevActive = prev.isActive === 1;

  if (forceUpdated && isActive && !prevActive) {
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
    snapshotAt,
    protocol,
    wallet,
    walletLabel,
    chainId,
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
  const lastTierChangeAtMs = Number(prevObj?.lastTierChangeAtMs || 0) || 0;

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
    lastTierChangeAtMs,
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
      if (age < LOAN_LIQ_WORSENING_DEBOUNCE_MS) {
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
          message: `${protocol}`,
          meta: {
            wallet: shortenAddress(wallet),
            walletLabel,
            walletAddress: wallet,
            chainId,
            protocol,
            troveId: shortenTroveId(tokenId),
            prevTier: prevTierU,
            newTier: tierU,
            ltvPct,
            liquidationPrice,
            currentPrice,
            liquidationBufferFrac,
            snapshotAt,
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
            lastTierChangeAtMs: nowMs,
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
          lastTierChangeAtMs: nowMs,
          lastTier: tierU,
        },
        logPrefix: "[LIQ]",
        message: `${protocol}`,
        forceUpdated: prev.exists,
        meta: {
          wallet: shortenAddress(wallet),
          walletLabel,
          walletAddress: wallet,
          chainId,
          protocol,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          ltvPct,
          liquidationPrice,
          currentPrice,
          liquidationBufferFrac,
          snapshotAt,
        },
        alertType,
      });
      return;
    }

    const tierChanged = prevTierU !== tierU;
    const escalated = isTierEscalation(prevTierU, tierU, LIQ_TIER_ORDER);
    const improved = isTierEscalation(tierU, prevTierU, LIQ_TIER_ORDER);
    const tierDebounceMs = escalated
      ? LOAN_LIQ_WORSENING_DEBOUNCE_MS
      : improved
      ? LOAN_LIQ_IMPROVING_DEBOUNCE_MS
      : 0;

    if (tierChanged && tierDebounceMs > 0 && lastTierChangeAtMs) {
      const age = nowMs - lastTierChangeAtMs;
      if (age < tierDebounceMs) {
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
            lastAlertAtMs,
            lastTierChangeAtMs: nowMs,
            lastTier: prevTierU,
          }),
        });
        return;
      }
    }

    // prevActive=true: keep active, but suppress noisy UPDATEDs during cooldown unless escalation
    const signature = makeSignature(sigPayload);
    const wouldUpdate = prev.signature !== signature;

    const cooldownOk = true;
    // escalated already computed above
    const allowNotifyUpdate = wouldUpdate && (cooldownOk || escalated) && tierChanged;
    const newLastAlertAtMs = allowNotifyUpdate ? nowMs : lastAlertAtMs;
    const newLastTierChangeAtMs = tierChanged ? nowMs : lastTierChangeAtMs;

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
          lastTierChangeAtMs: newLastTierChangeAtMs,
          lastTier: tierU,
        },
        logPrefix: "[LIQ]",
        message: `${protocol}`,
        meta: {
        wallet: shortenAddress(wallet),
        walletLabel,
        walletAddress: wallet,
        chainId,
        protocol,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          ltvPct,
          liquidationPrice,
          currentPrice,
          liquidationBufferFrac,
          snapshotAt,
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
          lastTierChangeAtMs: newLastTierChangeAtMs,
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
        lastTierChangeAtMs: newLastTierChangeAtMs,
        lastTier: tierU,
      },
      logPrefix: "[LIQ]",
      message: `${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
        walletLabel,
        walletAddress: wallet,
        chainId,
        protocol,
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
    if (age < LOAN_LIQ_IMPROVING_DEBOUNCE_MS) {
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
        message: `${protocol}`,
        meta: {
          wallet: shortenAddress(wallet),
          walletLabel,
          walletAddress: wallet,
          chainId,
          protocol,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          ltvPct,
          liquidationPrice,
          currentPrice,
          liquidationBufferFrac,
          snapshotAt,
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
      message: `${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
        walletLabel,
        walletAddress: wallet,
        chainId,
        protocol,
        troveId: shortenTroveId(tokenId),
        prevTier: prevTierU,
        newTier: tierU,
          ltvPct,
          liquidationPrice,
          currentPrice,
          liquidationBufferFrac,
          snapshotAt,
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
    message: `${protocol}`,
    meta: {
      wallet: shortenAddress(wallet),
            walletLabel,
      walletAddress: wallet,
      chainId,
      troveId: shortenTroveId(tokenId),
      prevTier: prevTierU,
      newTier: tierU,
      ltvPct,
      liquidationPrice,
      currentPrice,
      liquidationBufferFrac,
      snapshotAt,
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
    debtAheadPct,
    debtAhead,
    debtTotal,
    loanIR,
    globalIR,
    snapshotAt,
    isCDPActive,
    protocol,
    wallet,
    walletLabel,
    chainId,
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
  const lastTierChangeAtMs = Number(prevObj?.lastTierChangeAtMs || 0) || 0;

  let cand = prevObj?.candidateStatus ? String(prevObj.candidateStatus) : null;
  let candSinceMs = Number(prevObj?.candidateSinceMs || 0) || 0;

  const sigPayload = {
    tier: tierU,
    isCDPActive: Boolean(isCDPActive),
    debtAheadB:
      debtAheadPct == null || !Number.isFinite(debtAheadPct)
        ? null
        : Math.round(debtAheadPct * 10000),
  };

  const baseState = {
    kind: "LOAN",
    tier: tierU,
    debtAheadPct,
    debtAhead,
    debtTotal,
    isCDPActive,
    lastTierChangeAtMs,
  };

  if (observedActiveFinal) {
    if (!prevActive) {
      if (cand !== "ON") {
        cand = "ON";
        candSinceMs = nowMs;
      }

      const age = nowMs - candSinceMs;
      if (age < LOAN_REDEMP_WORSENING_DEBOUNCE_MS) {
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
          message: `${protocol}`,
          meta: {
            wallet: shortenAddress(wallet),
            walletLabel,
            walletAddress: wallet,
            chainId,
            protocol,
            troveId: shortenTroveId(tokenId),
            prevTier: prevTierU,
            newTier: tierU,
            debtAheadPct,
            debtAhead,
            debtTotal,
            loanIR,
            globalIR,
            snapshotAt,
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
            lastTierChangeAtMs: nowMs,
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
          lastTierChangeAtMs: nowMs,
          lastTier: tierU,
        },
        logPrefix: "[REDEMP]",
        message: `${protocol}`,
        forceUpdated: prev.exists,
        meta: {
          wallet: shortenAddress(wallet),
          walletLabel,
          walletAddress: wallet,
          chainId,
          protocol,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          debtAheadPct,
          debtAhead,
          debtTotal,
          loanIR,
          globalIR,
          snapshotAt,
        },
        alertType,
      });
      return;
    }

    const immediateCritical = tierU === "CRITICAL" && prevTierU !== "CRITICAL";
    const tierChanged = prevTierU !== tierU;
    const escalated = isTierEscalation(prevTierU, tierU, REDEMP_TIER_ORDER);
    const improved = isTierEscalation(tierU, prevTierU, REDEMP_TIER_ORDER);
    const tierDebounceMs = escalated
      ? LOAN_REDEMP_WORSENING_DEBOUNCE_MS
      : improved
      ? LOAN_REDEMP_IMPROVING_DEBOUNCE_MS
      : 0;

    if (tierChanged && !immediateCritical && tierDebounceMs > 0 && lastTierChangeAtMs) {
      const age = nowMs - lastTierChangeAtMs;
      if (age < tierDebounceMs) {
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
            candidateTier: null,
            candidateTierSinceMs: 0,
            lastAlertAtMs,
            lastTierChangeAtMs: nowMs,
            lastTier: prevTierU,
          }),
        });
        return;
      }
    }

    const signature = makeSignature(sigPayload);
    const wouldUpdate = prev.signature !== signature;

    const cooldownOk = true;
    const allowNotifyUpdate =
      immediateCritical || (wouldUpdate && (cooldownOk || escalated) && tierChanged);
    const newLastAlertAtMs = allowNotifyUpdate ? nowMs : lastAlertAtMs;
    const newLastTierChangeAtMs = tierChanged ? nowMs : lastTierChangeAtMs;

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
          lastTierChangeAtMs: newLastTierChangeAtMs,
          lastTier: tierU,
        },
        logPrefix: "[REDEMP]",
        message: `${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
        walletLabel,
        walletAddress: wallet,
        chainId,
        protocol,
        troveId: shortenTroveId(tokenId),
        prevTier: prevTierU,
        newTier: tierU,
        debtAheadPct,
        debtAhead,
        debtTotal,
        loanIR,
        globalIR,
        snapshotAt,
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
          lastTierChangeAtMs: newLastTierChangeAtMs,
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
      lastTierChangeAtMs: newLastTierChangeAtMs,
      lastTier: tierU,
    },
      logPrefix: "[REDEMP]",
      message: `${protocol}`,
          meta: {
            wallet: shortenAddress(wallet),
          walletLabel,
          walletAddress: wallet,
          chainId,
          protocol,
          troveId: shortenTroveId(tokenId),
          prevTier: prevTierU,
          newTier: tierU,
          debtAheadPct,
          debtAhead,
          debtTotal,
          loanIR,
          globalIR,
          snapshotAt,
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
    if (age < LOAN_REDEMP_IMPROVING_DEBOUNCE_MS) {
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

    const allowResolveNotify = Number.isFinite(debtAheadPct);

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
      message: `${protocol}`,
      meta: {
        wallet: shortenAddress(wallet),
        walletLabel,
        walletAddress: wallet,
        chainId,
        protocol,
        troveId: shortenTroveId(tokenId),
        prevTier: prevTierU,
        newTier: tierU,
        debtAheadPct,
        debtAhead,
        debtTotal,
        loanIR,
        globalIR,
        snapshotAt,
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
    message: `${protocol}`,
    meta: {
      wallet: shortenAddress(wallet),
            walletLabel,
      walletAddress: wallet,
      chainId,
      troveId: shortenTroveId(tokenId),
      prevTier: prevTierU,
      newTier: tierU,
      debtAheadPct,
      debtAhead,
      debtTotal,
      loanIR,
      globalIR,
      snapshotAt,
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

    currentStatus,

    isActive: observedActive,

    lpRangeTier,
    tickLower,
    tickUpper,
    currentTick,
    protocol,
    wallet,
    walletLabel,
    chainId,
    pairLabel,
    priceLower,
    priceUpper,
    currentPrice,
    priceBaseSymbol,
    priceQuoteSymbol,
    lpStatusOnly,
    snapshotAt,
    lpRangeLabel,
  } = data;

  const tokenId = String(positionId);
  const alertType = "LP_RANGE";

  const nowMs = Date.now();

  const currStatus = normLpStatus(currentStatus);
  const tierU = (lpRangeTier || "UNKNOWN").toString().toUpperCase();
  const statusOnly = lpStatusOnly === 1 || lpStatusOnly === true;

  if (currStatus === "INACTIVE") {
    upsertAlertState({
      userId,
      walletId,
      contractId,
      tokenId,
      alertType,
      isActive: false,
      signature: null,
      stateJson: JSON.stringify({
        kind: "LP",
        rangeStatus: "INACTIVE",
        confirmedStatus: "INACTIVE",
        candidateStatus: null,
        candidateSinceMs: 0,
        lastAlertAtMs: Date.now(),
        lastTier: tierU,
      }),
    });
    return;
  }

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
  const prevStatusU = prevObj?.confirmedStatus
    ? normLpStatus(prevObj.confirmedStatus)
    : "UNKNOWN";

  let candidateStatus = prevObj?.candidateStatus ? normLpStatus(prevObj.candidateStatus) : null;
  let candidateSinceMs = Number(prevObj?.candidateSinceMs || 0) || 0;
  const lastStatusChangeAtMs = Number(prevObj?.lastStatusChangeAtMs || 0) || 0;

  const sigPayload = {
    currentStatus: currStatus,
    lpRangeTier: tierU,
  };
  const signature = makeSignature(sigPayload);

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
        rangeStatus: currStatus,
        confirmedStatus: currStatus,
        candidateStatus: null,
        candidateSinceMs: 0,
        lastAlertAtMs: nowMs,
        lastStatusChangeAtMs: 0,
        lastTier: tierU,
      }),
    });
    return;
  }

  const statusChanged = prevStatusU !== currStatus;
  const rawTierChanged = prevTierU !== tierU;
  const tierChanged = !statusOnly && rawTierChanged;

  if (statusOnly && rawTierChanged && !statusChanged) {
    const shortWallet = shortenAddress(wallet);
    const shortToken = shortenTroveId(tokenId);
    logger.info(
      `[LP] Status-only: tier change suppressed (${protocol} ${pairLabel || "UNKNOWN_PAIR"} ` +
        `token=${shortToken} wallet=${shortWallet} status=${currStatus} ${prevTierU}→${tierU})`
    );
  }

  if (statusChanged) {
    const debounceMs =
      currStatus === "OUT_OF_RANGE" ? LP_WORSENING_DEBOUNCE_MS : LP_IMPROVING_DEBOUNCE_MS;
    if (debounceMs > 0 && lastStatusChangeAtMs && nowMs - lastStatusChangeAtMs < debounceMs) {
      upsertAlertState({
        userId,
        walletId,
        contractId,
        tokenId,
        alertType,
        isActive: true,
        signature: prev.signature,
        stateJson: JSON.stringify({
          kind: "LP",
          rangeStatus: currStatus,
          confirmedStatus: prevStatusU,
          candidateStatus: null,
          candidateSinceMs: 0,
          lastAlertAtMs,
          lastStatusChangeAtMs,
          lastTier: prevTierU,
        }),
      });
      return;
    }
  }

  const LP_TIER_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];
  const escalated = isTierEscalation(prevTierU, tierU, LP_TIER_ORDER);
  const cooldownOk = true;
  const allowNotifyUpdate =
    prevActive &&
    prev.signature !== signature &&
    (cooldownOk || escalated) &&
    (statusChanged || tierChanged);

  const newLastAlertAtMs = allowNotifyUpdate ? nowMs : lastAlertAtMs;

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
        kind: "LP",
        rangeStatus: currStatus,
        confirmedStatus: currStatus,
        candidateStatus: null,
        candidateSinceMs: 0,
        lastAlertAtMs: newLastAlertAtMs,
        lastStatusChangeAtMs: statusChanged ? nowMs : lastStatusChangeAtMs,
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
      rangeStatus: currStatus,
      confirmedStatus: currStatus,
      candidateStatus: null,
      candidateSinceMs: 0,
      lastAlertAtMs: newLastAlertAtMs,
      lastStatusChangeAtMs: statusChanged ? nowMs : lastStatusChangeAtMs,
      lastTier: tierU,
    },
    logPrefix: "[LP]",
    message: `${protocol}`,
    meta: {
      positionId: shortenTroveId(tokenId),
      wallet: shortenAddress(wallet),
      walletLabel,
      walletAddress: wallet,
      chainId,
      protocol,
      pairLabel,
      priceLower,
      priceUpper,
      currentPrice,
      priceBaseSymbol,
      priceQuoteSymbol,
      prevStatus: prevStatusU,
      currentStatus: currStatus,
      prevTier: prevTierU,
      newTier: tierU,
      lpRangeTier: tierU,
      lpStatusOnly: statusOnly,
      lpRangeLabel,
      snapshotAt,
    },
    alertType,
    notifyOnResolved: false,
  });
}

module.exports = {
  setAlertEngineClient,
  handleLiquidationAlert,
  handleRedemptionAlert,
  handleLpRangeAlert,
};
