# Testing Notes

This document describes the lightweight testing switches and tools used during development.

---

## Environment mode

The bot can gate dev-only commands based on environment:

```
BOT_ENV=development
```

Set `BOT_ENV=production` in prod to prevent dev-only commands (like `/test-alerts`) from being registered.

---

## `/test-alerts` (dev-only)

The `/test-alerts` command modifies **in-memory** offsets to simulate:

- Global IR up/down (percentage points)
- Loan price up/down (percent)
- LP tick shift up/down (percent of position width)

Offsets are not persisted and reset on bot restart.

Subcommands:

- `ir` (increase/decrease global IR)
- `liq` (increase/decrease loan price)
- `lp` (shift LP tick within/outside range)
- `status` (show current offsets)
- `reset` (clear all offsets)

---

## Debounce + cooldown testing

To speed up testing alerts, you can temporarily adjust these values in `.env`:

```
LP_OOR_DEBOUNCE_SEC=...
LP_IN_DEBOUNCE_SEC=...
LP_ALERT_COOLDOWN_SEC=...

LOAN_LIQ_DEBOUNCE_SEC=...
LOAN_LIQ_RESOLVE_DEBOUNCE_SEC=...
LOAN_LIQ_ALERT_COOLDOWN_SEC=...

LOAN_REDEMP_DEBOUNCE_SEC=...
LOAN_REDEMP_RESOLVE_DEBOUNCE_SEC=...
LOAN_REDEMP_ALERT_COOLDOWN_SEC=...
```

These are used by the alert engine to prevent ping-pong alerts in normal operation.

