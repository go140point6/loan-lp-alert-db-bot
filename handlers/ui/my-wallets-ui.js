// handlers/ui/my-wallets-ui.js
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require("discord.js");

const logger = require("../../utils/logger");

const { getDb, getOrCreateUserId, getOrCreateWalletId } = require("../../db");
const { prepareQueries } = require("../../db/queries");
const { ephemeralFlags } = require("../../utils/discord/ephemerals");
const { shortenAddress } = require("../../utils/ethers/shortenAddress");

// ===================== UI LOCK START =====================
// One in-flight mw action per user. Everything else is ACKed and ignored.
const MW_LOCK_TTL_MS = 2500;
const mwLocks = new Map(); // actorId -> { until:number, seq:number }

function nowMs() {
  return Date.now();
}

function acquireLock(actorId) {
  const t = nowMs();
  const cur = mwLocks.get(actorId);
  if (cur && cur.until > t) return null; // locked

  const next = { until: t + MW_LOCK_TTL_MS, seq: (cur?.seq || 0) + 1 };
  mwLocks.set(actorId, next);
  return next.seq;
}

function releaseLock(actorId, seq) {
  const cur = mwLocks.get(actorId);
  if (!cur) return;
  if (cur.seq !== seq) return;
  mwLocks.delete(actorId);
}
// ====================== UI LOCK END ======================

// ---------------- UI helpers ----------------

function buildWalletsEmbed({ discordName, wallets }) {
  const embed = new EmbedBuilder()
    .setTitle("My Wallets")
    .setDescription(
      [
        discordName ? `User: **${discordName}**` : null,
        "",
        "Add or remove wallets you want monitored.",
      ]
        .filter(Boolean)
        .join("\n")
    );

  const enabled = (wallets || []).filter((w) => w.is_enabled === 1);

  if (!enabled.length) {
    embed.addFields({ name: "Wallets", value: "_No wallets added yet._" });
    return embed;
  }

  const byChain = new Map();
  for (const w of enabled) {
    const k = w.chain_id || "UNKNOWN";
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(w);
  }

  for (const [chain, list] of byChain.entries()) {
    const lines = list.map((w) => {
      const label = w.label ? `**${w.label}** ` : "";
      return `• ${label}\`${shortenAddress(w.address_eip55)}\``;
    });
    embed.addFields({ name: chain, value: lines.join("\n"), inline: false });
  }

  return embed;
}

function mainButtonsRow({ userKey }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mw:add:${userKey}`)
      .setLabel("Add wallet")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mw:remove:${userKey}`)
      .setLabel("Remove wallet")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mw:done:${userKey}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Success)
  );
}

