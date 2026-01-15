// monitoring/dailyHeartbeat.js
const { EmbedBuilder } = require("discord.js");
const { getLoanSummaries } = require("./loanMonitor");
const { getLpSummaries } = require("./lpMonitor");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { getDb } = require("../db");
const logger = require("../utils/logger");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");

// -----------------------------
// Formatting helpers
// -----------------------------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fmt4 = createDecimalFormatter(0, 4); // commas + up to 4 decimals
const fmt5 = createDecimalFormatter(0, 5); // commas + up to 5 decimals

function fmtNum4(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt4.format(n);
}

function fmtNum5(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt5.format(n);
}

function fmtPct2(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(2)}%`;
}

function formatTokenAmount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.01) return n.toFixed(6);
  return n.toPrecision(6);
}

function formatLoanField(s) {
  const rawId = s.troveId ?? s.tokenId ?? s.positionId ?? "?";
  const troveId = shortenTroveId(rawId);
  const tier = (s.liquidationTier || "UNKNOWN").toString().toUpperCase();
  const tierEmoji = {
    CRITICAL: "🟥",
    HIGH: "🟧",
    MEDIUM: "🟨",
    LOW: "🟩",
    UNKNOWN: "⬜",
  }[tier] || "⬜";

  const title = `${tierEmoji} ${s.protocol || "UNKNOWN"} (${s.chainId || "?"}) — trove ${troveId}`;
  const lines = [];

  const status = s.status || "UNKNOWN";
  lines.push(`Status: ${status}`);

  if (s.hasPrice && typeof s.price === "number" && typeof s.liquidationPrice === "number") {
    const ltvText = fmtPct2(s.ltvPct);
    const bufferText =
      typeof s.liquidationBufferFrac === "number"
        ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
        : "n/a";
    lines.push("Risk:");
    lines.push(
      `LTV: ${ltvText} | Price: ${fmtNum5(s.price)} | Liq: ${fmtNum5(
        s.liquidationPrice
      )} | Buffer: ${bufferText} (${tier})`
    );
  } else {
    lines.push("Risk:");
    lines.push("Price / liq: *(unavailable)*");
  }

  if (typeof s.interestPct === "number") {
    let irLine = `IR: ${s.interestPct.toFixed(2)}% p.a.`;
    if (typeof s.globalIrPct === "number") {
      irLine += ` | Global: ${s.globalIrPct.toFixed(2)}%`;
    }
    if (s.redemptionTier) {
      irLine += ` | Redemption: ${s.redemptionTier}`;
    }
    lines.push("Rates:");
    lines.push(irLine);
  }

  return { name: title, value: lines.join("\n") };
}

function formatLpField(s) {
  const tokenId = s.tokenId ?? s.positionId ?? "?";
  const pair =
    s.pairLabel ||
    `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;

  const rangeStatus = (s.rangeStatus || "UNKNOWN").toString().toUpperCase();
  const statusEmoji = {
    OUT_OF_RANGE: "🔴",
    IN_RANGE: "🟢",
    UNKNOWN: "⚪",
    INACTIVE: "⚫",
  }[rangeStatus] || "⚪";

  const title = `${s.protocol || "UNKNOWN"} ${pair} (${s.chainId || "?"}) — token ${shortenTroveId(
    tokenId
  )}`;
  const parts = [];
  parts.push(`Status: ${s.status || "UNKNOWN"} | Range: ${statusEmoji} ${rangeStatus}`);

  if (s.lpRangeTier && s.lpRangeTier !== "UNKNOWN") {
    const tier = s.lpRangeTier.toString().toUpperCase();
    const tierEmoji = { CRITICAL: "🟥", HIGH: "🟧", MEDIUM: "🟨", LOW: "🟩", UNKNOWN: "⬜" }[tier] || "⬜";
    parts.push(
      `Range tier: ${tierEmoji} ${s.lpRangeTier}${s.lpRangeLabel ? ` (${s.lpRangeLabel})` : ""}`
    );
  }

  const hasAmounts =
    typeof s.amount0 === "number" &&
    Number.isFinite(s.amount0) &&
    typeof s.amount1 === "number" &&
    Number.isFinite(s.amount1);

  if (hasAmounts) {
    const sym0 = s.token0Symbol || "token0";
    const sym1 = s.token1Symbol || "token1";
    parts.push(
      `Liquidity: ${sym0} ${formatTokenAmount(s.amount0)}, ${sym1} ${formatTokenAmount(s.amount1)}`
    );
  } else if (s.liquidity) {
    parts.push(`Liquidity: ${s.liquidity}`);
  }

  const hasFees =
    typeof s.fees0 === "number" &&
    Number.isFinite(s.fees0) &&
    typeof s.fees1 === "number" &&
    Number.isFinite(s.fees1);

  if (hasFees) {
    const sym0 = s.token0Symbol || "token0";
    const sym1 = s.token1Symbol || "token1";
    parts.push(
      `Fees: ${sym0} ${formatTokenAmount(s.fees0)}, ${sym1} ${formatTokenAmount(s.fees1)}`
    );
  }

  return { name: title, value: parts.join("\n") };
}

