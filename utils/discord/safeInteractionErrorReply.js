// utils/discord/safeInteractionErrorReply.js
const { ephemeralFlags } = require("./ephemerals");

/**
 * Best-effort user-facing error reply to avoid "This interaction failed".
 * Safe to call inside a catch; swallows secondary failures.
 */
async function safeInteractionErrorReply(
  interaction,
  content = "❌ Something went wrong handling that interaction."
) {
  try {
    if (!interaction?.isRepliable?.()) return;

    const flags = ephemeralFlags();

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags });
    } else {
      await interaction.reply({ content, flags });
    }
  } catch (_) {
    // Swallow secondary failures
  }
}

module.exports = { safeInteractionErrorReply };
