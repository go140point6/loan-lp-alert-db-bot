// dev/dropTestOverrides.js
// One-time cleanup: drop legacy test_overrides table if it exists.
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");
const { openDb, dbFile } = require("../db");

const db = openDb({ fileMustExist: true });

try {
  const row = db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name='test_overrides'
      LIMIT 1
    `
    )
    .get();

  if (!row) {
    logger.info("test_overrides table not found; nothing to drop.");
  }

  if (row) {
    db.prepare("DROP TABLE test_overrides").run();
    logger.info("Dropped legacy test_overrides table.");
  }

  // Also remove legacy global_params overrides if they exist.
  const hasGlobalParams = db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name='global_params'
      LIMIT 1
    `
    )
    .get();

  if (hasGlobalParams) {
    const res = db
      .prepare(
        `
        DELETE FROM global_params
        WHERE param_key LIKE 'TEST_OVERRIDE:%'
      `
      )
      .run();
    logger.info(`Removed ${res.changes || 0} legacy TEST_OVERRIDE rows from global_params.`);
  } else {
    logger.info("global_params table not found; no legacy TEST_OVERRIDE keys to remove.");
  }

  // Optional compaction to reclaim space after deletes.
  db.exec("VACUUM");
  logger.info("Vacuumed database to reclaim space.");

  logger.info(`DB: ${dbFile}`);
} catch (err) {
  logger.error("Failed to drop test_overrides table:", err?.message || err);
  process.exit(1);
} finally {
  db.close();
}
