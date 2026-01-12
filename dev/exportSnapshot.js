// dev/exportSnapshot.js
// Run anytime before you nuke schema:
//      node dev/exportSnapshot.js
//
// Outputs a compressed snapshot: data/snapshots/snapshot_<timestamp>.json.gz
//
// Optional env toggles (set in .env if you want):
//   SNAPSHOT_INCLUDE_TRANSFERS=1   (can be huge)
//   SNAPSHOT_INCLUDE_ALERT_LOG=1   (can grow large)

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Database = require("better-sqlite3");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");

// Strict: require MONITOR_DB_PATH (env only)
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    logger.error(`[exportSnapshot] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const SRC_DB = requireEnv("MONITOR_DB_PATH");
const OUT_DIR = path.join(__dirname, "..", "data", "snapshots");

const INCLUDE_TRANSFERS = process.env.SNAPSHOT_INCLUDE_TRANSFERS === "1";
const INCLUDE_ALERT_LOG = process.env.SNAPSHOT_INCLUDE_ALERT_LOG === "1";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return !!row;
}

function exportTable(db, name) {
  if (!tableExists(db, name)) {
    return { exists: false, row_count: 0, rows: [] };
  }
  const rows = db.prepare(`SELECT * FROM ${name}`).all();
  return { exists: true, row_count: rows.length, rows };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const db = new Database(SRC_DB, { fileMustExist: true });
  try {
    // Best-effort checkpoint so reads are consistent (WAL)
    try {
      db.pragma("wal_checkpoint(FULL)");
    } catch (_) {}

    // Core tables (small / important)
    const coreTables = [
      "chains",
      "contracts",
      "contract_scan_cursors",

      "nft_tokens",
      "lp_token_meta",
      "loan_token_meta",
      "global_params",

      "users",
      "user_wallets",
      "position_ignores",
      "alert_state",
    ];

    // Optional big tables
    const optionalTables = [];
    if (INCLUDE_TRANSFERS) optionalTables.push("nft_transfers");
    if (INCLUDE_ALERT_LOG) optionalTables.push("alert_log");

    const allTables = [...coreTables, ...optionalTables];

    const snapshot = {
      schema: "greenfield_nft_ownership_index",
      version: 3, // compressed snapshot format (json.gz)
      created_at: new Date().toISOString(),
      include: {
        nft_transfers: INCLUDE_TRANSFERS,
        alert_log: INCLUDE_ALERT_LOG,
      },
      tables: {},
    };

    for (const t of allTables) {
      const data = exportTable(db, t);
      snapshot.tables[t] = data;
      logger.info(
        `[exportSnapshot] ${t}: ${data.exists ? "OK" : "MISSING"} rows=${data.row_count}`
      );
    }

    const json = JSON.stringify(snapshot, null, 2);
    const gz = zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 });

    const outPath = path.join(OUT_DIR, `snapshot_${nowStamp()}.json.gz`);
    fs.writeFileSync(outPath, gz);
    logger.info(
      `[exportSnapshot] wrote ${outPath} (${gz.length} bytes gzipped)`
    );
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    logger.error("[exportSnapshot] ERROR:", err.message);
    process.exit(1);
  }
}
