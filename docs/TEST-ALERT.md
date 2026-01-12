# TEST-ALERT.md — `/test-alert` command guide

This command is meant for **admin/testing only**. It writes **temporary overrides** into the DB (`global_params`) so your monitors + alert engine behave as if a position’s status/tier changed.

> Overrides are keyed by `kind + contract_id + token_id` and **auto-expire** after `duration` seconds.
> The alert engine deletes expired overrides on next read (best-effort).

---

## Command: `/test-alert`

### Subcommands
- `/test-alert set` — create/update a temporary override
- `/test-alert clear` — remove an override immediately
- `/test-alert list` — show all active overrides currently stored

All responses are **ephemeral** (only you can see them).

---

## `/test-alert set`

Creates or updates an override record for a specific position.

### Options (all)
| Option | Type | Required | Applies to | Notes |
|---|---:|:---:|---|---|
| `kind` | string | ✅ | LP, LIQ, REDEMP | Must be one of: `LP`, `LIQ`, `REDEMP` |
| `contract_id` | integer | ✅ | all | Must be the DB `contracts.id` |
| `token_id` | string | ✅ | all | For LP: NFT `tokenId`. For loans: `troveId` |
| `status` | string | ❌ | **LP only** | `IN_RANGE`, `OUT_OF_RANGE`, `INACTIVE` (or `UNKNOWN`) |
| `tier` | string | ❌ | all | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`, `UNKNOWN` |
| `duration` | integer | ✅ | all | Seconds until override expires (must be positive integer) |

### What gets written
A row in `global_params`:

- `chain_id = '*'`
- `param_key = 'TEST_OVERRIDE:<KIND>:<contract_id>:<token_id>'`
- `value_text = JSON.stringify(payload)`

Payload shape:
```json
{
  "untilMs": 1730000000000,
  "active": true,
  "status": "OUT_OF_RANGE",
  "tier": "HIGH"
}
```

> Only fields you supply are set (except `active` — see below).

### Important: `active` behavior depends on your command version

#### A) If your `commands/test-alert.js` is the original version you pasted
Your code always sets:
```js
payload = { untilMs, active: true };
```
So **every override is forced ON**, regardless of `status`/`tier`.

Practical effect:
- `LP` overrides will act as **active** even if you set `status=IN_RANGE`, unless your alert engine infers and overwrites it (some versions do, some don’t).
- `LIQ` and `REDEMP` overrides are **always active**, so you can reliably test NEW/UPDATED behavior, but it’s harder to test RESOLVED without `clear`.

#### B) If you implemented an `active` option (recommended)
If you added a boolean option like `active:true|false`, then:
- You can explicitly force ON/OFF regardless of observed chain conditions.
- If `active` is omitted:
  - For LP, you typically infer from `status` (`OUT_OF_RANGE` => active)
  - For LIQ/REDEMP, you typically default to active (since you’re setting an override to test alerts)

If you’re not sure which version you’re running, use `/test-alert list` and inspect the JSON (see below).

---

## `/test-alert clear`

Deletes an override record immediately.

### Options
| Option | Type | Required | Notes |
|---|---:|:---:|---|
| `kind` | string | ✅ | `LP`, `LIQ`, `REDEMP` |
| `contract_id` | integer | ✅ | DB `contracts.id` |
| `token_id` | string | ✅ | tokenId (LP) or troveId (loan) |

Result:
- Removes `global_params` row with key: `TEST_OVERRIDE:<KIND>:<contract_id>:<token_id>`

---

## `/test-alert list`

Lists all overrides currently stored (whether expired or not).

### Output format
Each line shows:
- `param_key`
- raw `value_text` JSON

Example:
```
• TEST_OVERRIDE:LP:12:345 → {"untilMs":1730000000000,"active":true,"status":"OUT_OF_RANGE","tier":"HIGH"}
```

> Expired overrides may still appear until the alert engine attempts to read them (at which point it may delete them).

---

## Practical recipes / examples

### 1) Force an LP to be OUT_OF_RANGE for 90 seconds
```
/test-alert set kind:LP contract_id:12 token_id:345 status:OUT_OF_RANGE tier:HIGH duration:90
```

### 2) Force an LP to be IN_RANGE (test “back in range” path)
```
/test-alert set kind:LP contract_id:12 token_id:345 status:IN_RANGE tier:LOW duration:120
```

> If your command version forces `active:true`, you may also need `active:false` support to fully test the RESOLVED path without clearing.

### 3) Force LIQ risk ON for a trove (60 seconds)
```
/test-alert set kind:LIQ contract_id:7 token_id:1024 tier:MEDIUM duration:60
```

### 4) Force REDEMP risk ON for a trove (60 seconds)
```
/test-alert set kind:REDEMP contract_id:7 token_id:1024 tier:HIGH duration:60
```

### 5) Clear a specific override immediately
```
/test-alert clear kind:LP contract_id:12 token_id:345
```

### 6) View what is active right now
```
/test-alert list
```

---

## Troubleshooting

### “I set an override but nothing happens”
Most common causes:
1. **Key mismatch**: `contract_id` must be the DB `contracts.id` and `token_id` must match the position id the monitor uses.
2. **Override expired**: duration elapsed; list to confirm.
3. **Monitor interval vs debounce**: even with an override, your alert handler may still debounce based on your env timers.

### Confirm the override exists in SQLite
Run:
```sql
SELECT param_key, value_text
FROM global_params
WHERE chain_id='*'
  AND param_key LIKE 'TEST_OVERRIDE:%';
```

---

## Suggested .env testing values (optional)
To make testing fast, temporarily reduce debounce/cooldowns (then restore):

**LP**
- `LP_OOR_DEBOUNCE_SEC=1`
- `LP_IN_DEBOUNCE_SEC=1`
- `LP_ALERT_COOLDOWN_SEC=5`

**Loans**
- `LOAN_LIQ_DEBOUNCE_SEC=1`
- `LOAN_LIQ_RESOLVE_DEBOUNCE_SEC=1`
- `LOAN_LIQ_ALERT_COOLDOWN_SEC=5`
- `LOAN_REDEMP_DEBOUNCE_SEC=1`
- `LOAN_REDEMP_RESOLVE_DEBOUNCE_SEC=1`
- `LOAN_REDEMP_ALERT_COOLDOWN_SEC=5`

---

## Notes on safety
- Keep this command restricted to trusted users/admins.
- Overrides alter alert behavior and can generate lots of DMs if cooldowns are low.
