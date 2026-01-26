// ./events/onMessage.js
const { PermissionsBitField } = require("discord.js");

const { getDb } = require("../db");
const logger = require("../utils/logger");
const { buildFirelightMessage, readFirelightState } = require("../jobs/firelightJob");

async function onMessage(message) {
  if (!message || message.author?.bot) return;
  if (!message.guild) return;

  const content = (message.content || "").trim();
  if (!content.startsWith("!!")) return;

  const [rawCmd] = content.slice(2).split(/\s+/);
  const cmd = (rawCmd || "").toLowerCase();
  if (!cmd) return;

  const hasPerm = message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild);
  if (!hasPerm) {
    await message.reply("You do not have permission to run this command.");
    return;
  }

  if (cmd === "help") {
    const lines = [
      "**Liquidity Sentinel Commands**",
      "",
      "User commands:",
      "• `/my-wallets` — manage wallets and labels",
      "• `/my-loans` — show monitored loan positions",
      "• `/my-lp` — show monitored LP positions",
      "• `/ignore-spam-tx` — manage ignored positions",
      "",
      "Info commands:",
      "• `/entities` — system entities",
      "• `/states` — authority states",
      "",
      "Admin commands:",
      "• `!!postfirelight` — post the Firelight signal message",
      "• `!!editfirelight` — refresh the Firelight signal message",
    ];
    await message.reply(lines.join("\n"));
    return;
  }

  if (cmd !== "postfirelight" && cmd !== "editfirelight") return;

  const channelId = process.env.FIRELIGHT_CHANNEL_ID;
  if (!channelId) {
    await message.reply("Missing FIRELIGHT_CHANNEL_ID in .env.");
    return;
  }

  const channel = await message.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await message.reply("Firelight channel not found or not text-based.");
    return;
  }

  let state = "UNKNOWN";
  try {
    const res = await readFirelightState();
    state = res.state;
  } catch (err) {
    logger.warn("[firelight] Failed to read vault state in command", err?.message || err);
  }

  const contentText = buildFirelightMessage(state);
  const db = getDb();

  if (cmd === "postfirelight") {
    const msg = await channel.send({ content: contentText });
    try {
      await msg.react("🔥");
    } catch (_) {}

    db.prepare(
      `
      INSERT INTO firelight_config (id, channel_id, message_id, last_state, last_checked_at)
      VALUES (1, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        last_state = excluded.last_state,
        last_checked_at = excluded.last_checked_at,
        updated_at = datetime('now')
    `
    ).run(channelId, msg.id, state);

    await message.reply("Firelight message posted.");
    return;
  }

  if (cmd === "editfirelight") {
    const cfg = db
      .prepare(`SELECT channel_id, message_id FROM firelight_config WHERE id = 1`)
      .get();

    if (!cfg?.message_id) {
      await message.reply("No Firelight message found. Run !!postfirelight first.");
      return;
    }

    const targetChannel = await message.client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!targetChannel || !targetChannel.isTextBased()) {
      await message.reply("Stored Firelight channel not found.");
      return;
    }

    const msg = await targetChannel.messages.fetch(cfg.message_id).catch(() => null);
    if (!msg) {
      await message.reply("Stored Firelight message not found.");
      return;
    }

    await msg.edit(contentText);
    db.prepare(
      `
      UPDATE firelight_config
      SET last_state = ?, last_checked_at = datetime('now'), updated_at = datetime('now')
      WHERE id = 1
    `
    ).run(state);

    await message.reply("Firelight message updated.");
  }
}

module.exports = { onMessage };
