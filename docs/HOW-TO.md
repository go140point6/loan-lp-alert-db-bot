# Liquidity Sentinel — Quick Start Guide

This guide walks you through adding a wallet, using the core commands, and understanding the daily heartbeat summary.

---

## 1) Add your wallet

Use the `/my-wallets` command to add a wallet address you want the bot to track.

**What you’ll do:**
- Add a wallet address (optional label for easy recognition).
- Confirm it shows as enabled.

**What you’ll see:**
- The wallet listed with the label you chose.
- Any detected positions tied to that wallet will appear over time.
- Optional flags to control LP alert behavior (status-only vs status + tier).

[Screenshot: /my-wallets add flow]

---

## 2) Check your loans

Use `/my-loans` to see your loan/trove positions and their current risk tiers.

**What you’ll see:**
- Your tracked loan positions.
- Liquidation and redemption risk tiers.
- Current health signals in a compact summary.

[Screenshot: /my-loans results]

---

## 3) Check your LP positions

Use `/my-lp` to see your Uniswap v3 liquidity positions and range status.

**What you’ll see:**
- Each LP position and its in‑range/out‑of‑range state.
- Range tier showing how close you are to the edge.
- Estimated liquidity and fees context.

[Screenshot: /my-lp results]

---

## 4) Ignore noisy transactions (optional)

If you see noisy transactions you don’t want alerts for, use `/ignore-spam-tx`.

**What you’ll see:**
- Confirmation that a noisy transaction (or pattern) is ignored.
- Cleaner alert stream going forward.

[Screenshot: /ignore-spam-tx usage]

---

## 5) Daily heartbeat summary

Once per day, the bot sends a summary DM with the current state of your tracked positions.

**What to expect:**
- A clean overview of loans and LPs.
- Risk tiers and status markers for quick scanning.
- Key signals without needing to run commands.

[Screenshot: Daily heartbeat summary]

---

## Notes on screenshots in Discord

Discord automatically shows image previews at a fixed inline size and lets users click to view full size.  
You can post images directly in the channel; they will appear as uniform previews, and users can click to expand.
