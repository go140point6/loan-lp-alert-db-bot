// db/queries.js
//
// Central prepared statements (NEW SCHEMA, trimmed to only what is currently used).
//
// Used by:
// - commands/my-wallets.js
// - handlers/ui/my-wallets-ui.js
// - handlers/ui/ignore-spam-tx-ui.js
//
// Assumptions / NEW SCHEMA:
// - users: (id PK, discord_id, discord_name, accepts_dm, updated_at)
// - user_wallets: (id, user_id, chain_id, address_eip55, address_lower, label, is_enabled, created_at, updated_at)
// - chains: (id, name)
// - contracts: (id, chain_id, kind, contract_key, protocol, address_eip55, is_enabled)
// - position_ignores:
//     (id, user_id, position_kind, wallet_id, contract_id, token_id NULLABLE, reason, created_at)
//   where token_id NULL => ignore ALL tokens for that (user, kind, wallet, contract)
//
// UNIQUE is on: (user_id, position_kind, wallet_id, contract_id, token_id)

function prepareQueries(db) {
  return {
    // =========================
    // CHAINS
    // =========================
    selChains: db.prepare(`
      SELECT id, name
      FROM chains
      ORDER BY id
    `),

    // =========================
    // USERS
    // =========================
    selUser: db.prepare(`
      SELECT id, discord_id, discord_name, accepts_dm
      FROM users
      WHERE id = ?
      LIMIT 1
    `),

    // Used by ensureDmOnboarding (keyed by users.id PK)
    setUserDm: db.prepare(`
      UPDATE users
      SET accepts_dm = ?, updated_at = datetime('now')
      WHERE id = ?
    `),

    // =========================
    // WALLETS
    // =========================
    selUserWallets: db.prepare(`
      SELECT id, chain_id, address_eip55, address_lower, label, lp_alerts_status_only, is_enabled, created_at
      FROM user_wallets
      WHERE user_id = ?
      ORDER BY chain_id, COALESCE(label, ''), address_lower
    `),

    selUserWalletsByChain: db.prepare(`
      SELECT id, chain_id, address_eip55, address_lower, label, lp_alerts_status_only, is_enabled, created_at
      FROM user_wallets
      WHERE user_id = ?
        AND chain_id = ?
        AND is_enabled = 1
      ORDER BY COALESCE(label, ''), address_lower
    `),

    // Security: ensure wallet belongs to user
    selUserWalletByIdForUser: db.prepare(`
      SELECT id, user_id, chain_id, address_eip55, address_lower, label, lp_alerts_status_only, is_enabled
      FROM user_wallets
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `),

    disableWallet: db.prepare(`
      UPDATE user_wallets
      SET is_enabled = 0, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `),

    setWalletLpStatusOnly: db.prepare(`
      UPDATE user_wallets
      SET lp_alerts_status_only = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `),

    // =========================
    // CONTRACTS
    // =========================
    selContractsByKind: db.prepare(`
      SELECT id, chain_id, kind, contract_key, protocol, address_eip55, is_enabled
      FROM contracts
      WHERE is_enabled = 1
        AND kind = ?
      ORDER BY chain_id, protocol, contract_key
    `),

    selContractById: db.prepare(`
      SELECT id, chain_id, kind, contract_key, protocol, address_eip55, is_enabled
      FROM contracts
      WHERE id = ?
      LIMIT 1
    `),

    // =========================
    // POSITION IGNORES (NEW SCHEMA)
    // =========================
    upsertPositionIgnore: db.prepare(`
      INSERT INTO position_ignores (
        user_id, position_kind, wallet_id, contract_id, token_id, reason
      )
      VALUES (
        @userId, @positionKind, @walletId, @contractId, @tokenId, @reason
      )
      ON CONFLICT(user_id, position_kind, wallet_id, contract_id, token_id)
      DO UPDATE SET
        reason = excluded.reason
    `),

    selUserIgnores: db.prepare(`
      SELECT
        pi.id                 AS id,
        pi.position_kind      AS position_kind,
        pi.token_id           AS token_id,
        pi.reason             AS reason,
        pi.created_at         AS created_at,

        uw.chain_id           AS chain_id,
        uw.address_eip55      AS wallet_address,
        COALESCE(uw.label,'') AS wallet_label,

        c.kind                AS kind,
        c.protocol            AS protocol,
        c.address_eip55       AS contract_address
      FROM position_ignores pi
      JOIN user_wallets uw
        ON uw.id = pi.wallet_id
      JOIN contracts c
        ON c.id = pi.contract_id
      WHERE pi.user_id = ?
      ORDER BY pi.created_at DESC, c.protocol
    `),

    deleteIgnoreByIdForUser: db.prepare(`
      DELETE FROM position_ignores
      WHERE id = ?
        AND user_id = ?
    `),
  };
}

module.exports = { prepareQueries };
