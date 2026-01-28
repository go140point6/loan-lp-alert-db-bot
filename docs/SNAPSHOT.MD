# Database Snapshot Export / Import

This document describes how to export and restore a snapshot of the monitoring database used by the NFT ownership indexer (LP + Loan positions).

The snapshot system is designed for:

- Fast recovery after destructive schema changes
- Preserving expensive historical scans (millions of blocks)
- Restoring the database exactly as-is (including integer IDs)

---

## Overview

Snapshots are:

- Logical exports (JSON)
- Gzip-compressed (`.json.gz`)
- Produced by `dev/exportSnapshot.js`
- Restored by `dev/importSnapshot.js`

Snapshots preserve:

- Contract definitions and IDs
- Scan cursor progress
- Discovered NFT ownership (`nft_tokens`)
- Optional metadata and bot state
- Cached position snapshots used by commands and alerts

Snapshots are **not** incremental backups.  
They are intended for **rebuild & restore** workflows.

---

## Snapshot Contents

### Core tables (always included)

- `chains`
- `contracts`
- `contract_scan_cursors`
- `nft_tokens`
- `lp_token_meta`
- `loan_token_meta`
- `global_params`
- `users`
- `user_wallets`
- `position_ignores`
- `alert_state`
- `loan_position_snapshots`
- `lp_position_snapshots`
- `redemption_rate_snapshots`

### Optional tables (large)

- `nft_transfers` — full ERC-721 transfer history (can be very large)
- `alert_log` — historical alerts (can grow over time)

Optional tables are included only when explicitly enabled.

---

## Environment Requirements

Both export and import scripts require environment variables only  
(no defaults, no fallbacks).

### Required

```
DB_PATH=/absolute/path/to/liquidity-sentinel.sqlite
```

### Optional (export only)

```
SNAPSHOT_INCLUDE_TRANSFERS=1
SNAPSHOT_INCLUDE_ALERT_LOG=1
```

---

## Exporting a Snapshot

### Command

```
node dev/exportSnapshot.js
```

### Output

Snapshots are written to:

```
data/snapshots/snapshot_<timestamp>.json.gz
```

Example:

```
data/snapshots/snapshot_2026-01-09T00-32-10-418Z.json.gz
```

### Notes

- Uses `PRAGMA wal_checkpoint(FULL)` for best-effort consistency
- Output is gzip-compressed using Node’s built-in `zlib`
- Logs row counts per table during export

---

## Restoring a Snapshot (Recommended Flow)

**Important:**  
Snapshots preserve integer primary keys (`contracts.id`, `users.id`, etc.).  
Restoring into a non-empty database can break foreign-key relationships.

### Recommended restore steps

```
rm -f data/liquidity-sentinel.sqlite data/liquidity-sentinel.sqlite-wal data/liquidity-sentinel.sqlite-shm
node dev/importSnapshot.js --file=data/snapshots/snapshot_XXXX.json.gz --wipe=1
```

---

## Why `--wipe=1` Is Required

- Deletes all rows from snapshot tables in foreign-key-safe order
- Allows snapshot rows to be inserted with original IDs
- Prevents `contract_id`, `user_id`, and `wallet_id` mismatches
- Ensures ownership and cursor tables remain consistent

Restoring without `--wipe=1` is **not recommended** except for debugging.

---

## Import Script Behavior

The import process:

- Automatically detects `.json` vs `.json.gz`
- Imports tables in strict foreign-key order
- Inserts rows as-is, preserving IDs
- Skips rows that violate constraints (with warnings)
- Logs per-table insert / skip counts

If `--wipe=0` is used:

- Existing rows are retained
- Duplicate rows may be skipped
- ID mismatches are possible

---

## Snapshot File Format (Version 3)

```
{
  "schema": "greenfield_nft_ownership_index",
  "version": 3,
  "created_at": "2026-01-09T00:32:10.418Z",
  "include": {
    "nft_transfers": false,
    "alert_log": false
  },
  "tables": {
    "contracts": {
      "exists": true,
      "row_count": 5,
      "rows": [ ... ]
    },
    "nft_tokens": {
      "exists": true,
      "row_count": 1234,
      "rows": [ ... ]
    }
  }
}
```

---

## What Snapshots Are Not

- Not a live backup
- Not incremental
- Not safe to merge into an existing populated database
- Not a substitute for filesystem or SQLite `.backup`

For live backups or point-in-time recovery, use:

- SQLite `.backup`
- Filesystem snapshots
- VM or volume-level backups

---

## When to Take a Snapshot

Recommended times:

- After completing a long historical scan
- Before destructive schema changes
- Before experimenting with scan logic
- Before wiping the database

---

## Summary

- Export: `node dev/exportSnapshot.js`
- Restore: `node dev/importSnapshot.js --wipe=1`
- Snapshots preserve scan progress and ownership state
- `.json.gz` keeps large datasets manageable
- Always restore into a clean database
