// monitoring/dailyHeartbeat.js
const { EmbedBuilder } = require("discord.js");
const { getLoanSummaries } = require("./loanMonitor");
const { getLpSummaries } = require("./lpMonitor");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { getDb } = require("../db");
const logger = require("../utils/logger");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const { formatLoanTroveLink, formatLpPositionLink, formatAddressLink } = require("../utils/links");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === "") {
    throw new Error(`Missing env var ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return n;
}

const SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("SNAPSHOT_STALE_WARN_MIN");
const SNAPSHOT_STALE_WARN_MS = Math.max(0, Math.floor(SNAPSHOT_STALE_WARN_MIN * 60 * 1000));

// -----------------------------
// Formatting helpers
// -----------------------------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fmt2 = createDecimalFormatter(0, 2); // commas + up to 2 decimals
const fmt4 = createDecimalFormatter(0, 4); // commas + up to 4 decimals
const fmt5 = createDecimalFormatter(0, 5); // commas + up to 5 decimals
const fmt6 = createDecimalFormatter(0, 6); // commas + up to 6 decimals

function fmtNum4(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt4.format(n);
}

function fmtNum5(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt5.format(n);
}

function fmtNum2(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt2.format(n);
}

function fmtPct2(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(2)}%`;
}

function formatTokenAmount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1000) return fmt2.format(n);
  if (abs >= 1) return fmt4.format(n);
  if (abs >= 0.01) return fmt6.format(n);
  return n.toPrecision(6);
}

function parseSnapshotTs(raw) {
  if (!raw) return null;
  const iso = String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
  const ts = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (!Number.isFinite(ts)) return null;
  return Math.floor(ts / 1000);
}

function formatSnapshotLine(snapshotAt) {
  const ts = parseSnapshotTs(snapshotAt);
  if (!ts) return null;
  const stale = Date.now() - ts * 1000 > SNAPSHOT_STALE_WARN_MS;
  const warn = stale ? " ⚠️ Data may be stale." : "";
  return `Data captured: <t:${ts}:f>${warn}`;
}

function loanMeaning(tier, kind, aheadPctText) {
  const t = (tier || "UNKNOWN").toString().toUpperCase();
  const label = kind === "LIQUIDATION" ? "liquidation" : "redemption";
  const aheadSuffix =
    kind === "REDEMPTION" && aheadPctText
      ? ` with ${aheadPctText} of total loan debt in front of it.`
      : ".";
  if (t === "LOW") return `Your loan is comfortably safe from ${label}${aheadSuffix}`;
  if (t === "MEDIUM") return `Your loan is safe, but at slight risk of ${label}${aheadSuffix}`;
  if (t === "HIGH") return `Your loan is at elevated risk of ${label}${aheadSuffix}`;
  if (t === "CRITICAL") return `Your loan is at severe risk of ${label}${aheadSuffix}`;
  return `${label[0].toUpperCase()}${label.slice(1)} risk is unknown.`;
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

  const troveLink = formatLoanTroveLink(s.protocol, rawId, troveId);
  const title = `${tierEmoji} ${s.protocol || "UNKNOWN"} (${s.chainId || "?"})`;
  const lines = [];
  lines.push(`Trove: ${troveLink}`);
  if (s.owner) {
    const walletText = formatAddressLink(s.chainId, s.owner) || shortenAddress(s.owner);
    lines.push(`Wallet: ${walletText}`);
  }

  const status = s.status || "UNKNOWN";
  lines.push(`Status: ${status}`);
  const debtText =
    typeof s.debtAmount === "number" && Number.isFinite(s.debtAmount) ? fmtNum4(s.debtAmount) : "n/a";
  lines.push(`Debt: ${debtText}`);
  lines.push("");

  if (s.hasPrice && typeof s.price === "number" && typeof s.liquidationPrice === "number") {
    const ltvText = fmtPct2(s.ltvPct);
    const bufferText =
      typeof s.liquidationBufferFrac === "number"
        ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
        : "n/a";
    lines.push("Liquidation risk:");
    lines.push(
      `LTV: ${ltvText} | Price: ${fmtNum5(s.price)} | Liq: ${fmtNum5(
        s.liquidationPrice
      )} | Buffer: ${bufferText} (${tier})`
    );
    lines.push(`Meaning: ${loanMeaning(s.liquidationTier, "LIQUIDATION")}`);
    lines.push("");
  } else {
    lines.push("Liquidation risk:");
    lines.push("Price / liq: *(unavailable)*");
    lines.push(`Meaning: ${loanMeaning(s.liquidationTier, "LIQUIDATION")}`);
    lines.push("");
  }

  if (typeof s.interestPct === "number") {
    const deltaIr =
      typeof s.globalIrPct === "number" && Number.isFinite(s.globalIrPct)
        ? s.interestPct - s.globalIrPct
        : null;
    const deltaText =
      deltaIr == null || !Number.isFinite(deltaIr)
        ? "Δ n/a"
        : `Δ ${deltaIr >= 0 ? "+" : ""}${deltaIr.toFixed(2)} pp`;
    lines.push("Redemption risk:");
    lines.push(
      `IR: ${s.interestPct.toFixed(2)}% | Global: ${
        typeof s.globalIrPct === "number" ? s.globalIrPct.toFixed(2) : "n/a"
      }% | ${deltaText}`
    );
    const debtAheadText = fmtNum2(s.redemptionDebtAhead);
    const debtTotalText = fmtNum2(s.redemptionTotalDebt);
    const aheadPctText =
      typeof s.redemptionDebtAheadPct === "number" && Number.isFinite(s.redemptionDebtAheadPct)
        ? `${(s.redemptionDebtAheadPct * 100).toFixed(2)}%`
        : "n/a";
    lines.push(
      `Debt ahead: ${debtAheadText} | Total: ${debtTotalText} | Ahead: ${aheadPctText} (${s.redemptionTier || "UNKNOWN"})`
    );
    lines.push(`Meaning: ${loanMeaning(s.redemptionTier, "REDEMPTION", aheadPctText)}`);
  }

  return { name: title, value: lines.join("\n") };
}

