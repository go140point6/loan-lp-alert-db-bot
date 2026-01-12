// commands/ignore-spam-tx.js
const { SlashCommandBuilder } = require("discord.js");

const logger = require("../utils/logger");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");

// UI entrypoint
const { renderMain } = require("../handlers/ui/ignore-spam-tx-ui");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ignore-spam-tx")
    .setDescription("Ignore a scam/spam NFT position by ID (LP tokenId or Loan troveId)."),

  async execute(interaction) {
    // Decide ephemeral/public ONCE (locked on first response)
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

      // DM onboarding check (selUser keyed by users.id)
      const userRow = q.selUser.get(userId);
      const acceptsDm = userRow?.accepts_dm ?? 0;

      await ensureDmOnboarding({
        interaction,
        userId,
        discordId,
        acceptsDm,
        setUserDmStmt: q.setUserDm, // ✅ keyed by users.id
      });

      await interaction.editReply(
        renderMain({
          actorId: discordId,
          discordName,
          userId,
          q,
        })
      );
    } catch (err) {
      logger.error("Error in /ignore-spam-tx:", err);

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("An error occurred while processing `/ignore-spam-tx`.");
        } else {
          await interaction.reply({
            content: "An error occurred while processing `/ignore-spam-tx`.",
            flags: ephFlags,
          });
        }
      } catch (_) {}
    }
  },
};
