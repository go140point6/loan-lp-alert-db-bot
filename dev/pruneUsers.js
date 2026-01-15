// dev/pruneUsers.js
// Remove all users except the primary dev user (id=1 / discord_id=567425551229386758).
// Uses the unified DB entrypoint to avoid path drift.
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");
const { openDb, dbFile } = require("../db");

const KEEP_USER_ID = 1;
const KEEP_DISCORD_ID = "567425551229386758";

const db = openDb({ fileMustExist: true });

try {
  const keepRow = db
    .prepare("SELECT id, discord_id, discord_name FROM users WHERE id = ?")
    .get(KEEP_USER_ID);

  if (!keepRow) {
    logger.error(
      `Abort: no users row with id=${KEEP_USER_ID}. Refusing to delete other users.`
    );
    process.exit(1);
  }

  if (String(keepRow.discord_id) !== KEEP_DISCORD_ID) {
    logger.error(
      `Abort: users.id=${KEEP_USER_ID} has discord_id=${keepRow.discord_id}, expected ${KEEP_DISCORD_ID}.`
    );
    process.exit(1);
  }

  const countAll = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
  const countToDelete = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE id <> ?")
    .get(KEEP_USER_ID).cnt;

  if (countToDelete === 0) {
    logger.info(`No users to delete. users total=${countAll}.`);
    process.exit(0);
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM users WHERE id <> ?").run(KEEP_USER_ID);
  });
  tx();

  const countRemaining = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
  logger.info(
    `Deleted ${countToDelete} user(s). Remaining users=${countRemaining}. Kept id=${KEEP_USER_ID}.`
  );
} catch (err) {
  logger.error("Failed to prune users:", err?.message || err);
  process.exit(1);
} finally {
  db.close();
}