function formatLpField(s) {
  const tokenId = s.tokenId ?? s.positionId ?? "?";
  const tokenLink = formatLpPositionLink(s.protocol, tokenId, shortenTroveId(tokenId));
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

  const title = `${s.protocol || "UNKNOWN"} ${pair} (${s.chainId || "?"})`;
  const parts = [];
  parts.push(`Token: ${tokenLink}`);
  if (s.owner) {
    const walletText = formatAddressLink(s.chainId, s.owner) || shortenAddress(s.owner);
    parts.push(`Wallet: ${walletText}`);
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
      `Principal: ${sym0} ${formatTokenAmount(s.amount0)}, ${sym1} ${formatTokenAmount(s.amount1)}`
    );
  } else if (s.liquidity) {
    parts.push(`Principal: ${s.liquidity}`);
  }

  if (
    typeof s.fees0 === "number" &&
    Number.isFinite(s.fees0) &&
    typeof s.fees1 === "number" &&
    Number.isFinite(s.fees1)
  ) {
    const sym0 = s.token0Symbol || "token0";
    const sym1 = s.token1Symbol || "token1";
    parts.push(
      `Uncollected fees: ${sym0} ${formatTokenAmount(s.fees0)}, ${sym1} ${formatTokenAmount(s.fees1)}`
    );
  }

  parts.push(`Status: ${s.status || "UNKNOWN"} | Range: ${statusEmoji} ${rangeStatus}`);

  if (s.lpRangeTier && s.lpRangeTier !== "UNKNOWN") {
    const tier = s.lpRangeTier.toString().toUpperCase();
    const tierEmoji = { CRITICAL: "🟥", HIGH: "🟧", MEDIUM: "🟨", LOW: "🟩", UNKNOWN: "⬜" }[tier] || "⬜";
    parts.push(
      `Range tier: ${tierEmoji} ${s.lpRangeTier}${s.lpRangeLabel ? ` (${s.lpRangeLabel})` : ""}`
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

  const snapshotTimes = []
    .concat(loanSummaries || [])
    .concat(lpSummaries || [])
    .map((s) => parseSnapshotTs(s?.snapshotAt))
    .filter((v) => v != null);
  const latestSnapshot = snapshotTimes.length ? Math.max(...snapshotTimes) : null;
  const snapshotLine = latestSnapshot
    ? formatSnapshotLine(new Date(latestSnapshot * 1000).toISOString())
    : null;

  const headerLines = [`Loans: **${loanCount}** | LPs: **${lpCount}**`];
  if (snapshotLine) headerLines.push("", snapshotLine);

  const header = new EmbedBuilder()
    .setTitle("24h DeFi Heartbeat")
    .setDescription(headerLines.join("\n"))
    .setColor("DarkBlue");

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
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "Loans" : "Loans (cont.)")
        .setColor("DarkBlue")
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
      const e = new EmbedBuilder()
        .setTitle(idx === 0 ? "LP Positions" : "LP Positions (cont.)")
        .setColor("DarkBlue")
        .addFields(fields);
      embeds.push(e);
    });
  }

  if (embeds.length) {
    embeds[embeds.length - 1].setTimestamp();
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
