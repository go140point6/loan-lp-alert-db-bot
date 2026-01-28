# Liquidity Sentinel

Liquidity Sentinel is a Discord bot that tracks DeFi positions (loans/troves and Uniswap v3 LPs), evaluates risk, and delivers actionable alerts and daily summaries.

Key focus:
- fast, readable position snapshots
- risk-tiered alerts that stay out of your way
- daily summaries to keep you oriented

<img src="img/liquidity-sentinel.png" alt="liquidity sentinel bot" width="600">

---

## Features at a glance

### /my-loans
Loan/trove health, liquidation buffers, and redemption risk across supported chains with clear tiered status.

<img src="img/my-loans.png" alt="/my-loans screenshot" width="720">

### /my-lp
Uniswap v3 LP positions with range status, estimated amounts from liquidity, and fee/position context.

<img src="img/my-lp.png" alt="/my-lp screenshot" width="720">

### /my-wallets
Tracked wallets and linked positions, built for a quick coverage check. Includes an LP alert flag to suppress tier-only updates so you only get in-range/out-of-range changes when preferred.

<img src="img/my-wallets.png" alt="/my-wallets screenshot" width="720">

### /redemption-rate
Target interest rates for redemption risk tiers with live guidance on where your loan would land.

<img src="img/redemption-rate" alt="/redemption-rate screenshot" width="720">

### /ignore-spam-tx
Ignore noisy or irrelevant on-chain transactions to keep alerts focused on what matters.

<img src="img/ignore-spam-tx.png" alt="/ignore-spam-tx screenshot" width="720">

---

## Monitoring & alerts

### Alert engine
Stateful alerting for liquidation/redemption thresholds and position risk changes with deduped notifications and tiered severity.

<img src="img/alert-improving.png" alt="Alert improving example" width="49%">
<img src="img/alert-worsening.png" alt="Alert worsening example" width="49%">

### Daily heartbeat DM
A daily summary DM with tracked positions, current status, and key liquidity/health signals.

<img src="img/daily-heartbeat.png" alt="Daily heartbeat screenshot" width="720">

---

## Other highlights

- Scheduled scanning so positions stay fresh in near-realtime.
- Multi-chain RPC support with strict environment validation.
- Lightweight custom logger for consistent, controllable output.

---

## License

MIT
