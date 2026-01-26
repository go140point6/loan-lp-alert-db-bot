// utils/discord/dm.js
const logger = require("../logger");
const { ephemeralFlags } = require("./ephemerals");

/**
 * DM policy (no probe):
 * - If accepts_dm=0: attempt ONE onboarding DM. If success, set to 1.
 * - If accepts_dm=1: do nothing (no DM, no probe).
 *
 * IMPORTANT:
 * - Persisting DM capability is keyed by users.id (DB PK) in the NEW schema.
 * - discordId is only used for Discord messaging, not as a DB key.
 * - If a real alert DM fails later, alertEngine can set accepts_dm back to 0.
 */
async function ensureDmOnboarding({
  interaction,
  userId,         // NEW: required DB PK
  discordId,      // used for logging only (interaction.user is source of truth for DM)
  acceptsDm,
  setUserDmStmt,  // must be keyed by userId: UPDATE users SET accepts_dm=? WHERE id=?
}) {
  if (!userId) {
    throw new Error("ensureDmOnboarding: userId is required (users.id PK)");
  }
  if (!setUserDmStmt || typeof setUserDmStmt.run !== "function") {
    throw new Error("ensureDmOnboarding: setUserDmStmt is required (must have .run)");
  }

  const accepts = Number(acceptsDm) === 1;
  if (accepts) {
    logger.debug("[dm] onboarding skipped (already accepted)", { userId, discordId });
    return { canDm: true, changed: false, skippedProbe: true };
  }

  try {
    await interaction.user.send("👍 I can DM you! You’ll receive alerts here.");
    setUserDmStmt.run(1, userId);
    logger.info("[dm] onboarding DM sent successfully", { userId, discordId });
    return { canDm: true, changed: true };
  } catch (err) {
    // Persist “cannot DM” so we don’t keep trying on every command.
    setUserDmStmt.run(0, userId);

    logger.warn("[dm] onboarding DM failed", {
      userId,
      discordId,
      error: err?.message || String(err),
    });

    // Ephemeral warning in the interaction UI (toggleable via EPHEMERALS_OFF)
    try {
      await interaction.followUp({
        content:
          "⚠️ I wasn't able to send you a DM. Enable DMs from server members in **User Settings → Privacy & Safety** if you'd like alerts.",
        flags: ephemeralFlags(),
      });
    } catch (_) {
      // Best-effort: UI feedback failure is non-fatal
    }

    return { canDm: false, changed: false, error: err?.message || String(err) };
  }
}

async function sendChannelEphemeral(channel, content, ttlMs = 15000) {
  if (!channel || typeof channel.send !== "function") return;
  try {
    const msg = await channel.send({ content });
    setTimeout(() => {
      msg.delete().catch(() => {});
    }, ttlMs);
  } catch (_) {}
}

async function sendDmOrChannelNotice({
  user,
  userId,
  discordId,
  acceptsDm,
  setUserDmStmt,
  channel,
  dmContent,
}) {
  if (!userId) {
    throw new Error("sendDmOrChannelNotice: userId is required (users.id PK)");
  }
  if (!setUserDmStmt || typeof setUserDmStmt.run !== "function") {
    throw new Error("sendDmOrChannelNotice: setUserDmStmt is required (must have .run)");
  }
  if (!user || typeof user.send !== "function") {
    throw new Error("sendDmOrChannelNotice: user is required");
  }

  const warnText =
    "⚠️ I wasn't able to send you a DM. Enable DMs from server members in **User Settings → Privacy & Safety** if you'd like alerts.";

  const accepts = Number(acceptsDm) === 1;
  if (accepts) {
    try {
      await user.send(dmContent);
      return { canDm: true, sent: true, skippedProbe: true };
    } catch (err) {
      setUserDmStmt.run(0, userId);
      logger.warn("[dm] direct DM failed (previously accepted)", {
        userId,
        discordId,
        error: err?.message || String(err),
      });
      await sendChannelEphemeral(channel, warnText);
      return { canDm: false, sent: false, error: err?.message || String(err) };
    }
  }

  try {
    await user.send(dmContent);
    setUserDmStmt.run(1, userId);
    logger.info("[dm] direct DM sent successfully", { userId, discordId });
    return { canDm: true, sent: true };
  } catch (err) {
    setUserDmStmt.run(0, userId);
    logger.warn("[dm] direct DM failed", {
      userId,
      discordId,
      error: err?.message || String(err),
    });
    await sendChannelEphemeral(channel, warnText);
    return { canDm: false, sent: false, error: err?.message || String(err) };
  }
}

module.exports = { ensureDmOnboarding, sendDmOrChannelNotice };
