// commands/my-lp.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const logger = require("../utils/logger");

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { formatBandRuler } = require("../monitoring/lpMonitor");

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

      if (!summaries.length) {
        await interaction.editReply("No LP positions are currently being monitored for you.");
        return;
      }

      summaries.sort((a, b) => {
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

      const tierColorEmoji = {
        LOW: "🟩",
        MEDIUM: "🟨",
        HIGH: "🟧",
        CRITICAL: "🟥",
        UNKNOWN: "⬜",
      };

      const fields = summaries.map((s) => {
        const header = `${s.protocol || "UNKNOWN_PROTOCOL"} (${s.chainId || "?"}) - ${s.tokenId}`;
        const valueLines = [];

        const sym0 = s.token0Symbol || s.token0 || "?";
        const sym1 = s.token1Symbol || s.token1 || "?";

        if (s.pairLabel) valueLines.push(`Pair: **${s.pairLabel}**`);
        else if (sym0 && sym1) valueLines.push(`Pair: **${sym0} - ${sym1}**`);

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
          valueLines.push("```" + `${emoji} Range tier: ${s.lpRangeTier}${labelText}` + "```");
        }

        let value = valueLines.join("\n");
        if (value.length > 1024) value = value.slice(0, 1020) + "…";

        return { name: header, value };
      });

      const fieldChunks = chunk(fields, 25).slice(0, 10);

      const embeds = fieldChunks.map((fc, idx) => {
        const e = new EmbedBuilder()
          .setColor("DarkRed")
          .setTitle(idx === 0 ? "My LP Positions" : "My LP Positions (cont.)")
          .setTimestamp();

        if (idx === 0) {
          e.setDescription(descLines.join("\n"));
          if (interaction.client?.user) e.setThumbnail(interaction.client.user.displayAvatarURL());
        }

        e.addFields(fc);
        return e;
      });

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
