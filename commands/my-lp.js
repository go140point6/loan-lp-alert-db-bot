// commands/my-lp.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const logger = require("../utils/logger");

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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { formatBandRuler, classifyLpRangeTier } = require("../monitoring/lpMonitor");
const { applyLpTickShift, getTestOffsets } = require("../monitoring/testOffsets");
const { formatLpPositionLink, formatAddressLink } = require("../utils/links");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");
const { shortenAddress } = require("../utils/ethers/shortenAddress");

// 4 decimals, thousands separators
const fmt4 = createDecimalFormatter(0, 4);

function fmtNum(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return fmt4.format(n);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-lp")
    .setDescription("Show current monitored LP positions."),

  async execute(interaction) {
    const ephFlags = ephemeralFlags();

    try {
      await interaction.deferReply({ flags: ephFlags });

      const db = getDb();
      const q = prepareQueries(db);

      const discordId = interaction.user.id;
      const discordName = interaction.user.globalName || interaction.user.username || null;

      const userId = getOrCreateUserId(db, { discordId, discordName });

      const userRow = q.selUser.get(userId);
      const acceptsDm = userRow?.accepts_dm ?? 0;

      await ensureDmOnboarding({
        interaction,
        userId,
        discordId,
        acceptsDm,
        setUserDmStmt: q.setUserDm,
      });

      const { getLpSummaries } = require("../monitoring/lpMonitor");

      const summaries = await getLpSummaries(userId);
      const { lpRangeShiftPct } = getTestOffsets();
      const hasLpShift = Number.isFinite(lpRangeShiftPct) && lpRangeShiftPct !== 0;

      if (!summaries.length) {
        await interaction.editReply("No LP positions are currently being monitored for you.");
        return;
      }

      const displaySummaries = summaries
        .filter((s) => s.status !== "INACTIVE")
        .map((s) => {
          const out = { ...s };
        if (
          hasLpShift &&
          Number.isFinite(s.currentTick) &&
          Number.isFinite(s.tickLower) &&
          Number.isFinite(s.tickUpper) &&
          s.status !== "INACTIVE"
        ) {
          const shiftedTick = applyLpTickShift(s.currentTick, s.tickLower, s.tickUpper);
          const rangeStatus =
            Number.isFinite(shiftedTick) && shiftedTick >= s.tickLower && shiftedTick < s.tickUpper
              ? "IN_RANGE"
              : "OUT_OF_RANGE";
          const lpClass = classifyLpRangeTier(rangeStatus, s.tickLower, s.tickUpper, shiftedTick);
          out.currentTick = shiftedTick;
          out.rangeStatus = rangeStatus;
          out.lpRangeTier = lpClass.tier;
          out.lpRangeLabel = lpClass.label;
          out.lpPositionFrac = lpClass.positionFrac;
          out.lpDistanceFrac = lpClass.distanceFrac;
        }
          return out;
        });

      displaySummaries.sort((a, b) => {
        const rangeOrder = { OUT_OF_RANGE: 0, UNKNOWN: 1, IN_RANGE: 2 };
        const tierOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };

        const ra = rangeOrder[a.rangeStatus] ?? 99;
        const rb = rangeOrder[b.rangeStatus] ?? 99;
        if (ra !== rb) return ra - rb;

        const ta = tierOrder[a.lpRangeTier] ?? 99;
        const tb = tierOrder[b.lpRangeTier] ?? 99;
        if (ta !== tb) return ta - tb;

        return (a.protocol || "").localeCompare(b.protocol || "");
      });

      const descLines = [
        "Current status of your monitored LP positions.",
        "_Range status is based on the current pool tick vs your position bounds._",
        "_Amounts are estimated from liquidity + pool price; fees are current uncollected amounts when available._",
      ];

      const snapshotTimes = displaySummaries
        .map((s) => (s.snapshotAt ? String(s.snapshotAt) : null))
        .filter(Boolean)
        .map((raw) => {
          const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
          const ts = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
          return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
        })
        .filter((v) => v != null);
      if (snapshotTimes.length) {
        const latest = Math.max(...snapshotTimes);
        const ageMs = Date.now() - latest * 1000;
        const stale = ageMs > SNAPSHOT_STALE_WARN_MS;
        const warn = stale ? " ⚠️ Data may be stale." : "";
        descLines.push("");
        descLines.push(`Data captured: <t:${latest}:f>${warn}`);
      }

      const tierColorEmoji = {
        LOW: "🟩",
        MEDIUM: "🟨",
        HIGH: "🟧",
        CRITICAL: "🟥",
        UNKNOWN: "⬜",
      };

      const fields = displaySummaries.map((s) => {
        const tokenLabel = shortenTroveId(s.tokenId);
        const tokenLink = formatLpPositionLink(s.protocol, s.tokenId, tokenLabel);
        const header = `${s.protocol || "UNKNOWN_PROTOCOL"} (${s.chainId || "?"})`;
        const valueLines = [];

        const sym0 = s.token0Symbol || s.token0 || "?";
        const sym1 = s.token1Symbol || s.token1 || "?";

        if (s.pairLabel) valueLines.push(`Pair: **${s.pairLabel}**`);
        else if (sym0 && sym1) valueLines.push(`Pair: **${sym0} - ${sym1}**`);
        valueLines.push(`Token: ${tokenLink}`);
        if (s.owner) {
          const walletText = formatAddressLink(s.chainId, s.owner) || `**${shortenAddress(s.owner)}**`;
          valueLines.push(`Wallet: ${walletText}`);
        }

        // ---- NEW: principal amounts
        const a0 = fmtNum(s.amount0, 6);
        const a1 = fmtNum(s.amount1, 6);
        if (a0 != null || a1 != null) {
          const p = [];
          if (a0 != null) p.push(`**${a0} ${sym0}**`);
          if (a1 != null) p.push(`**${a1} ${sym1}**`);
          valueLines.push(`Principal: ${p.join(" + ")}`);
        }

        // ---- NEW: uncollected fees
        const f0 = fmtNum(s.fees0, 6);
        const f1 = fmtNum(s.fees1, 6);
        if (f0 != null || f1 != null) {
          const p = [];
          if (f0 != null) p.push(`**${f0} ${sym0}**`);
          if (f1 != null) p.push(`**${f1} ${sym1}**`);
          valueLines.push(`Uncollected fees: ${p.join(" + ")}`);
        }

        if (typeof s.lpPositionFrac === "number") {
          valueLines.push(
            `Position in band: **${(s.lpPositionFrac * 100).toFixed(2)}%** from lower bound`
          );
          valueLines.push(formatBandRuler(s.lpPositionFrac));
        }

        valueLines.push(`Status: **${s.status || "UNKNOWN"}**, Range: **${s.rangeStatus || "UNKNOWN"}**`);

        if (s.lpRangeTier) {
          const labelText = s.lpRangeLabel ? ` – ${s.lpRangeLabel}` : "";
          const emoji = tierColorEmoji[s.lpRangeTier] || "⬜";
          valueLines.push(`\`${emoji} Range tier: ${s.lpRangeTier}${labelText}\``);
        }


        let value = valueLines.join("\n");
        if (value.length > 1024) value = value.slice(0, 1020) + "…";

        return { name: header, value };
      });

      const MAX_EMBED_CHARS = 5200;
      const descText = descLines.join("\n");
      const embeds = [];
      let currentFields = [];
      let currentSize = 0;
      let embedIndex = 0;

      const baseSizeFor = (isFirst) =>
        (isFirst ? descText.length : 0) +
        (isFirst ? "My LP Positions".length : "My LP Positions (cont.)".length) +
        200;

      const fieldSize = (f) => (f.name?.length || 0) + (f.value?.length || 0);

      const flushEmbed = (isFirst) => {
        if (!currentFields.length) return;
        const e = new EmbedBuilder()
          .setColor("DarkRed")
          .setTitle(isFirst ? "My LP Positions" : "My LP Positions (cont.)")
          .setTimestamp();
        if (isFirst) {
          e.setDescription(descText);
          if (interaction.client?.user) e.setThumbnail(interaction.client.user.displayAvatarURL());
        }
        e.addFields(currentFields);
        embeds.push(e);
        currentFields = [];
        currentSize = 0;
      };

      currentSize = baseSizeFor(true);
      for (const f of fields) {
        const size = fieldSize(f);
        logger.debug(
          `[my-lp] field size name=${f.name?.length || 0} value=${f.value?.length || 0} total=${size}`
        );
        if (
          currentFields.length >= 25 ||
          currentSize + size > MAX_EMBED_CHARS
        ) {
          logger.debug(
            `[my-lp] flushing embed idx=${embedIndex} fields=${currentFields.length} size=${currentSize}`
          );
          flushEmbed(embedIndex === 0);
          embedIndex += 1;
          currentSize = baseSizeFor(false);
        }
        currentFields.push(f);
        currentSize += size;
      }
      flushEmbed(embedIndex === 0);
      logger.debug(
        `[my-lp] embeds=${embeds.length} totalFields=${fields.length}`
      );

      await interaction.editReply({ embeds });
    } catch (error) {
      logger.error("Error in /my-lp:", error?.stack || error?.message || error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("An error occurred while processing `/my-lp`.");
        } else {
          await interaction.reply({
            content: "An error occurred while processing `/my-lp`.",
            flags: ephFlags,
          });
        }
      } catch (_) {}
    }
  },
};
