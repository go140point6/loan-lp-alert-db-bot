// commands/my-wallets.js
const { SlashCommandBuilder } = require("discord.js");

const logger = require("../utils/logger");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");

// Router UI entrypoint
const { renderMain } = require("../handlers/ui/my-wallets-ui");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-wallets")
    .setDescription("Manage wallets used for monitoring (FLR/XDC)."),

  async execute(interaction) {
    // Decide ephemeral/public ONCE (locked on first response)
    const ephFlags = ephemeralFlags();

    try {
      // Ephemeral in prod, public in testing when EPHEMERALS_OFF=1
      await interaction.deferReply({ flags: ephFlags });

      const db = getDb();
      const q = prepareQueries(db);

      const discordId = interaction.user.id;
      const discordName =
        interaction.user.globalName || interaction.user.username || null;

      // Ensure user exists + keep name updated
      const userId = getOrCreateUserId(db, { discordId, discordName });

      // DM onboarding check
      // IMPORTANT: selUser should be keyed by *userId* (DB PK), not discordId
      const userRow = q.selUser.get(userId);
      const acceptsDm = userRow?.accepts_dm ?? 0;

      await ensureDmOnboarding({
        interaction,
        userId,
        discordId,
        acceptsDm,
        setUserDmStmt: q.setUserDm,
      });

      // Initial UI render (router will handle subsequent mw:* interactions)
      await interaction.editReply(
        renderMain({
          actorId: discordId,
          discordName,
          userId,
          q,
        })
      );
    } catch (err) {
      logger.error("Error in /my-wallets:", err);

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("An error occurred while processing `/my-wallets`.");
        } else {
          await interaction.reply({
            content: "An error occurred while processing `/my-wallets`.",
            flags: ephFlags,
          });
        }
      } catch (_) {}
    }
  },
};