function worstLoanTier(loans) {
  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
  let worst = "UNKNOWN";
  for (const s of loans || []) {
    const tier = (s.liquidationTier || "UNKNOWN").toString().toUpperCase();
    if (order.indexOf(tier) !== -1 && order.indexOf(tier) < order.indexOf(worst)) worst = tier;
  }
  return worst;
}

function worstLpStatus(lps) {
  const order = ["OUT_OF_RANGE", "IN_RANGE", "UNKNOWN", "INACTIVE"];
  let worst = "UNKNOWN";
  for (const s of lps || []) {
    const st = (s.rangeStatus || "UNKNOWN").toString().toUpperCase();
    if (order.indexOf(st) !== -1 && order.indexOf(st) < order.indexOf(worst)) worst = st;
  }
  return worst;
}

function colorForLoanTier(tier) {
  return (
    {
      CRITICAL: "Red",
      HIGH: "Orange",
      MEDIUM: "Yellow",
      LOW: "Green",
      UNKNOWN: "Grey",
    }[tier] || "Grey"
  );
}

function colorForLpStatus(status) {
  return (
    {
      OUT_OF_RANGE: "Red",
      IN_RANGE: "Green",
      UNKNOWN: "Grey",
      INACTIVE: "DarkGrey",
    }[status] || "Grey"
  );
}

function buildHeartbeatEmbeds({ nowIso, loanSummaries, lpSummaries, client }) {
  const embeds = [];
  const loanCount = loanSummaries?.length || 0;
  const lpCount = lpSummaries?.length || 0;

  const header = new EmbedBuilder()
    .setTitle("24h DeFi Heartbeat")
    .setDescription(`As of **${nowIso}**\nLoans: **${loanCount}** | LPs: **${lpCount}**`)
    .setColor("DarkBlue")
    .setTimestamp();

  if (client?.user) header.setThumbnail(client.user.displayAvatarURL());
  embeds.push(header);

  const loanFields = (loanSummaries || [])
    .slice()
    .sort((a, b) => {
      const av = typeof a.ltvPct === "number" ? a.ltvPct : -1;
      const bv = typeof b.ltvPct === "number" ? b.ltvPct : -1;
      return bv - av;
    })
    .map(formatLoanField);

  const loanColor = colorForLoanTier(worstLoanTier(loanSummaries || []));

  if (!loanFields.length) {
    embeds.push(
      new EmbedBuilder().setTitle("Loans").setDescription("_No monitored loans_").setColor("DarkBlue")
    );
  } else {
    const chunks = chunk(loanFields, 25);
    chunks.forEach((fields, idx) => {
      const fieldIds = new Set(fields.map((f) => f.name));
      const chunkLoans = (loanSummaries || []).filter((s) => {
        const rawId = s.troveId ?? s.tokenId ?? s.positionId ?? "?";
        const troveId = shortenTroveId(rawId);
        const title = `${s.protocol || "UNKNOWN"} (${s.chainId || "?"}) — trove ${troveId}`;
        const tier = (s.liquidationTier || "UNKNOWN").toString().toUpperCase();
        const tierEmoji = {
          CRITICAL: "🟥",
          HIGH: "🟧",
          MEDIUM: "🟨",
          LOW: "🟩",
          UNKNOWN: "⬜",
        }[tier] || "⬜";
        return fieldIds.has(`${tierEmoji} ${title}`);
      });
      const chunkColor = colorForLoanTier(worstLoanTier(chunkLoans));
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "Loans" : "Loans (cont.)")
        .setColor(chunkColor)
        .addFields(fields);
      embeds.push(e);
    });
  }

  const order = { OUT_OF_RANGE: 0, UNKNOWN: 1, IN_RANGE: 2 };
  const lpFields = (lpSummaries || [])
    .slice()
    .sort((a, b) => {
      const ra = order[a.rangeStatus] ?? 99;
      const rb = order[b.rangeStatus] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.protocol || "").localeCompare(b.protocol || "");
    })
    .map(formatLpField);

  const lpColor = colorForLpStatus(worstLpStatus(lpSummaries || []));

  if (!lpFields.length) {
    embeds.push(
      new EmbedBuilder()
        .setTitle("LP Positions")
        .setDescription("_No monitored LP positions_")
        .setColor("DarkBlue")
    );
  } else {
    const chunks = chunk(lpFields, 25);
    chunks.forEach((fields, idx) => {
      const fieldIds = new Set(fields.map((f) => f.name));
      const chunkLps = (lpSummaries || []).filter((s) => {
        const tokenId = s.tokenId ?? s.positionId ?? "?";
        const pair =
          s.pairLabel ||
          `${s.token0Symbol || s.token0 || "?"}-${s.token1Symbol || s.token1 || "?"}`;
        const title = `${s.protocol || "UNKNOWN"} ${pair} (${s.chainId || "?"}) — token ${shortenTroveId(
          tokenId
        )}`;
        return fieldIds.has(title);
      });
      const chunkColor = colorForLpStatus(worstLpStatus(chunkLps));
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "LP Positions" : "LP Positions (cont.)")
        .setColor(chunkColor)
        .addFields(fields);
      embeds.push(e);
    });
  }

  return embeds;
}

