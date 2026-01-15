// handlers/ui/ignore-spam-tx-ui.js
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
const { getDb, getOrCreateUserId } = require("../../db");
const { prepareQueries } = require("../../db/queries");
const { ephemeralFlags } = require("../../utils/discord/ephemerals");
const { shortenAddress } = require("../../utils/ethers/shortenAddress");

// ===================== UI LOCK START =====================
const IG_LOCK_TTL_MS = 2500;
const igLocks = new Map(); // actorId -> { until:number, seq:number }

function nowMs() {
  return Date.now();
}

function acquireLock(actorId) {
  const t = nowMs();
  const cur = igLocks.get(actorId);
  if (cur && cur.until > t) return null;

  const next = { until: t + IG_LOCK_TTL_MS, seq: (cur?.seq || 0) + 1 };
  igLocks.set(actorId, next);
  return next.seq;
}

function releaseLock(actorId, seq) {
  const cur = igLocks.get(actorId);
  if (!cur) return;
  if (cur.seq !== seq) return;
  igLocks.delete(actorId);
}
// ====================== UI LOCK END ======================

function kindLabelFromContractKind(kind) {
  return kind === "LP_NFT" ? "LP" : kind === "LOAN_NFT" ? "LOAN" : String(kind || "UNKNOWN");
}

// ---------- ACK helpers ----------

async function ackUpdate(i) {
  if (i.deferred || i.replied) return;
  try {
    await i.deferUpdate();
  } catch (_) {}
}

async function ackModal(i, flags) {
  if (i.deferred || i.replied) return;
  try {
    await i.deferReply({ flags });
  } catch (_) {}
}

async function replyOnce(i, content, flags) {
  try {
    if (i.deferred || i.replied) {
      await i.followUp({ content, flags });
    } else {
      await i.reply({ content, flags });
    }
  } catch (_) {}
}

// ---------- UI Components ----------

function mainButtonsRow({ userKey }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ig:add:${userKey}`)
      .setLabel("Add ignore")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ig:remove:${userKey}`)
      .setLabel("Remove ignore")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ig:done:${userKey}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Success)
  );
}

function cancelRow({ userKey }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ig:cancel:${userKey}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
}

