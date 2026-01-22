// dev/seedContracts.js
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");

// Always load .env from project root
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const DB_PATH = requireEnv("DB_PATH");

// Config locations
const LOAN_CONFIG_PATH = path.join(__dirname, "..", "data", "loan_contracts.json");
const LP_CONFIG_PATH = path.join(__dirname, "..", "data", "lp_contracts.json");

function readJson(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function normalizeAddress(addr) {
  if (!addr || typeof addr !== "string" || !addr.startsWith("0x") || !ethers.isAddress(addr)) {
    throw new Error(`Invalid EVM address: ${addr}`);
  }
  const eip55 = ethers.getAddress(addr);
  const lower = eip55.toLowerCase();
  return { address_lower: lower, address_eip55: eip55 };
}

function normalizeStartBlock(v, { fallback = 0, context = "" } = {}) {
  if (v == null || v === "") return fallback;

  // accept number or numeric string
  const n = typeof v === "number" ? v : Number(String(v).trim());

  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid default_start_block=${v} ${context}`.trim());
  }
  return n;
}

function collectContractsFromLoanConfig(loanCfg) {
  const out = [];
  const chains = loanCfg?.chains || {};
  for (const [chainId, chainCfg] of Object.entries(chains)) {
    const contracts = chainCfg?.contracts || [];
    for (const c of contracts) {
      out.push({
        chain_id: chainId,
        kind: "LOAN_NFT",
        contract_key: c.key,
        protocol: c.protocol,
        address: c.address, // loan JSON uses "address"
        default_start_block: c.default_start_block,
      });
    }
  }
  return out;
}

function collectContractsFromLpConfig(lpCfg) {
  const out = [];
  const chains = lpCfg?.chains || {};
  for (const [chainId, chainCfg] of Object.entries(chains)) {
    const contracts = chainCfg?.contracts || [];
    for (const c of contracts) {
      out.push({
        chain_id: chainId,
        kind: "LP_NFT",
        contract_key: c.key,
        protocol: c.protocol,
        address: c.contract, // lp JSON uses "contract"
        default_start_block: c.default_start_block,
      });
    }
  }
  return out;
}

function seed() {
  const db = new Database(DB_PATH);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    const insert = db.prepare(`
      INSERT INTO contracts (
        chain_id, kind, contract_key, protocol,
        address_lower, address_eip55,
        default_start_block,
        is_enabled
      )
      VALUES (
        @chain_id, @kind, @contract_key, @protocol,
        @address_lower, @address_eip55,
        @default_start_block,
        1
      )
    `);

    const loanCfg = readJson(LOAN_CONFIG_PATH);
    const lpCfg = readJson(LP_CONFIG_PATH);

    const rowsRaw = [
      ...collectContractsFromLoanConfig(loanCfg),
      ...collectContractsFromLpConfig(lpCfg),
    ];

    if (rowsRaw.length === 0) {
      console.log("[seedContracts] No contracts found in JSON configs. Nothing to insert.");
      return;
    }

    console.log(`[seedContracts] Found ${rowsRaw.length} contract(s) in configs.`);

    const rows = rowsRaw.map((r) => {
      const { address_lower, address_eip55 } = normalizeAddress(r.address);

      const default_start_block = normalizeStartBlock(r.default_start_block, {
        fallback: 0,
        context: `(contract_key=${r.contract_key} chain=${r.chain_id})`,
      });

      return {
        chain_id: String(r.chain_id).toUpperCase(),
        kind: r.kind,
        contract_key: r.contract_key,
        protocol: r.protocol,
        address_lower,
        address_eip55,
        default_start_block,
      };
    });

    const tx = db.transaction((items) => {
      let inserted = 0;
      let skipped = 0;

      for (const item of items) {
        try {
          insert.run(item);
          inserted++;
          console.log(
            `[seedContracts] INSERT OK: ${item.chain_id} ${item.kind} ${item.contract_key} ${item.address_eip55} start=${item.default_start_block}`
          );
        } catch (err) {
          skipped++;
          console.warn(
            `[seedContracts] INSERT SKIP (${item.chain_id} ${item.kind} ${item.contract_key}): ${err.message}`
          );
        }
      }

      return { inserted, skipped };
    });

    const { inserted, skipped } = tx(rows);

    const count = db.prepare(`SELECT COUNT(*) AS n FROM contracts`).get().n;
    console.log(`[seedContracts] Done. inserted=${inserted} skipped=${skipped} total_in_db=${count}`);

    console.log("\n[seedContracts] Current contracts table:");
    const all = db
      .prepare(
        `SELECT chain_id, kind, contract_key, protocol, address_eip55, default_start_block, is_enabled
         FROM contracts
         ORDER BY chain_id, kind, contract_key`
      )
      .all();

    for (const r of all) {
      console.log(
        `  - ${r.chain_id} ${r.kind} ${r.contract_key} ${r.protocol} ${r.address_eip55} start=${r.default_start_block} enabled=${r.is_enabled}`
      );
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    seed();
  } catch (err) {
    console.error("[seedContracts] Failed:", err);
    process.exit(1);
  }
}

module.exports = { seed };