function cancelRow({ userKey }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mw:cancel:${userKey}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function chainSelectRow({ userKey, chains }) {
  const options = (chains || [])
    .filter((c) => c && c.id != null && String(c.id).trim() !== "")
    .map((c) => ({
      label: `${String(c.id).trim()} — ${c.name != null ? String(c.name) : ""}`.trim(),
      value: String(c.id).trim(),
    }))
    .slice(0, 25);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mw:chain:${userKey}`)
    .setPlaceholder("Select a chain")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function removeSelectRow({ userKey, wallets }) {
  const enabled = (wallets || []).filter((w) => w.is_enabled === 1);

  const options = enabled.slice(0, 25).map((w) => ({
    label: `${w.chain_id} ${w.label ? `— ${w.label}` : ""}`.trim(),
    description: shortenAddress(w.address_eip55),
    value: String(w.id),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mw:rmselect:${userKey}`)
    .setPlaceholder("Select a wallet to disable")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function walletModal({ userKey, chainId }) {
  const modal = new ModalBuilder()
    .setCustomId(`mw:modal:${userKey}:${chainId}`)
    .setTitle(`Add Wallet (${chainId})`);

  const addressInput = new TextInputBuilder()
    .setCustomId("address")
    .setLabel("Wallet address (0x… or xdc…)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const labelInput = new TextInputBuilder()
    .setCustomId("label")
    .setLabel("Label (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(addressInput),
    new ActionRowBuilder().addComponents(labelInput)
  );

  return modal;
}

// ---------------- Renders ----------------

function renderMain({ actorId, discordName, userId, q }) {
  const wallets = q.selUserWallets.all(userId);
  const embed = buildWalletsEmbed({ discordName, wallets });
  return { content: "", embeds: [embed], components: [mainButtonsRow({ userKey: actorId })] };
}

function renderChainPick({ actorId, q }) {
  const chainsRaw = q.selChains.all();
  const chains = (chainsRaw || []).filter((c) => c && c.id != null && String(c.id).trim() !== "");

  const embed = new EmbedBuilder()
    .setTitle("Add Wallet")
    .setDescription("Pick the chain for the wallet you want to add.");

  if (!chains.length) {
    embed.addFields({
      name: "No chains configured",
      value: "The `chains` table has no valid chain IDs.",
    });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return {
    content: "",
    embeds: [embed],
    components: [chainSelectRow({ userKey: actorId, chains }), cancelRow({ userKey: actorId })],
  };
}

function renderRemovePick({ actorId, userId, q }) {
  const wallets = q.selUserWallets.all(userId);
  const enabled = wallets.filter((w) => w.is_enabled === 1);

  const embed = new EmbedBuilder()
    .setTitle("Remove Wallet")
    .setDescription("Select a wallet to disable (it won’t be monitored).");

  if (!enabled.length) {
    embed.addFields({ name: "Wallets", value: "_No enabled wallets to remove._" });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return {
    content: "",
    embeds: [embed],
    components: [removeSelectRow({ userKey: actorId, wallets }), cancelRow({ userKey: actorId })],
  };
}

// ---------------- ACK helpers ----------------

async function ackUpdate(i) {
  // Buttons/selects only (silent)
  if (i.deferred || i.replied) return;
  try {
    await i.deferUpdate();
  } catch (_) {}
}

async function replyOnce(i, content, flags) {
  // Used only for real errors; avoid spamming confirmations
  try {
    if (i.deferred || i.replied) {
      await i.followUp({ content, flags });
    } else {
      await i.reply({ content, flags });
    }
  } catch (_) {}
}

/**
 * Handle all mw:* interactions.
 * Returns true if handled, false if not ours.
 */
async function handleMyWalletsInteraction(interaction) {
  const isMw = typeof interaction.customId === "string" && interaction.customId.startsWith("mw:");
  const isRelevantType =
    interaction.isButton?.() ||
    interaction.isStringSelectMenu?.() ||
    interaction.isModalSubmit?.();

  if (!isRelevantType || !isMw) return false;

  const actorId = interaction.user?.id;
  if (!actorId) return false;

  // Decide ephemeral/public once for this interaction
  const ephFlags = ephemeralFlags();

  // Parse early
  const parts = interaction.customId.split(":");
  const ns = parts[0];
  const action = parts[1];
  if (ns !== "mw") return false;

  // Scope check (mw:<action>:<userKey> or mw:modal:<userKey>:<chainId>)
  const userKey = parts[2];
  if (!userKey || userKey !== actorId) {
    await ackUpdate(interaction);
    return true;
  }

  // Acquire lock per user
  const seq = acquireLock(actorId);
  if (!seq) {
    await ackUpdate(interaction);
    return true;
  }

  const db = getDb();
  const q = prepareQueries(db);

  try {
    const discordName = interaction.user.globalName || interaction.user.username || null;

    // NEW: Canonical user lookup/creation (no selUserByDiscordId dependency)
    const userId = getOrCreateUserId(db, { discordId: actorId, discordName });
    if (!userId) {
      await ackUpdate(interaction);
      await replyOnce(interaction, "❌ Could not create/load your user record. Try /my-wallets again.", ephFlags);
      return true;
    }

    // ---------------- Modal submit ----------------
    if (interaction.isModalSubmit?.() && action === "modal") {
      const chainId = parts[3];

      // ACK the modal submit
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: ephFlags }).catch(() => {});
      }

      const addressInput = interaction.fields.getTextInputValue("address");
      const labelInput = (interaction.fields.getTextInputValue("label") || "").trim() || null;

      try {
        getOrCreateWalletId(db, { userId, chainId, addressInput, label: labelInput });
      } catch (err) {
        await interaction.editReply({ content: `❌ Could not save wallet: ${err.message}` }).catch(() => {});
        return true;
      }

      // Render the updated UI as the modal response (reliable)
      await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
      return true;
    }

    // ---------------- Buttons ----------------
    if (interaction.isButton?.()) {
      if (action === "done") {
        await interaction.update({ content: "✅ Done.", embeds: [], components: [] }).catch(() => {});
        return true;
      }

      if (action === "cancel") {
        await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      if (action === "add") {
        await interaction.update(renderChainPick({ actorId, q })).catch(() => {});
        return true;
      }

      if (action === "remove") {
        await interaction.update(renderRemovePick({ actorId, userId, q })).catch(() => {});
        return true;
      }

      await ackUpdate(interaction);
      return true;
    }

    // ---------------- Select menus ----------------
    if (interaction.isStringSelectMenu?.()) {
      if (action === "chain") {
        const chainId = interaction.values?.[0];

        // showModal is the ACK for select menu interactions
        try {
          await interaction.showModal(walletModal({ userKey: actorId, chainId }));
        } catch (err) {
          await ackUpdate(interaction);
          await replyOnce(interaction, `❌ Could not open the modal: ${err.message}`, ephFlags);
          await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        }
        return true;
      }

      if (action === "rmselect") {
        const walletIdStr = interaction.values?.[0];
        const walletId = Number(walletIdStr);

        if (!Number.isFinite(walletId)) {
          await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          await replyOnce(interaction, "❌ Invalid wallet selection.", ephFlags);
          return true;
        }

        q.disableWallet.run(walletId, userId);
        await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }
    }

    await ackUpdate(interaction);
    return true;
  } catch (err) {
    logger.error("[my-wallets-ui] router error:", err);
    await ackUpdate(interaction);
    await replyOnce(interaction, `❌ Error: ${err.message}`, ephFlags);
    return true;
  } finally {
    releaseLock(actorId, seq);
  }
}

module.exports = {
  handleMyWalletsInteraction,
  renderMain,
};
