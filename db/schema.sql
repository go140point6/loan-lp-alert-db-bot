PRAGMA foreign_keys = ON;

-- =========================================================
-- DROP (dependency order)
-- =========================================================
DROP TABLE IF EXISTS alert_log;
DROP TABLE IF EXISTS alert_state;
DROP TABLE IF EXISTS position_ignores;
DROP TABLE IF EXISTS firelight_subscriptions;
DROP TABLE IF EXISTS firelight_config;

DROP TABLE IF EXISTS global_params;
DROP TABLE IF EXISTS loan_token_meta;
DROP TABLE IF EXISTS lp_token_meta;

DROP TABLE IF EXISTS nft_tokens;
DROP TABLE IF EXISTS nft_transfers;
DROP TABLE IF EXISTS contract_scan_cursors;

DROP TABLE IF EXISTS user_wallets;
DROP TABLE IF EXISTS users;

DROP TABLE IF EXISTS contracts;
DROP TABLE IF EXISTS chains;

-- =========================================================
-- CHAINS
-- =========================================================
CREATE TABLE chains (
  id    TEXT PRIMARY KEY,         -- 'FLR', 'XDC'
  name  TEXT NOT NULL
);

INSERT INTO chains (id, name) VALUES
  ('FLR', 'Flare'),
  ('XDC', 'XDC Network');

-- =========================================================
-- CONTRACTS
-- One row per NFT contract you scan (LP_NFT or LOAN_NFT)
-- =========================================================
CREATE TABLE contracts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  chain_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('LP_NFT', 'LOAN_NFT')),

  contract_key    TEXT NOT NULL UNIQUE,   -- stable key for code: 'enosys_lp', etc.
  protocol        TEXT NOT NULL,          -- display label: 'ENOSYS', etc.

  address_lower   TEXT NOT NULL,
  address_eip55   TEXT NOT NULL,

  default_start_block INTEGER NOT NULL DEFAULT 0 CHECK (default_start_block >= 0),

  is_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE RESTRICT,

  CHECK (address_lower = lower(address_lower)),
  CHECK (length(address_lower) = 42 AND substr(address_lower, 1, 2) = '0x'),
  CHECK (length(address_eip55) = 42 AND substr(address_eip55, 1, 2) = '0x'),

  UNIQUE (chain_id, address_lower)
);

CREATE INDEX idx_contracts_chain_kind ON contracts(chain_id, kind);
CREATE INDEX idx_contracts_protocol   ON contracts(protocol);

-- =========================================================
-- CONTRACT SCAN CURSORS (per contract)
-- =========================================================
CREATE TABLE contract_scan_cursors (
  contract_id            INTEGER PRIMARY KEY,

  start_block            INTEGER NOT NULL DEFAULT 0 CHECK (start_block >= 0),
  last_scanned_block     INTEGER NOT NULL DEFAULT 0 CHECK (last_scanned_block >= 0),
  last_scanned_log_index INTEGER,

  last_scanned_at        TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
);

CREATE INDEX idx_contract_scan_last_block ON contract_scan_cursors(last_scanned_block);

-- =========================================================
-- NFT TRANSFERS (append-only)
-- =========================================================
CREATE TABLE nft_transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  contract_id     INTEGER NOT NULL,

  block_number    INTEGER NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,

  from_lower      TEXT NOT NULL,
  from_eip55      TEXT NOT NULL,
  to_lower        TEXT NOT NULL,
  to_eip55        TEXT NOT NULL,

  token_id        TEXT NOT NULL, -- bigint as string

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,

  CHECK (length(from_lower) = 42 AND substr(from_lower, 1, 2) = '0x'),
  CHECK (length(to_lower)   = 42 AND substr(to_lower,   1, 2) = '0x'),

  UNIQUE (contract_id, tx_hash, log_index)
);

CREATE INDEX idx_nft_transfers_contract_block ON nft_transfers(contract_id, block_number);
CREATE INDEX idx_nft_transfers_to            ON nft_transfers(contract_id, to_lower);
CREATE INDEX idx_nft_transfers_from          ON nft_transfers(contract_id, from_lower);
CREATE INDEX idx_nft_transfers_token         ON nft_transfers(contract_id, token_id);

-- =========================================================
-- NFT TOKENS (canonical current owner index)
-- =========================================================
CREATE TABLE nft_tokens (
  contract_id       INTEGER NOT NULL,
  token_id          TEXT NOT NULL, -- bigint as string

  owner_lower       TEXT NOT NULL,
  owner_eip55       TEXT NOT NULL,

  is_burned         INTEGER NOT NULL DEFAULT 0 CHECK (is_burned IN (0,1)),

  last_block        INTEGER,
  last_tx_hash      TEXT,
  last_log_index    INTEGER,

  first_seen_block  INTEGER,
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (contract_id, token_id),
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,

  CHECK (length(owner_lower) = 42 AND substr(owner_lower, 1, 2) = '0x'),
  CHECK (length(owner_eip55) = 42 AND substr(owner_eip55, 1, 2) = '0x')
);

