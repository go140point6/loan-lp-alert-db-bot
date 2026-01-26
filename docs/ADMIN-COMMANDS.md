# Admin Commands

This document describes Sentinel’s admin‑only chat commands (prefix `!!`).

---

## `!!postfirelight`

Posts the Firelight signal message to the configured channel and adds the 🔥 reaction.
It also stores the message ID so the job can edit it on state changes.

Use when first setting up the Firelight channel.

---

## `!!editfirelight`

Edits the existing Firelight signal message with the latest state.
Use if you need to refresh the message content without waiting for the next poll.

---

## Requirements

- You must have **Manage Server** permission in Discord to run these commands.
- `FIRELIGHT_CHANNEL_ID` must be set in `.env`.
- The bot needs permission to send messages and add reactions in the Firelight channel.
