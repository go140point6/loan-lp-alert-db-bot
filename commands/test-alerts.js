// commands/test-alerts.js
const { SlashCommandBuilder } = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const {
  adjustGlobalIrOffsetPp,
  adjustLiqPriceMultiplier,
  adjustLpRangeShiftPct,
  resetTestOffsets,
  getTestOffsets,
  getLastSeenBases,
} = require("../monitoring/testOffsets");
const logger = require("../utils/logger");

function requirePositiveNumber(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return n;
}

function signedDelta(direction, amount) {
  const n = requirePositiveNumber("amount", amount);
  return direction === "down" ? -n : n;
}

function formatState() {
  const s = getTestOffsets();
  return [
    `IR offset: ${s.irOffsetPp.toFixed(4)} pp`,
    `Price multiplier: ${s.liqPriceMultiplier.toFixed(6)}x`,
    `LP range shift: ${(s.lpRangeShiftPct * 100).toFixed(2)}% of width`,
  ].join("\n");
}

module.exports = {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName("test-alerts")
    .setDescription("Adjust in-memory offsets for alert testing (admin/testing only)")
    .addSubcommand((sc) =>
      sc
        .setName("ir")
        .setDescription("Adjust global IR by percentage points")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("up or down")
            .setRequired(true)
            .addChoices(
              { name: "up", value: "up" },
              { name: "down", value: "down" }
            )
        )
        .addNumberOption((o) =>
          o.setName("amount").setDescription("Delta in percentage points").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("liq")
        .setDescription("Adjust loan price by percent (affects liquidation risk)")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("up or down")
            .setRequired(true)
            .addChoices(
              { name: "up", value: "up" },
              { name: "down", value: "down" }
            )
        )
        .addNumberOption((o) =>
          o.setName("amount").setDescription("Percent change (e.g., 2 = 2%)").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("lp")
        .setDescription("Shift LP tick by percent of position width")
        .addStringOption((o) =>
          o
            .setName("direction")
            .setDescription("up or down")
            .setRequired(true)
            .addChoices(
              { name: "up", value: "up" },
              { name: "down", value: "down" }
            )
        )
        .addNumberOption((o) =>
          o.setName("amount").setDescription("Percent of width (e.g., 25 = 25%)").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("status").setDescription("Show current in-memory test offsets")
    )
    .addSubcommand((sc) =>
      sc.setName("reset").setDescription("Clear all in-memory test offsets")
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const sub = interaction.options.getSubcommand();

      if (sub === "ir") {
        const direction = interaction.options.getString("direction");
        const amount = interaction.options.getNumber("amount");
        const delta = signedDelta(direction, amount);
        const { irOffsetPp } = getTestOffsets();
        const { globalIrPp } = getLastSeenBases();
        adjustGlobalIrOffsetPp(delta);
        const before = globalIrPp != null ? globalIrPp + irOffsetPp : null;
        const after = globalIrPp != null ? globalIrPp + irOffsetPp + delta : null;
        const liveMsg =
          before != null && after != null
            ? ` (live: ${before.toFixed(2)}pp -> ${after.toFixed(2)}pp)`
            : " (live: unknown -> unknown)";
        const label = delta >= 0 ? "up" : "down";
        const amountAbs = Math.abs(delta);
        const msg = `[test-alerts] IR bump ${label} ${amountAbs}pp${liveMsg}`;
        logger.debug(msg);
        await interaction.editReply(`✅ Global IR offset adjusted by ${delta} pp\n${formatState()}`);
        return;
      }

      if (sub === "liq") {
        const direction = interaction.options.getString("direction");
        const amount = interaction.options.getNumber("amount");
        const deltaPct = signedDelta(direction, amount);
        const factor = 1 + deltaPct / 100;
        if (factor <= 0) throw new Error("price multiplier would be <= 0");
        const { liqPriceMultiplier } = getTestOffsets();
        const { price } = getLastSeenBases();
        adjustLiqPriceMultiplier(factor);
        const before = price != null ? price * liqPriceMultiplier : null;
        const after = price != null ? price * liqPriceMultiplier * factor : null;
        const label = deltaPct >= 0 ? "up" : "down";
        const amountAbs = Math.abs(deltaPct);
        const liveMsg =
          before != null && after != null
            ? ` (live: ${before.toFixed(2)} -> ${after.toFixed(2)})`
            : " (live: unknown -> unknown)";
        const msg = `[test-alerts] Price bump ${label} ${amountAbs.toFixed(2)}%${liveMsg}`;
        logger.debug(msg);
        await interaction.editReply(
          `✅ Price multiplier adjusted by ${factor.toFixed(6)}x\n${formatState()}`
        );
        return;
      }

      if (sub === "lp") {
        const direction = interaction.options.getString("direction");
        const amount = interaction.options.getNumber("amount");
        const deltaPct = signedDelta(direction, amount) / 100;
        const { lpRangeShiftPct } = getTestOffsets();
        const { lpTick, lpWidth } = getLastSeenBases();
        adjustLpRangeShiftPct(deltaPct);
        const before = lpTick != null && lpWidth != null ? lpTick + Math.round(lpWidth * lpRangeShiftPct) : null;
        const after =
          lpTick != null && lpWidth != null
            ? lpTick + Math.round(lpWidth * (lpRangeShiftPct + deltaPct))
            : null;
        const label = deltaPct >= 0 ? "up" : "down";
        const amountAbs = Math.abs(deltaPct * 100);
        const liveMsg =
          before != null && after != null
            ? ` (live: ${before} -> ${after})`
            : " (live: unknown -> unknown)";
        const msg = `[test-alerts] LP bump ${label} ${amountAbs.toFixed(2)}% of width${liveMsg}`;
        logger.debug(msg);
        await interaction.editReply(
          `✅ LP range shift adjusted by ${(deltaPct * 100).toFixed(2)}%\n${formatState()}`
        );
        return;
      }

      if (sub === "status") {
        await interaction.editReply(`Current test offsets:\n${formatState()}`);
        return;
      }

      if (sub === "reset") {
        resetTestOffsets();
        await interaction.editReply(`🧹 Cleared all test offsets\n${formatState()}`);
        return;
      }
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`);
    }
  },
};