CREATE INDEX idx_nft_tokens_owner
  ON nft_tokens(owner_lower, is_burned);

CREATE INDEX idx_nft_tokens_contract_owner
  ON nft_tokens(contract_id, owner_lower, is_burned);

CREATE INDEX idx_nft_tokens_contract_burned
  ON nft_tokens(contract_id, is_burned);

-- =========================================================
-- LP TOKEN META (optional cache)
-- =========================================================
CREATE TABLE lp_token_meta (
  contract_id     INTEGER NOT NULL,
  token_id        TEXT NOT NULL,

  pair_label      TEXT,
  token0_lower    TEXT,
  token1_lower    TEXT,
  fee             INTEGER,
  tick_lower      INTEGER,
  tick_upper      INTEGER,

  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (contract_id, token_id),

  FOREIGN KEY (contract_id, token_id)
    REFERENCES nft_tokens(contract_id, token_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_lp_token_meta_pair ON lp_token_meta(pair_label);

-- =========================================================
-- LOAN TOKEN META (optional cache)
-- =========================================================
CREATE TABLE loan_token_meta (
  contract_id     INTEGER NOT NULL,
  token_id        TEXT NOT NULL,

  status          TEXT,
  collateral_sym  TEXT,
  debt_sym        TEXT,

  collateral_amt  TEXT,
  debt_amt        TEXT,
  icr             TEXT,
  liquidation_px  TEXT,

  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (contract_id, token_id),

  FOREIGN KEY (contract_id, token_id)
    REFERENCES nft_tokens(contract_id, token_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_loan_token_meta_status
  ON loan_token_meta(status);

-- =========================================================
-- GLOBAL PARAMS (optional cache)
-- =========================================================
CREATE TABLE global_params (
  chain_id        TEXT NOT NULL,
  param_key       TEXT NOT NULL,
  value_text      TEXT NOT NULL,
  source          TEXT,
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (chain_id, param_key),
  FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE CASCADE
);

-- =========================================================
-- USERS
-- =========================================================
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id    TEXT NOT NULL UNIQUE,
  discord_name  TEXT,
  accepts_dm    INTEGER NOT NULL DEFAULT 0 CHECK (accepts_dm IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_discord_id ON users(discord_id);
CREATE INDEX idx_users_accepts_dm ON users(accepts_dm);

-- =========================================================
-- FIRELIGHT CONFIG / SUBSCRIPTIONS
-- =========================================================
CREATE TABLE firelight_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  channel_id     TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  last_state     TEXT,
  last_assets    TEXT,
  last_checked_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE firelight_subscriptions (
  user_id     INTEGER PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =========================================================
-- USER WALLETS
-- =========================================================
CREATE TABLE user_wallets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  chain_id        TEXT NOT NULL,

  address_lower   TEXT NOT NULL,
  address_eip55   TEXT NOT NULL,

  label           TEXT,
  lp_alerts_status_only INTEGER NOT NULL DEFAULT 0 CHECK (lp_alerts_status_only IN (0,1)),
  is_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE RESTRICT,

  CHECK (address_lower = lower(address_lower)),
  CHECK (length(address_lower) = 42 AND substr(address_lower, 1, 2) = '0x'),
  CHECK (length(address_eip55) = 42 AND substr(address_eip55, 1, 2) = '0x'),

  UNIQUE (user_id, chain_id, address_lower)
);

CREATE INDEX idx_wallets_user       ON user_wallets(user_id);
CREATE INDEX idx_wallets_chain_addr ON user_wallets(chain_id, address_lower);

-- =========================================================
-- POSITION IGNORES
-- IMPORTANT: UNIQUE matches queries.js ON CONFLICT target
-- UNIQUE (user_id, position_kind, wallet_id, contract_id, token_id)
-- =========================================================
CREATE TABLE position_ignores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  user_id       INTEGER NOT NULL,
  position_kind TEXT NOT NULL CHECK (position_kind IN ('LP','LOAN')),

  wallet_id     INTEGER NOT NULL,
  contract_id   INTEGER NOT NULL,
  token_id      TEXT,          -- nullable means "ignore ALL tokens for that wallet+contract+kind"

  reason        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id)     REFERENCES users(id)        ON DELETE CASCADE,
  FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id) ON DELETE CASCADE,
  FOREIGN KEY (contract_id) REFERENCES contracts(id)    ON DELETE CASCADE,

  UNIQUE (user_id, position_kind, wallet_id, contract_id, token_id)
);

CREATE INDEX idx_position_ignores_user
  ON position_ignores(user_id, position_kind);

CREATE INDEX idx_position_ignores_wallet
  ON position_ignores(wallet_id, position_kind);

CREATE INDEX idx_position_ignores_contract
  ON position_ignores(contract_id, position_kind);

-- =========================================================
-- ALERT STATE
-- =========================================================
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

CREATE INDEX idx_alert_state_user_active
  ON alert_state(user_id, is_active);

CREATE INDEX idx_alert_state_position
  ON alert_state(wallet_id, contract_id, token_id, alert_type);

-- =========================================================
-- ALERT LOG
-- =========================================================
CREATE TABLE alert_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  user_id       INTEGER NOT NULL,
  wallet_id     INTEGER NOT NULL,

  contract_id   INTEGER NOT NULL,
  token_id      TEXT NOT NULL,

  alert_type    TEXT NOT NULL,
  phase         TEXT NOT NULL,
  message       TEXT NOT NULL,
  meta_json     TEXT,
  signature     TEXT,

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id)     REFERENCES users(id)        ON DELETE CASCADE,
  FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id) ON DELETE CASCADE,
  FOREIGN KEY (contract_id) REFERENCES contracts(id)    ON DELETE CASCADE
);

