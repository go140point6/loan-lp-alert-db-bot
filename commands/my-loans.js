// commands/my-loans.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const logger = require("../utils/logger");

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fmt4 = createDecimalFormatter(0, 4);
const fmt5 = createDecimalFormatter(0, 5);

function fmtNum(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt4.format(n);
}

function fmtNum5(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt5.format(n);
}

function shortId(id, head = 4, tail = 4) {
  if (id == null) return "?";
  const s = String(id);
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-loans")
    .setDescription("Show current monitored loan positions."),

  async execute(interaction) {
    // Decide ephemeral/public ONCE at the start (locked on first response)
    const ephFlags = ephemeralFlags();

    try {
      // Ephemeral in prod, public in testing when EPHEMERALS_OFF=1
      await interaction.deferReply({ flags: ephFlags });

      const db = getDb();
      const q = prepareQueries(db);

      const discordId = interaction.user.id;
      const discordName = interaction.user.globalName || interaction.user.username || null;

      // Ensure user exists + keep name updated
      const userId = getOrCreateUserId(db, { discordId, discordName });

      // DM onboarding check (keyed by users.id)
      const userRow = q.selUser.get(userId);
      const acceptsDm = userRow?.accepts_dm ?? 0;

      await ensureDmOnboarding({
        interaction,
        userId,
        discordId, // logging only
        acceptsDm,
        setUserDmStmt: q.setUserDm, // UPDATE users SET accepts_dm=? WHERE id=?
      });

      // Recommended approach: use summaries (no alert side-effects)
      const { getLoanSummaries, getCdpPrice, classifyCdpRedemptionState } = require("../monitoring/loanMonitor");

      const summaries = await getLoanSummaries(userId);

      if (!summaries.length) {
        await interaction.editReply("No loan positions are currently being monitored for you.");
        return;
      }

      // Sort by LTV descending (most risky first)
      summaries.sort((a, b) => {
        const av = typeof a.ltvPct === "number" ? a.ltvPct : -1;
        const bv = typeof b.ltvPct === "number" ? b.ltvPct : -1;
        return bv - av;
      });

      // CDP context (loanMonitor now supports getCdpPrice() with no args)
      let cdpPrice = null;
      let cdpState = { state: "UNKNOWN", trigger: null, diff: null, label: "no CDP price available" };

      try {
        cdpPrice = await getCdpPrice();
        cdpState = classifyCdpRedemptionState(cdpPrice);
      } catch (e) {
        logger.warn("[my-loans] CDP price/state unavailable:", e?.message || e);
      }

      const descLines = ["Current status of your monitored loan positions."];

      if (cdpPrice == null) {
        descLines.push("CDP price: *(unknown; CDP price source unavailable)*");
      } else {
        descLines.push(
        `CDP: **${fmtNum(cdpPrice)} USD**, redemption state **${cdpState.state}** ` +
          `(trigger **${fmtNum(Number(cdpState.trigger))}**, ${cdpState.label}).`
        );
      }

      const fields = summaries.map((s) => {
        const rawId = s.troveId ?? s.tokenId ?? s.positionId ?? "?";
        const header = `${s.protocol || "UNKNOWN_PROTOCOL"} (${s.chainId || "?"}) — ${shortId(rawId)}`;

        const valueLines = [];

        valueLines.push(`Status: **${s.status || "UNKNOWN"}**`);

        if (s.hasPrice && typeof s.price === "number" && typeof s.liquidationPrice === "number") {
          const ltvText = typeof s.ltvPct === "number" ? `${s.ltvPct.toFixed(2)}%` : "n/a";
          const liqBufferText =
            typeof s.liquidationBufferFrac === "number"
              ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
              : "n/a";

          valueLines.push(`LTV: **${ltvText}**`);
          valueLines.push(`Price / Liq: **${fmtNum5(s.price)} / ${fmtNum5(s.liquidationPrice)}**`);
          valueLines.push(`Liq buffer: **${liqBufferText}** (tier **${s.liquidationTier || "UNKNOWN"}**)`);
        } else {
          valueLines.push("Price / liquidation: *(unavailable; cannot compute LTV / buffer)*");
        }

        if (typeof s.collAmount === "number") {
          valueLines.push(`Collateral: **${fmtNum(s.collAmount)} ${s.collSymbol || ""}**`.trim());
        }
        if (typeof s.debtAmount === "number") {
          valueLines.push(`Debt: **${fmtNum(s.debtAmount)}**`);
        }

        if (typeof s.interestPct === "number") {
          let irLine = `IR: **${s.interestPct.toFixed(2)}% p.a.**`;
          if (typeof s.globalIrPct === "number") {
            irLine += ` vs global **${s.globalIrPct.toFixed(2)}%**`;
          }
          valueLines.push(irLine);

          if (s.redemptionTier) {
            const diff =
              typeof s.redemptionDiffPct === "number"
                ? ` (Δ ${s.redemptionDiffPct >= 0 ? "+" : ""}${s.redemptionDiffPct.toFixed(2)} pp vs global)`
                : "";
            valueLines.push(`Redemption tier (IR-based): **${s.redemptionTier}**${diff}`);
          }
        }

        let value = valueLines.join("\n");
        if (value.length > 1024) value = value.slice(0, 1020) + "…";

        return { name: header, value };
      });

      const fieldChunks = chunk(fields, 25).slice(0, 10);

      const embeds = fieldChunks.map((fc, idx) => {
        const e = new EmbedBuilder()
          .setColor("DarkBlue")
          .setTitle(idx === 0 ? "My Loan Positions" : "My Loan Positions (cont.)")
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
      logger.error("Error in /my-loans:", error?.stack || error?.message || error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("An error occurred while processing `/my-loans`.");
        } else {
          await interaction.reply({
            content: "An error occurred while processing `/my-loans`.",
            flags: ephFlags,
          });
        }
      } catch (_) {}
    }
  },
};
