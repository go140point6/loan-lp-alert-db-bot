// events/onReaction.js
const { getDb, getOrCreateUserId } = require("../db");
const { sendDmOrChannelNotice } = require("../utils/discord/dm");
const logger = require("../utils/logger");

const FIRELIGHT_EMOJI = "🔥";

async function fetchIfPartial(reaction) {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (_) {
      return null;
    }
  }
  if (reaction.message?.partial) {
    try {
      await reaction.message.fetch();
    } catch (_) {}
  }
  return reaction;
}

function getFirelightConfig(db) {
  return db
    .prepare(
      `
      SELECT channel_id, message_id
      FROM firelight_config
      WHERE id = 1
      LIMIT 1
    `
    )
    .get();
}

async function handleFirelightReaction({ reaction, user, isAdd }) {
  if (!user || user.bot) return;
  if (!reaction || reaction.emoji?.name !== FIRELIGHT_EMOJI) return;

  const db = getDb();
  const cfg = getFirelightConfig(db);
  if (!cfg?.message_id || !cfg?.channel_id) return;

  if (reaction.message?.id !== cfg.message_id) return;
  if (reaction.message?.channel?.id !== cfg.channel_id) return;

  const userId = getOrCreateUserId(db, {
    discordId: user.id,
    discordName: user.username,
  });

  const setUserDmStmt = db.prepare(
    `UPDATE users SET accepts_dm = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const acceptsRow = db
    .prepare(`SELECT accepts_dm FROM users WHERE id = ?`)
    .get(userId);
  const acceptsDm = acceptsRow?.accepts_dm || 0;

  const subExists = db
    .prepare(`SELECT 1 FROM firelight_subscriptions WHERE user_id = ?`)
    .get(userId);

  if (isAdd) {
    if (subExists) return;

    const dmContent =
      "Firelight subscription: You will be notified by DM when vault capacity changes.";

    const res = await sendDmOrChannelNotice({
      user,
      userId,
      discordId: user.id,
      acceptsDm,
      setUserDmStmt,
      channel: reaction.message.channel,
      dmContent,
    });

    if (!res?.canDm) {
      try {
        await reaction.users.remove(user.id);
      } catch (_) {}
      return;
    }

    db.prepare(
      `INSERT INTO firelight_subscriptions (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`
    ).run(userId);
  } else {
    db.prepare(`DELETE FROM firelight_subscriptions WHERE user_id = ?`).run(userId);

    const dmContent =
      "Firelight subscription: You have been unsubscribed. No further DMs will be sent.";

    await sendDmOrChannelNotice({
      user,
      userId,
      discordId: user.id,
      acceptsDm,
      setUserDmStmt,
      channel: reaction.message.channel,
      dmContent,
    });
  }
}

async function onReactionAdd(reaction, user) {
  const r = await fetchIfPartial(reaction);
  if (!r) return;
  try {
    await handleFirelightReaction({ reaction: r, user, isAdd: true });
  } catch (err) {
    logger.error("[firelight] reaction add failed:", err?.message || err);
  }
}

async function onReactionRemove(reaction, user) {
  const r = await fetchIfPartial(reaction);
  if (!r) return;
  try {
    await handleFirelightReaction({ reaction: r, user, isAdd: false });
  } catch (err) {
    logger.error("[firelight] reaction remove failed:", err?.message || err);
  }
}

module.exports = { onReactionAdd, onReactionRemove };