CREATE INDEX idx_alert_log_user_created
  ON alert_log(user_id, created_at);

CREATE INDEX idx_alert_log_position
  ON alert_log(wallet_id, contract_id, token_id);

-- =========================================================
-- POSITION SNAPSHOTS (COMMAND CACHE)
-- =========================================================
CREATE TABLE loan_position_snapshots (
  user_id         INTEGER NOT NULL,
  wallet_id       INTEGER NOT NULL,
  contract_id     INTEGER NOT NULL,
  token_id        TEXT NOT NULL,
  chain_id        TEXT NOT NULL,
  protocol        TEXT NOT NULL,
  wallet_label    TEXT,
  snapshot_run_id TEXT NOT NULL,
  snapshot_at     TEXT NOT NULL DEFAULT (datetime('now')),
  snapshot_json   TEXT NOT NULL,
  PRIMARY KEY (user_id, wallet_id, contract_id, token_id),
  FOREIGN KEY (user_id)     REFERENCES users(id)        ON DELETE CASCADE,
  FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id) ON DELETE CASCADE,
  FOREIGN KEY (contract_id) REFERENCES contracts(id)    ON DELETE CASCADE
);

CREATE TABLE lp_position_snapshots (
  user_id         INTEGER NOT NULL,
  wallet_id       INTEGER NOT NULL,
  contract_id     INTEGER NOT NULL,
  token_id        TEXT NOT NULL,
  chain_id        TEXT NOT NULL,
  protocol        TEXT NOT NULL,
  wallet_label    TEXT,
  snapshot_run_id TEXT NOT NULL,
  snapshot_at     TEXT NOT NULL DEFAULT (datetime('now')),
  snapshot_json   TEXT NOT NULL,
  PRIMARY KEY (user_id, wallet_id, contract_id, token_id),
  FOREIGN KEY (user_id)     REFERENCES users(id)        ON DELETE CASCADE,
  FOREIGN KEY (wallet_id)   REFERENCES user_wallets(id) ON DELETE CASCADE,
  FOREIGN KEY (contract_id) REFERENCES contracts(id)    ON DELETE CASCADE
);

CREATE INDEX idx_loan_snapshots_user
  ON loan_position_snapshots(user_id);

CREATE INDEX idx_lp_snapshots_user
  ON lp_position_snapshots(user_id);

-- =========================================================
-- UPDATED_AT TRIGGERS
-- =========================================================
CREATE TRIGGER trg_contracts_updated_at
AFTER UPDATE ON contracts
FOR EACH ROW
BEGIN
  UPDATE contracts SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER trg_contract_scan_cursors_updated_at
AFTER UPDATE ON contract_scan_cursors
FOR EACH ROW
BEGIN
  UPDATE contract_scan_cursors
  SET updated_at = datetime('now')
  WHERE contract_id = OLD.contract_id;
END;

CREATE TRIGGER trg_users_updated_at
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER trg_user_wallets_updated_at
AFTER UPDATE ON user_wallets
FOR EACH ROW
BEGIN
  UPDATE user_wallets SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER trg_alert_state_updated_at
AFTER UPDATE ON alert_state
FOR EACH ROW
BEGIN
  UPDATE alert_state SET updated_at = datetime('now') WHERE id = OLD.id;
END;
