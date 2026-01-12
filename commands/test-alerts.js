// commands/test-alert.js
const { SlashCommandBuilder } = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const { getDb } = require("../db");

function requireInt(name, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("test-alert")
    .setDescription("Test alert triggering via temporary overrides (admin/testing only)")
    .addSubcommand((sc) =>
      sc
        .setName("set")
        .setDescription("Set a temporary alert override")
        // required first
        .addStringOption((o) =>
          o.setName("kind").setDescription("LP | LIQ | REDEMP").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("contract_id").setDescription("contracts.id").setRequired(true)
        )
        .addStringOption((o) =>
          o.setName("token_id").setDescription("tokenId / troveId").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("duration").setDescription("Seconds until override expires").setRequired(true)
        )
        // optional last
        .addStringOption((o) =>
          o.setName("status").setDescription("LP only: IN_RANGE | OUT_OF_RANGE | INACTIVE")
        )
        .addStringOption((o) =>
          o.setName("tier").setDescription("LOW | MEDIUM | HIGH | CRITICAL")
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("clear")
        .setDescription("Clear an alert override")
        .addStringOption((o) =>
          o.setName("kind").setDescription("LP | LIQ | REDEMP").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("contract_id").setDescription("contracts.id").setRequired(true)
        )
        .addStringOption((o) =>
          o.setName("token_id").setDescription("tokenId / troveId").setRequired(true)
        )
    )
    .addSubcommand((sc) => sc.setName("list").setDescription("List active test overrides")),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const db = getDb();

    try {
      const sub = interaction.options.getSubcommand();

      if (sub === "set") {
        const kind = interaction.options.getString("kind").toUpperCase();
        const contractId = interaction.options.getInteger("contract_id");
        const tokenId = interaction.options.getString("token_id");
        const duration = requireInt("duration", interaction.options.getInteger("duration"));

        const status = interaction.options.getString("status");
        const tier = interaction.options.getString("tier");

        if (!["LP", "LIQ", "REDEMP"].includes(kind)) {
          throw new Error("kind must be LP, LIQ, or REDEMP");
        }

        const untilMs = Date.now() + duration * 1000;

        const payload = { untilMs, active: true };
        if (status) payload.status = status.toUpperCase();
        if (tier) payload.tier = tier.toUpperCase();

        db.prepare(
          `
          INSERT INTO test_overrides (kind, contract_id, token_id, value_text, fetched_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(kind, contract_id, token_id) DO UPDATE SET
            value_text = excluded.value_text,
            fetched_at = datetime('now')
        `
        ).run(kind, contractId, String(tokenId), JSON.stringify(payload));

        await interaction.editReply(
          `✅ Set ${kind} override for contractId=${contractId}, tokenId=${tokenId} for ${duration}s`
        );
        return;
      }

      if (sub === "clear") {
        const kind = interaction.options.getString("kind").toUpperCase();
        const contractId = interaction.options.getInteger("contract_id");
        const tokenId = interaction.options.getString("token_id");

        db.prepare(`DELETE FROM test_overrides WHERE kind=? AND contract_id=? AND token_id=?`).run(
          kind,
          contractId,
          String(tokenId)
        );

        await interaction.editReply(`🧹 Cleared override ${kind}:${contractId}:${tokenId}`);
        return;
      }

      if (sub === "list") {
        const rows = db
          .prepare(
            `
            SELECT kind, contract_id, token_id, value_text
            FROM test_overrides
            ORDER BY kind, contract_id, token_id
          `
          )
          .all();

        if (!rows.length) {
          await interaction.editReply("No active test overrides.");
          return;
        }

        const lines = rows.map(
          (r) => `• ${r.kind}:${r.contract_id}:${r.token_id} → ${r.value_text}`
        );
        await interaction.editReply(lines.join("\n"));
        return;
      }
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`);
    }
  },
};