// -----------------------------
// Recipient selection (DB-driven)
// -----------------------------
function getHeartbeatRecipients() {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT DISTINCT
      u.id           AS userId,
      u.discord_id   AS discordId,
      u.discord_name AS discordName
    FROM users u
    JOIN user_wallets uw
      ON uw.user_id = u.id
     AND uw.is_enabled = 1
    WHERE
      u.accepts_dm = 1
      AND u.discord_id IS NOT NULL
  `
    )
    .all();
}

// If DM is blocked, stop trying daily until user re-enables via onboarding.
function markUserCannotDm(userId) {
  try {
    const db = getDb();
    db.prepare(
      `
      UPDATE users
      SET accepts_dm = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(userId);
  } catch (e) {
    logger.warn(`[Heartbeat] Failed to mark accepts_dm=0 for userId=${userId}:`, e?.message || e);
  }
}

// -----------------------------
// Main
// -----------------------------
async function sendDailyHeartbeat(client) {
  if (!client?.users?.fetch) {
    throw new Error("[Heartbeat] Discord client not available (client.users.fetch missing).");
  }

  const recipients = getHeartbeatRecipients();
  if (!recipients || recipients.length === 0) {
    logger.info("[Heartbeat] No recipients (accepts_dm=1 with enabled wallets).");
    return;
  }

  let allLoanSummaries = [];
  let allLpSummaries = [];
  try {
    [allLoanSummaries, allLpSummaries] = await Promise.all([getLoanSummaries(), getLpSummaries()]);
  } catch (err) {
    logger.error("[Heartbeat] Failed to fetch summaries:", err?.message || err);
    return;
  }

  const nowIso = new Date().toISOString();

  const userCache = new Map(); // discordId -> Discord.User

  for (const r of recipients) {
    const userIdKey = String(r.userId);
    const discordId = String(r.discordId);

    const userLoans = (allLoanSummaries || []).filter((s) => String(s.userId) === userIdKey);
    const userLps = (allLpSummaries || []).filter((s) => String(s.userId) === userIdKey);

    const embeds = buildHeartbeatEmbeds({
      nowIso,
      loanSummaries: userLoans,
      lpSummaries: userLps,
      client,
    });

    try {
      let user = userCache.get(discordId);
      if (!user) {
        user = await client.users.fetch(discordId);
        userCache.set(discordId, user);
      }

      const embedChunks = chunk(embeds, 10);
      for (const c of embedChunks) {
        await user.send({ embeds: c });
      }

      logger.info(`[Heartbeat] Sent daily heartbeat to userId=${r.userId} discordId=${discordId}`);
    } catch (err) {
      const code = err?.code;
      const msgText = err?.message || String(err);

      logger.error(
        `[Heartbeat] Failed to send to discordId=${discordId} (userId=${r.userId}):`,
        msgText
      );

      if (code === 50007) {
        markUserCannotDm(r.userId);
        logger.warn(`[Heartbeat] Marked accepts_dm=0 (DM blocked) for userId=${r.userId}`);
      }
    }
  }
}

module.exports = { sendDailyHeartbeat };