function contractSelectRow({ userKey, contracts }) {
  const options = (contracts || []).slice(0, 25).map((c) => {
    const k = kindLabelFromContractKind(c.kind);
    return {
      label: `${k} — ${c.chain_id} — ${c.protocol || "UNKNOWN"}`.trim(),
      description: shortenAddress(c.address_eip55),
      value: String(c.id), // contractId
    };
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ig:contract:${userKey}`)
    .setPlaceholder("Select a protocol/contract")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function walletSelectRow({ userKey, contractId, wallets }) {
  const enabled = (wallets || []).filter((w) => w.is_enabled === 1);

  const options = enabled.slice(0, 25).map((w) => ({
    label: `${w.chain_id}${w.label ? ` — ${w.label}` : ""}`.trim(),
    description: shortenAddress(w.address_eip55),
    value: String(w.id), // walletId
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ig:wallet:${userKey}:${contractId}`)
    .setPlaceholder("Select the wallet that owns the NFT")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function removeIgnoreSelectRow({ userKey, ignores }) {
  const options = (ignores || []).slice(0, 25).map((r) => {
    const idText = r.token_id == null ? "(ALL)" : String(r.token_id);
    const kindLabel = kindLabelFromContractKind(r.kind);
    return {
      label: `${kindLabel} — ${r.chain_id} — ${r.protocol || "UNKNOWN"}`,
      description: `${r.wallet_label ? r.wallet_label + " " : ""}${shortenAddress(r.wallet_address)} | ID ${idText}`,
      value: String(r.id),
    };
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ig:rmselect:${userKey}`)
    .setPlaceholder("Select an ignore rule to delete")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function ignoreModal({ userKey, contractId, walletId, title }) {
  const modal = new ModalBuilder()
    .setCustomId(`ig:modal:${userKey}:${contractId}:${walletId}`)
    .setTitle(title);

  const idInput = new TextInputBuilder()
    .setCustomId("positionId")
    .setLabel("Position ID (LP tokenId or Loan troveId)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const reasonInput = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(idInput),
    new ActionRowBuilder().addComponents(reasonInput)
  );

  return modal;
}

// ---------- Renders ----------

function buildMainEmbed({ discordName, ignores }) {
  const embed = new EmbedBuilder()
    .setTitle("Ignore Spam / Scam Positions")
    .setDescription(
      [
        discordName ? `User: **${discordName}**` : null,
        "",
        "Add ignore rules for **specific** NFT positions.",
        "For loans, the ID is the **troveId**. For LPs, the ID is the **tokenId**.",
      ]
        .filter(Boolean)
        .join("\n")
    );

  if (!ignores || ignores.length === 0) {
    embed.addFields({ name: "Current ignores", value: "_None yet._" });
    return embed;
  }

  const lines = ignores.slice(0, 15).map((r) => {
    const wl = r.wallet_label ? `**${r.wallet_label}** ` : "";
    const idText = r.token_id == null ? "(ALL)" : String(r.token_id);
    const kind = kindLabelFromContractKind(r.kind);
    return `• **${kind}** ${r.chain_id} **${r.protocol || "UNKNOWN"}** | ${wl}\`${shortenAddress(r.wallet_address)}\` | ID **${idText}**`;
  });

  embed.addFields({
    name: `Current ignores (${ignores.length})`,
    value: lines.join("\n") + (ignores.length > 15 ? `\n…and ${ignores.length - 15} more` : ""),
  });

  return embed;
}

function renderMain({ actorId, discordName, userId, q }) {
  const ignores = q.selUserIgnores.all(userId);
  const embed = buildMainEmbed({ discordName, ignores });
  return { content: "", embeds: [embed], components: [mainButtonsRow({ userKey: actorId })] };
}

function renderPickContract({ actorId, contracts }) {
  const embed = new EmbedBuilder()
    .setTitle("Select Protocol / Contract")
    .setDescription("Pick the protocol/contract where the position exists.");

  if (!contracts || contracts.length === 0) {
    embed.addFields({
      name: "No contracts found",
      value: "Your `contracts` table has no enabled entries.",
    });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return {
    content: "",
    embeds: [embed],
    components: [contractSelectRow({ userKey: actorId, contracts }), cancelRow({ userKey: actorId })],
  };
}

function renderPickWallet({ actorId, contractRow, wallets }) {
  const kind = kindLabelFromContractKind(contractRow.kind);

  const embed = new EmbedBuilder()
    .setTitle("Select Wallet")
    .setDescription(
      [
        `Contract: **${kind} — ${contractRow.chain_id} — ${contractRow.protocol}**`,
        shortenAddress(contractRow.address_eip55)
          ? `Address: \`${shortenAddress(contractRow.address_eip55)}\``
          : null,
        "",
        "Pick the wallet that owns the NFT position you want to ignore.",
      ]
        .filter(Boolean)
        .join("\n")
    );

  const enabled = (wallets || []).filter((w) => w.is_enabled === 1);
  if (!enabled.length) {
    embed.addFields({ name: "No wallets", value: "You have no enabled wallets for this chain." });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return { content: "", embeds: [embed] };
}

function renderRemovePick({ actorId, ignores }) {
  const embed = new EmbedBuilder()
    .setTitle("Remove Ignore Rule")
    .setDescription("Select an ignore rule to delete.");

  if (!ignores || ignores.length === 0) {
    embed.addFields({ name: "Nothing to remove", value: "_No ignore rules exist._" });
    return { content: "", embeds: [embed], components: [cancelRow({ userKey: actorId })] };
  }

  return {
    content: "",
    embeds: [embed],
    components: [removeIgnoreSelectRow({ userKey: actorId, ignores }), cancelRow({ userKey: actorId })],
  };
}

// ---------- Router ----------

async function handleIgnoreSpamTxInteraction(interaction) {
  const isIg = typeof interaction.customId === "string" && interaction.customId.startsWith("ig:");
  const isRelevantType =
    interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.();

  if (!isRelevantType || !isIg) return false;

  const actorId = interaction.user?.id;
  if (!actorId) return false;

  // Decide ephemeral/public once for this interaction
  const ephFlags = ephemeralFlags();

  const parts = interaction.customId.split(":");
  const ns = parts[0];
  const action = parts[1];
  if (ns !== "ig") return false;

  const userKey = parts[2];
  if (!userKey || userKey !== actorId) {
    await ackUpdate(interaction);
    return true;
  }

  const seq = acquireLock(actorId);
  if (!seq) {
    await ackUpdate(interaction);
    return true;
  }

  const db = getDb();
  const q = prepareQueries(db);

  try {
    const discordName = interaction.user.globalName || interaction.user.username || null;
    const userId = getOrCreateUserId(db, { discordId: actorId, discordName });

    if (!userId) {
      await ackUpdate(interaction);
      await replyOnce(interaction, "❌ Could not create/load your user record. Try again.", ephFlags);
      return true;
    }

    // ---------- Modal submit ----------
    if (interaction.isModalSubmit?.() && action === "modal") {
      // ig:modal:<userKey>:<contractId>:<walletId>
      const contractId = Number(parts[3]);
      const walletId = Number(parts[4]);

      await ackModal(interaction, ephFlags);

      const positionIdRaw = (interaction.fields.getTextInputValue("positionId") || "").trim();
      const reason = (interaction.fields.getTextInputValue("reason") || "").trim() || null;

      if (!positionIdRaw) {
        await replyOnce(interaction, "❌ Position ID is required.", ephFlags);
        await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      if (!Number.isFinite(contractId) || !Number.isFinite(walletId)) {
        await replyOnce(interaction, "❌ Invalid modal state. Please run /ignore-spam-tx again.", ephFlags);
        await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      // Validate contract + derive position_kind
      const contractRow = q.selContractById.get(contractId);
      if (!contractRow) {
        await replyOnce(interaction, "❌ Could not load that contract. Run /ignore-spam-tx again.", ephFlags);
        await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      const positionKind =
        contractRow.kind === "LP_NFT" ? "LP" : contractRow.kind === "LOAN_NFT" ? "LOAN" : null;

      if (!positionKind) {
        await replyOnce(interaction, "❌ Unsupported contract type for ignores.", ephFlags);
        await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      // Validate wallet belongs to user + chain matches contract
      const walletRow = q.selUserWalletByIdForUser.get(walletId, userId);
      if (!walletRow) {
        await replyOnce(interaction, "❌ Invalid wallet selection. Please run /ignore-spam-tx again.", ephFlags);
        await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      if (String(walletRow.chain_id).toUpperCase() !== String(contractRow.chain_id).toUpperCase()) {
        await replyOnce(interaction, "❌ Wallet chain does not match contract chain. Please try again.", ephFlags);
        await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }

      try {
        q.upsertPositionIgnore.run({
          userId,
          positionKind,
          walletId,
          contractId,
          tokenId: positionIdRaw, // LP tokenId OR LOAN troveId
          reason,
        });
      } catch (err) {
        await replyOnce(interaction, `❌ Could not save ignore: ${err.message}`, ephFlags);
      }

      await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
      return true;
    }

    // ---------- Buttons ----------
    if (interaction.isButton?.()) {
      if (action === "done") {
        await interaction.update({ content: "✅ Done.", embeds: [], components: [] });
        return true;
      }

      if (action === "cancel") {
        await interaction.update(renderMain({ actorId, discordName, userId, q }));
        return true;
      }

      if (action === "add") {
        const lp = q.selContractsByKind.all("LP_NFT");
        const loans = q.selContractsByKind.all("LOAN_NFT");
        const contracts = [...lp, ...loans].sort((a, b) => {
          const ak = `${a.chain_id}|${a.kind}|${a.protocol || ""}|${a.contract_key || ""}`;
          const bk = `${b.chain_id}|${b.kind}|${b.protocol || ""}|${b.contract_key || ""}`;
          return ak.localeCompare(bk);
        });

        await interaction.update(renderPickContract({ actorId, contracts }));
        return true;
      }

      if (action === "remove") {
        const ignores = q.selUserIgnores.all(userId);
        await interaction.update(renderRemovePick({ actorId, ignores }));
        return true;
      }

      await ackUpdate(interaction);
      return true;
    }

    // ---------- Select menus ----------
    if (interaction.isStringSelectMenu?.()) {
      if (action === "contract") {
        await ackUpdate(interaction);

        const picked = interaction.values?.[0];
        const contractId = Number(picked);

        if (!picked || !Number.isFinite(contractId)) {
          await replyOnce(interaction, "❌ Invalid contract selection.", ephFlags);
          await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          return true;
        }

        const contractRow = q.selContractById.get(contractId);
        if (!contractRow) {
          await replyOnce(interaction, "❌ Could not load that contract.", ephFlags);
          await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          return true;
        }

        const wallets = q.selUserWalletsByChain.all(userId, contractRow.chain_id);
        const enabled = (wallets || []).filter((w) => w.is_enabled === 1);

        const base = renderPickWallet({ actorId, contractRow, wallets: enabled });

        if (!enabled.length) {
          await interaction
            .editReply({ ...base, components: [cancelRow({ userKey: actorId })] })
            .catch((err) => logger.error("[ignore-spam-tx-ui] editReply failed (no wallets):", err));
          return true;
        }

        const walletRow = walletSelectRow({ userKey: actorId, contractId, wallets: enabled });

        await interaction
          .editReply({ ...base, components: [walletRow, cancelRow({ userKey: actorId })] })
          .catch((err) => logger.error("[ignore-spam-tx-ui] editReply failed after contract select:", err));

        return true;
      }

      if (action === "wallet") {
        // ig:wallet:<userKey>:<contractId>
        const contractId = Number(parts[3]);
        const walletId = Number(interaction.values?.[0]);

        if (!Number.isFinite(contractId) || !Number.isFinite(walletId)) {
          await replyOnce(interaction, "❌ Invalid selection.", ephFlags);
          await ackUpdate(interaction);
          await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          return true;
        }

        const contractRow = q.selContractById.get(contractId);
        const kind = kindLabelFromContractKind(contractRow?.kind);
        const title = kind === "LP" ? "Ignore LP tokenId" : kind === "LOAN" ? "Ignore Loan troveId" : "Ignore Position ID";

        try {
          await interaction.showModal(ignoreModal({ userKey: actorId, contractId, walletId, title }));
        } catch (err) {
          await ackUpdate(interaction);
          await replyOnce(interaction, `❌ Could not open modal: ${err.message}`, ephFlags);
          await interaction.editReply(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        }
        return true;
      }

      if (action === "rmselect") {
        const ignoreId = Number(interaction.values?.[0]);
        if (!Number.isFinite(ignoreId)) {
          await replyOnce(interaction, "❌ Invalid selection.", ephFlags);
          await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
          return true;
        }

        q.deleteIgnoreByIdForUser.run(ignoreId, userId);
        await interaction.update(renderMain({ actorId, discordName, userId, q })).catch(() => {});
        return true;
      }
    }

    await ackUpdate(interaction);
    return true;
  } catch (err) {
    logger.error("[ignore-spam-tx-ui] router error:", err);
    await ackUpdate(interaction);
    await replyOnce(interaction, `❌ Error: ${err.message}`, ephFlags);
    return true;
  } finally {
    releaseLock(actorId, seq);
  }
}

module.exports = {
  handleIgnoreSpamTxInteraction,
  renderMain,
};
