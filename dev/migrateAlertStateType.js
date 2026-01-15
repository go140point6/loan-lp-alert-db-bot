// dev/migrateAlertStateType.js
// Migration: split alert_state by alert_type (LIQUIDATION / REDEMPTION / LP_RANGE).
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const logger = require("../utils/logger");
const { openDb, dbFile } = require("../db");

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function inferAlertType(stateJson) {
  if (!stateJson) return "GENERIC";
  let obj;
  try {
    obj = JSON.parse(stateJson);
  } catch (_) {
    return "GENERIC";
  }

  if (obj?.kind === "LP" || obj?.rangeStatus != null || obj?.tickLower != null) {
    return "LP_RANGE";
  }
  if (obj?.cdpIR != null || obj?.globalIR != null || obj?.isCDPActive != null) {
    return "REDEMPTION";
  }
  if (obj?.liquidationBufferFrac != null || obj?.liquidationPrice != null || obj?.currentPrice != null) {
    return "LIQUIDATION";
  }
  return "GENERIC";
}

const db = openDb({ fileMustExist: true });

try {
  if (!tableExists(db, "alert_state")) {
    logger.info("alert_state table not found; nothing to migrate.");
    process.exit(0);
  }

  if (columnExists(db, "alert_state", "alert_type")) {
    logger.info("alert_state.alert_type already exists; migration not needed.");
    process.exit(0);
  }

  logger.info("Migrating alert_state to include alert_type...");
  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");

  db.exec("DROP TRIGGER IF EXISTS trg_alert_state_updated_at");
  db.exec("DROP INDEX IF EXISTS idx_alert_state_user_active");
  db.exec("DROP INDEX IF EXISTS idx_alert_state_position");
  db.exec("ALTER TABLE alert_state RENAME TO alert_state_old");

  db.exec(`
    CREATE TABLE alert_state (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id       INTEGER NOT NULL,
      wallet_id     INTEGER NOT NULL,

      contract_id   INTEGER NOT NULL,
      token_id      TEXT NOT NULL,
      alert_type    TEXT NOT NULL,

      is_active     INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
      signature     TEXT,
      state_json    TEXT,

      last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (user_id)     REFERENCES users(id)         ON DELETE CASCADE,
      FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id)  ON DELETE CASCADE,
      FOREIGN KEY (contract_id) REFERENCES contracts(id)     ON DELETE CASCADE,

      UNIQUE (user_id, wallet_id, contract_id, token_id, alert_type)
    );
  `);

  db.exec(`
    CREATE INDEX idx_alert_state_user_active
      ON alert_state(user_id, is_active);
    CREATE INDEX idx_alert_state_position
      ON alert_state(wallet_id, contract_id, token_id, alert_type);
  `);

  db.exec(`
    CREATE TRIGGER trg_alert_state_updated_at
    AFTER UPDATE ON alert_state
    FOR EACH ROW
    BEGIN
      UPDATE alert_state SET updated_at = datetime('now') WHERE id = OLD.id;
    END;
  `);

  const rows = db.prepare("SELECT * FROM alert_state_old").all();
  const insert = db.prepare(`
    INSERT INTO alert_state (
      id, user_id, wallet_id, contract_id, token_id, alert_type,
      is_active, signature, state_json, last_seen_at, created_at, updated_at
    ) VALUES (
      @id, @user_id, @wallet_id, @contract_id, @token_id, @alert_type,
      @is_active, @signature, @state_json, @last_seen_at, @created_at, @updated_at
    )
  `);

  let migrated = 0;
  for (const r of rows) {
    const alertType = inferAlertType(r.state_json);
    insert.run({
      id: r.id,
      user_id: r.user_id,
      wallet_id: r.wallet_id,
      contract_id: r.contract_id,
      token_id: r.token_id,
      alert_type: alertType,
      is_active: r.is_active,
      signature: r.signature,
      state_json: r.state_json,
      last_seen_at: r.last_seen_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
    migrated++;
  }

  db.exec("DROP TABLE alert_state_old");
  db.exec("COMMIT");
  db.pragma("foreign_keys = ON");

  logger.info(`Migration complete. Migrated ${migrated} alert_state rows.`);
  logger.info(`DB: ${dbFile}`);
} catch (err) {
  try {
    db.exec("ROLLBACK");
  } catch (_) {}
  logger.error("Migration failed:", err?.message || err);
  process.exit(1);
} finally {
  db.close();
}
