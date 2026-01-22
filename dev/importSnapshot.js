// dev/importSnapshot.js
// Import snapshot produced by the NEW dev/exportSnapshot.js (version=2)
//
// Recommended restore flow:
//   rm -f data/liquidity-sentinel.sqlite data/liquidity-sentinel.sqlite-wal data/liquidity-sentinel.sqlite-shm
//   node dev/importSnapshot.js --file=data/snapshots/snapshot_XXXX.json --wipe=1
//
// IMPORTANT:
// - This preserves integer IDs (contracts.id/users.id/user_wallets.id). That’s required
//   because nft_tokens/nft_transfers/contract_scan_cursors reference contract_id.
// - If you run seedContracts before importing, it’s fine ONLY IF you use --wipe=1 (this deletes it).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { openDb, initSchema } = require("../db");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    logger.error(`[importSnapshot] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const DEST_DB = requireEnv("DB_PATH");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    out[k] = v;
  }
  return out;
}

function usage() {
  logger.error(`
Usage:
  node dev/importSnapshot.js --file=data/snapshots/snapshot_XXXX.json [--wipe=1]

Notes:
  Snapshot must be version=2 produced by NEW dev/exportSnapshot.js.
  Use --wipe=1 for correct ID preservation.
`);
  process.exit(1);
}

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function colsForTable(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}

function buildInsertSQL(table, columns) {
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  return `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
}

function pickRowColumns(row, colSet) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (colSet.has(k)) out[k] = v;
  }
  return out;
}

function deleteAll(db, table) {
  db.exec(`DELETE FROM ${table};`);
}

function main() {
  const args = parseArgs();
  const file = args.file;
  const wipe = String(args.wipe || "0") === "1";
  if (!file) usage();

  const filePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(filePath)) throw new Error(`Missing snapshot file: ${filePath}`);

  let snapRaw;

  if (filePath.endsWith(".gz")) {
    const gzBuf = fs.readFileSync(filePath);
    snapRaw = zlib.gunzipSync(gzBuf).toString("utf8");
  } else {
    snapRaw = fs.readFileSync(filePath, "utf8");
  }

  const snap = JSON.parse(snapRaw);

  if (!snap || !snap.tables || typeof snap.tables !== "object") {
    throw new Error("Snapshot missing 'tables'. Export it using the NEW dev/exportSnapshot.js.");
  }

  const db = openDb({ fileMustExist: true });
  initSchema(db);

  try {
    // Import order must respect FKs:
    // chains -> contracts -> cursors -> tokens -> meta -> users -> wallets -> ignores/state -> logs/transfers
    const importOrder = [
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

      // optional large tables
      "nft_transfers",
      "alert_log",
    ];

    // Which tables are present in the snapshot AND exist in the DB?
    const tablesToImport = [];
    for (const t of importOrder) {
      const entry = snap.tables[t];
      if (!entry || !Array.isArray(entry.rows)) continue;
      if (!tableExists(db, t)) continue;
      tablesToImport.push(t);
    }

    if (!tablesToImport.length) {
      throw new Error("No importable tables found (snapshot missing tables or DB schema mismatch).");
    }

    const tx = db.transaction(() => {
      if (wipe) {
        // delete children first (reverse import order)
        for (const t of [...tablesToImport].reverse()) {
          deleteAll(db, t);
          logger.info(`[importSnapshot] wiped ${t}`);
        }
      } else {
        // Without wipe, you can get PK conflicts for tables like chains/contracts/users.
        // That’s expected; we’ll skip duplicates during insert.
        logger.info(
          "[importSnapshot] wipe=0: duplicates may be skipped due to PK/UNIQUE constraints"
        );
      }

      for (const table of tablesToImport) {
        const rows = snap.tables[table].rows || [];
        if (!rows.length) {
          logger.info(`[importSnapshot] ${table}: 0 rows (skip)`);
          continue;
        }

        const colSet = colsForTable(db, table);

        // Choose column set from first row intersection.
        // IMPORTANT: This will include 'id' / 'contract_id' etc when present,
        // preserving IDs exactly (required).
        const firstPicked = pickRowColumns(rows[0], colSet);
        const columns = Object.keys(firstPicked);
        if (!columns.length) {
          logger.info(`[importSnapshot] ${table}: no matching columns (skip)`);
          continue;
        }

        const stmt = db.prepare(buildInsertSQL(table, columns));

        let inserted = 0;
        let skipped = 0;

        for (const r of rows) {
          const picked = pickRowColumns(r, colSet);
          const values = columns.map((c) => (picked[c] === undefined ? null : picked[c]));
          try {
            stmt.run(values);
            inserted++;
          } catch (err) {
            skipped++;
            // Keep output useful but not insane
            if (skipped <= 10) {
              logger.warn(`[importSnapshot] ${table} SKIP: ${err.message}`);
            }
          }
        }

        if (skipped > 10) {
          logger.warn(
            `[importSnapshot] ${table}: skipped ${skipped} rows (only first 10 shown)`
          );
        }
        logger.info(
          `[importSnapshot] ${table}: inserted=${inserted} skipped=${skipped} total=${rows.length}`
        );
      }
    });

    tx();

    logger.info(`[importSnapshot] imported snapshot OK from ${filePath}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    logger.error("[importSnapshot] ERROR:", err.message);
    process.exit(1);
  }
}
