// jobs/firelightJob.js
const cron = require("node-cron");
const { ethers } = require("ethers");

const firelightVaultAbi = require("../abi/firelightVault.json");
const { getProviderForChain } = require("../utils/ethers/providers");
const { getDb } = require("../db");
const logger = require("../utils/logger");
const { firelightText } = require("../config/firelightText");

const CHAINS_CONFIG = {
  FLR: { rpcEnvKey: "FLR_MAINNET" },
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var ${name}`);
  return String(v).trim();
}
function requireNumberEnv(name) {
  const raw = requireEnv(name);
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return v;
}

const FIRELIGHT_CHANNEL_ID = requireEnv("FIRELIGHT_CHANNEL_ID");
const FIRELIGHT_POLL_MIN = requireNumberEnv("FIRELIGHT_POLL_MIN");
const FIRELIGHT_VAULT_ADDRESS = requireEnv("FIRELIGHT_VAULT_ADDRESS");

const STATE_OPEN = "OPEN";
const STATE_CLOSED = "CLOSED";
const STATE_UNKNOWN = "UNKNOWN";

let testOverrideState = null;

function normalizeState(state) {
  const s = (state || "").toString().trim().toUpperCase();
  if (s === STATE_OPEN) return STATE_OPEN;
  if (s === STATE_CLOSED) return STATE_CLOSED;
  if (s === STATE_UNKNOWN) return STATE_UNKNOWN;
  return null;
}

function setFirelightTestState(state) {
  const normalized = normalizeState(state);
  testOverrideState = normalized;
  return testOverrideState;
}

function getFirelightTestState() {
  return testOverrideState;
}

function buildFirelightMessage(state) {
  if (state === STATE_OPEN) return firelightText.open;
  if (state === STATE_CLOSED) return firelightText.closed;
  return firelightText.unknown;
}

async function readFirelightState() {
  if (testOverrideState) {
    logger.debug("[firelight] test override active", { state: testOverrideState });
    return { state: testOverrideState, overridden: true };
  }

  const provider = getProviderForChain("FLR", CHAINS_CONFIG);
  const vault = new ethers.Contract(FIRELIGHT_VAULT_ADDRESS, firelightVaultAbi, provider);

  const [assetsRaw, limitRaw, decimals] = await Promise.all([
    vault.totalAssets(),
    vault.depositLimit(),
    vault.decimals(),
  ]);
  const assets = Number(ethers.formatUnits(assetsRaw, decimals));
  const limit = Number(ethers.formatUnits(limitRaw, decimals));

  const capacityRemaining = limit - assets;
  const isOpen = assets < limit;
  const state = isOpen ? STATE_OPEN : STATE_CLOSED;

  logger.debug("[firelight] vault status", {
    assets,
    limit,
    capacityRemaining,
    state,
  });

  return { state, assets, capacityRemaining, limit };
}

function getConfig(db) {
  return db
    .prepare(
      `
      SELECT channel_id, message_id, last_state
      FROM firelight_config
      WHERE id = 1
      LIMIT 1
    `
    )
    .get();
}

function setConfig(db, { channelId, messageId }) {
  db.prepare(
    `
      INSERT INTO firelight_config (id, channel_id, message_id)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        updated_at = datetime('now')
    `
  ).run(channelId, messageId);
}

function setLastState(db, { state, assets }) {
  db.prepare(
    `
      UPDATE firelight_config
      SET last_state = ?, last_assets = ?, last_checked_at = datetime('now'), updated_at = datetime('now')
      WHERE id = 1
    `
  ).run(state, assets == null ? null : String(assets));
}

async function updateFirelightMessage(client, db, { state }) {
  const cfg = getConfig(db);
  if (!cfg?.message_id || !cfg?.channel_id) {
    logger.warn("[firelight] Missing firelight_config row; run !!postfirelight");
    return { updated: false, previousState: cfg?.last_state || null };
  }

  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    logger.error(`[firelight] Channel not found or not text-based: ${cfg.channel_id}`);
    return { updated: false, previousState: cfg?.last_state || null };
  }

  const message = await channel.messages.fetch(cfg.message_id).catch(() => null);
  if (!message) {
    logger.error(`[firelight] Message not found: ${cfg.message_id}`);
    return { updated: false, previousState: cfg?.last_state || null };
  }

  const content = buildFirelightMessage(state);
  const previousState = cfg.last_state || null;
  if (previousState !== state) {
    await message.edit(content);
  }

  setLastState(db, { state });
  return { updated: previousState !== state, previousState };
}

async function notifySubscribersOnChange(client, db, { prevState, nextState }) {
  if (![STATE_OPEN, STATE_CLOSED].includes(prevState)) return;
  if (![STATE_OPEN, STATE_CLOSED].includes(nextState)) return;
  if (prevState === nextState) return;

  const rows = db
    .prepare(
      `
      SELECT u.id AS user_id, u.discord_id AS discord_id, u.accepts_dm AS accepts_dm
      FROM firelight_subscriptions fs
      JOIN users u ON u.id = fs.user_id
      ORDER BY fs.created_at
    `
    )
    .all();

  const content = buildFirelightMessage(nextState);
  const setUserDmStmt = db.prepare(
    `UPDATE users SET accepts_dm = ?, updated_at = datetime('now') WHERE id = ?`
  );

  for (const row of rows) {
    const user = await client.users.fetch(row.discord_id).catch(() => null);
    if (!user) continue;
    try {
      await user.send(content);
      setUserDmStmt.run(1, row.user_id);
    } catch (err) {
      setUserDmStmt.run(0, row.user_id);
      logger.warn("[firelight] DM failed", {
        userId: row.user_id,
        discordId: row.discord_id,
        error: err?.message || String(err),
      });
    }
  }
}

async function runOnce(client) {
  const db = getDb();
  let state = STATE_UNKNOWN;

  try {
    const res = await readFirelightState();
    state = res.state;
    const { previousState } = await updateFirelightMessage(client, db, { state });
    await notifySubscribersOnChange(client, db, {
      prevState: previousState || null,
      nextState: state,
    });
  } catch (err) {
    logger.error("[firelight] Failed to read vault state:", err?.message || err);
    await updateFirelightMessage(client, db, { state: STATE_UNKNOWN });
  }
}

function startFirelightJob(client) {
  const minutes = Math.max(1, Math.floor(FIRELIGHT_POLL_MIN));
  const sched = `*/${minutes} * * * *`;

  if (!cron.validate(sched)) {
    logger.error(`[firelight] Invalid schedule: "${sched}"`);
    process.exit(1);
  }

  logger.startup(`[firelight] Using schedule: ${sched}`);

  let isRunning = false;

  async function wrappedRun() {
    if (isRunning) {
      logger.warn("[firelight] Previous run still running — skipping.");
      return;
    }
    isRunning = true;
    try {
      await runOnce(client);
    } finally {
      isRunning = false;
    }
  }

  void wrappedRun();
  cron.schedule(sched, wrappedRun);

  return { setConfig, buildFirelightMessage, readFirelightState };
}

module.exports = {
  startFirelightJob,
  buildFirelightMessage,
  readFirelightState,
  setConfig,
  getConfig,
  updateFirelightMessage,
  setFirelightTestState,
  getFirelightTestState,
  STATE_OPEN,
  STATE_CLOSED,
  STATE_UNKNOWN,
};
