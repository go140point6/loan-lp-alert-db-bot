#!/usr/bin/env node
/**
 * scripts/findSparkdexScamLpTokens.js
 *
 * Usage examples:
 *   node scripts/findSparkdexScamLpTokens.js --db /path/to/monitor.db --chain FLR --address 0xee5ff5bc5f852764b5584d92a4d592a53dc527da
 *
 * Optional:
 *   --min-count 50     (only consider issuer candidates with >= this many first-transfers)
 *   --top 10           (show top N issuer candidates)
 *   --issuer 0xabc...  (skip auto-detect; directly list tokens whose first-transfer from this address)
 */

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, ".", ".env"),
  quiet: true,
});
const Database = require("better-sqlite3");

// ---- tiny argv parser ----
function getArg(name, def = null) {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) return process.argv[idx + 1];
  return def;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function lower0x(s) {
  if (!s) return s;
  const x = String(s).trim();
  return x.toLowerCase();
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const BURN_SET = new Set([ZERO, DEAD]);

const dbPath = getArg("db", process.env.MONITOR_DB_PATH);
const chainId = (getArg("chain", "FLR") || "").toUpperCase();
const address = lower0x(getArg("address", null));
const topN = Number(getArg("top", "10"));
const minCount = Number(getArg("min-count", "25"));
const forcedIssuer = lower0x(getArg("issuer", "") || "");

if (!dbPath) die("❌ Missing --db <path> (or set MONITOR_DB_PATH).");
if (!address || !address.startsWith("0x") || address.length !== 42) {
  die("❌ Missing/invalid --address 0x... (42 chars).");
}
if (!Number.isFinite(topN) || topN <= 0) die("❌ --top must be a positive integer.");
if (!Number.isFinite(minCount) || minCount < 1) die("❌ --min-count must be >= 1.");

const db = new Database(dbPath, { readonly: true });
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

try {
  // 1) Find contract_id
  const contractRow = db
    .prepare(
      `
      SELECT id, chain_id, kind, protocol, contract_key, address_lower, address_eip55
      FROM contracts
      WHERE chain_id = ?
        AND address_lower = ?
      `
    )
    .get(chainId, address);

  if (!contractRow) {
    die(
      `❌ Contract not found in DB for chain=${chainId} address=${address}\n` +
        `   Check contracts.address_lower + chain_id.\n`
    );
  }

  const contractId = contractRow.id;

  console.log("============================================================");
  console.log("Contract:");
  console.log(`  chain_id:     ${contractRow.chain_id}`);
  console.log(`  kind:         ${contractRow.kind}`);
  console.log(`  protocol:     ${contractRow.protocol}`);
  console.log(`  contract_key: ${contractRow.contract_key}`);
  console.log(`  address:      ${contractRow.address_eip55} (lower=${contractRow.address_lower})`);
  console.log(`  contract_id:  ${contractId}`);
  console.log("============================================================\n");

  // 2) Build a temp table of FIRST transfer per token_id for this contract.
  //    Earliest = min(block_number, log_index). Using a correlated subquery for clarity.
  //    NOTE: if you have many rows, this can take a moment but should be OK for one contract.
  db.exec(`DROP TABLE IF EXISTS _tmp_first_xfer;`);
  db.exec(`
    CREATE TEMP TABLE _tmp_first_xfer AS
    SELECT t.*
    FROM nft_transfers t
    WHERE t.contract_id = ${contractId}
      AND NOT EXISTS (
        SELECT 1
        FROM nft_transfers t2
        WHERE t2.contract_id = t.contract_id
          AND t2.token_id    = t.token_id
          AND (
            t2.block_number < t.block_number
            OR (t2.block_number = t.block_number AND t2.log_index < t.log_index)
          )
      );
  `);

  const totals = db.prepare(`SELECT COUNT(*) AS n FROM _tmp_first_xfer;`).get();
  console.log(`First-transfer rows (unique token_ids) found: ${totals.n}\n`);

  if (!totals.n) {
    console.log("No transfers found for this contract in nft_transfers.");
    process.exit(0);
  }

  // 3) Show top issuer candidates: from_lower that appears most often as FIRST sender (excluding burn).
  const issuerRows = db
    .prepare(
      `
      SELECT
        from_lower,
        COUNT(*) AS cnt,
        COUNT(DISTINCT to_lower) AS distinct_to,
        MIN(block_number) AS first_block,
        MAX(block_number) AS last_block
      FROM _tmp_first_xfer
      WHERE from_lower NOT IN (?, ?)
      GROUP BY from_lower
      HAVING COUNT(*) >= ?
      ORDER BY cnt DESC
      LIMIT ?
      `
    )
    .all(ZERO, DEAD, minCount, topN);

  if (!issuerRows.length && !forcedIssuer) {
    console.log(
      `No issuer candidates met --min-count=${minCount} (excluding burn addresses).\n` +
        `Try lowering --min-count, or pass --issuer 0x... if you already know it.`
    );
    process.exit(0);
  }

  console.log(`Top issuer candidates (based on FIRST transfers, excluding 0x0/0xdead):`);
  for (const r of issuerRows) {
    const ratio = r.cnt ? (r.distinct_to / r.cnt) : 0;
    console.log(
      `  ${r.from_lower}  cnt=${r.cnt}  distinct_to=${r.distinct_to}  ratio=${ratio.toFixed(3)}  blocks=${r.first_block}..${r.last_block}`
    );
  }
  console.log("");

  // 4) Choose issuer: either forced, or best candidate by cnt then distinct_to ratio.
  let issuer = forcedIssuer;
  if (issuer) {
    console.log(`Using forced issuer: ${issuer}\n`);
  } else {
    // heuristic: max cnt, tie-breaker: higher distinct_to ratio, then lower first_block
    issuerRows.sort((a, b) => {
      if (b.cnt !== a.cnt) return b.cnt - a.cnt;
      const ra = a.cnt ? a.distinct_to / a.cnt : 0;
      const rb = b.cnt ? b.distinct_to / b.cnt : 0;
      if (rb !== ra) return rb - ra;
      return a.first_block - b.first_block;
    });
    issuer = issuerRows[0].from_lower;
    console.log(`Auto-selected issuer candidate: ${issuer}\n`);
  }

  // 5) Print every token whose FIRST transfer came from issuer.
  const scamTokens = db
    .prepare(
      `
      SELECT
        token_id,
        block_number,
        tx_hash,
        log_index,
        from_lower,
        to_lower
      FROM _tmp_first_xfer
      WHERE from_lower = ?
      ORDER BY block_number ASC, log_index ASC
      `
    )
    .all(issuer);

  console.log("============================================================");
  console.log(`TOKENS MATCHING ISSUER (first transfer from ${issuer})`);
  console.log(`Count: ${scamTokens.length}`);
  console.log("Format: token_id | block | log | tx | from -> to");
  console.log("============================================================");

  for (const r of scamTokens) {
    console.log(
      `${r.token_id} | ${r.block_number} | ${r.log_index} | ${r.tx_hash} | ${r.from_lower} -> ${r.to_lower}`
    );
  }

  console.log("\nDone.");
} finally {
  try { db.close(); } catch (_) {}
}
