// events/onInteraction.js
const logger = require("../utils/logger");

const { handleUiInteractionRouters } = require("../handlers/ui");
const { safeInteractionErrorReply } = require("../utils/discord/safeInteractionErrorReply");
const { ephemeralFlags } = require("../utils/discord/ephemerals");

// UI interactions = buttons/selects/modals
function isUiInteraction(i) {
  return i.isButton?.() || i.isStringSelectMenu?.() || i.isModalSubmit?.();
}

/**
 * If a UI interaction wasn't handled by any router,
 * ACK it so the user doesn't see "Interaction Failed".
 *
 * - Buttons/selects: deferUpdate() is a safe silent ACK
 * - Modals: MUST reply/deferReply; deferUpdate() is invalid for modals
 */
async function ackUnhandledUiInteraction(interaction) {
  if (!isUiInteraction(interaction)) return;
  if (interaction.deferred || interaction.replied) return;

  try {
    if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
      await interaction.deferUpdate(); // silent ACK for message components
      return;
    }

    if (interaction.isModalSubmit?.()) {
      // Respect global EPHEMERALS_OFF toggle
      await interaction.deferReply({ flags: ephemeralFlags() });
      // Optional: uncomment if you want user feedback instead of a silent defer
      // await interaction.editReply("⚠️ This action is no longer valid. Please run the command again.");
      return;
    }
  } catch (_) {
    // swallow
  }
}

async function onInteraction(interaction) {
  try {
    // ---- Focused logger for mw:* / ist:* UI interactions ----
    if (isUiInteraction(interaction) && typeof interaction.customId === "string") {
      const cid = interaction.customId;
      if (cid.startsWith("mw:") || cid.startsWith("ist:")) {
        logger.debug(`[ui] customId=${cid} user=${interaction.user?.id}`);
      }
    }

    // ============================================================
    // ROUTERS FIRST: handle components/modals before slash commands
    // ============================================================
    if (isUiInteraction(interaction)) {
      const handled = await handleUiInteractionRouters(interaction);
      if (!handled) {
        await ackUnhandledUiInteraction(interaction);
      }
      return;
    }

    // ---- Autocomplete ----
    if (interaction.isAutocomplete?.()) {
      const command = interaction.client?.commands?.get(interaction.commandName);
      if (command?.autocomplete) {
        await command.autocomplete(interaction);
      }
      return;
    }

    // ---- Slash commands ----
    if (interaction.isChatInputCommand?.()) {
      const command = interaction.client?.commands?.get(interaction.commandName);

      if (!command) {
        logger.warn(`[onInteraction] Unknown command: ${interaction.commandName}`);
        await safeInteractionErrorReply(interaction, "❌ Unknown command.");
        return;
      }

      await command.execute(interaction);
      return;
    }

    // Ignore everything else
  } catch (err) {
    logger.error("[onInteraction] Error handling interaction:", err);

    // Best-effort ACK to avoid red banner
    await ackUnhandledUiInteraction(interaction);

    // Best-effort user-facing error message
    await safeInteractionErrorReply(interaction);
  }
}

module.exports = { onInteraction };
