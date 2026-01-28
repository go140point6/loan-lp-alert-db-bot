// commands/redemption-rate.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getDb, getOrCreateUserId } = require("../db");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { shortenTroveId } = require("../utils/ethers/shortenTroveId");
const { shortenAddress } = require("../utils/ethers/shortenAddress");
const { formatAddressLink, formatLoanTroveLink } = require("../utils/links");
const logger = require("../utils/logger");
const { getDebtAheadOffsetPpForProtocol, classifyDebtAheadTier } = require("../monitoring/testOffsets");
const SNAPSHOT_STALE_WARN_MIN = (() => {
  const raw = process.env.SNAPSHOT_STALE_WARN_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Missing or invalid SNAPSHOT_STALE_WARN_MIN (got "${raw}")`);
  }
  return n;
})();

function fmtPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v.toFixed(digits)}%`;
}

function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

function formatSnapshotLine(snapshotAt) {
  if (!snapshotAt) return null;
  const raw = String(snapshotAt);
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const tsMs = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (!Number.isFinite(tsMs)) return null;
  const ts = Math.floor(tsMs / 1000);
  const ageMin = (Date.now() - tsMs) / 60000;
  const warn =
    Number.isFinite(ageMin) && ageMin >= SNAPSHOT_STALE_WARN_MIN
      ? " ⚠️ Data may be stale."
      : "";
  return `<t:${ts}:f>${warn}`;
}

function fmtShortTime(tsSec) {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return "n/a";
  return `<t:${Math.floor(tsSec)}:F>`;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return n;
  return Math.max(0, Math.min(1, n));
}

function tierEmoji(tier) {
  return (
    {
      LOW: "🟩",
      MEDIUM: "🟨",
      HIGH: "🟧",
      CRITICAL: "🟥",
    }[String(tier || "").toUpperCase()] || "⬜"
  );
}

function redemptionMeaning(tier, aheadPctText) {
  const t = String(tier || "").toUpperCase();
  const aheadSuffix = aheadPctText ? ` with ${aheadPctText} of total loan debt in front of it.` : ".";
  if (t === "LOW") return `Your loan is comfortably safe from redemption${aheadSuffix}`;
  if (t === "MEDIUM") return `Your loan is safe, but at slight risk of redemption${aheadSuffix}`;
  if (t === "HIGH") return `Your loan is at elevated risk of redemption${aheadSuffix}`;
  if (t === "CRITICAL") return `Your loan is at severe risk of redemption${aheadSuffix}`;
  return "Redemption risk is unknown.";
}

function normalizeIrPct(v) {
  if (!Number.isFinite(v)) return null;
  if (v > 1e6) return v / 1e18;
  return v;
}

function loadLoanContracts() {
  try {
    const db = getDb();
    return db
      .prepare(
        `
        SELECT id, chain_id, protocol, address_eip55
        FROM contracts
        WHERE kind = 'LOAN_NFT' AND is_enabled = 1
        ORDER BY protocol
      `
      )
      .all();
  } catch (err) {
    logger.warn(`[redemption-rate] Failed to load contracts: ${err?.message || err}`);
    return [];
  }
}

const loanContractChoices = loadLoanContracts()
  .map((r) => ({ name: r.protocol, value: r.protocol }))
  .slice(0, 25);

function computeFeeFromSnapshot({ debtAmount, interestPct, lastInterestRateAdjTime }) {
  const debt = Number(debtAmount);
  const rate = Number(interestPct);
  const lastAdj = Number(lastInterestRateAdjTime);
  if (!Number.isFinite(debt) || !Number.isFinite(rate) || !Number.isFinite(lastAdj) || lastAdj <= 0) {
    return { feeApplies: false, fee: 0, nextFree: null };
  }
  const now = Math.floor(Date.now() / 1000);
  const nextFree = lastAdj + 7 * 24 * 60 * 60;
  const feeApplies = now < nextFree;
  const fee = feeApplies ? debt * (rate / 100) * (7 / 365) : 0;
  return { feeApplies, fee, nextFree };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("redemption-rate")
    .setDescription("Target IR to stay within redemption tiers (debt-ahead model).")
    .addStringOption((o) =>
      o
        .setName("contract")
        .setDescription("Loan contract / protocol")
        .setRequired(true)
        .addChoices(...loanContractChoices)
    )
    .addStringOption((o) =>
      o
        .setName("loan")
        .setDescription("Existing loan (or NEW)")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "loan") return;

    const protocol = interaction.options.getString("contract");
    if (!protocol) {
      await interaction.respond([{ name: "NEW", value: "NEW" }]);
      return;
    }

    const db = getDb();
    const discordId = interaction.user.id;
    const discordName = interaction.user.globalName || interaction.user.username || null;
    const userId = getOrCreateUserId(db, { discordId, discordName });

    const rows = db
      .prepare(
        `
        SELECT snapshot_json
        FROM loan_position_snapshots
        WHERE user_id = ? AND protocol = ?
      `
      )
      .all(userId, protocol);

    const options = [{ name: "NEW", value: "NEW" }];
    for (const row of rows) {
      try {
        const snap = JSON.parse(row.snapshot_json);
        const troveId = snap?.troveId;
        if (!troveId) continue;
        const label = snap?.walletLabel ? ` (${snap.walletLabel})` : "";
        options.push({
          name: `${shortenTroveId(troveId)}${label}`,
          value: String(troveId),
        });
      } catch (_) {}
      if (options.length >= 25) break;
    }

    const query = (focused.value || "").toLowerCase();
    const filtered = options.filter((opt) =>
      opt.name.toLowerCase().includes(query) || opt.value.toLowerCase().includes(query)
    );

    await interaction.respond(filtered.slice(0, 25));
  },

  async execute(interaction) {
    const ephFlags = ephemeralFlags();
    await interaction.deferReply({ flags: ephFlags });

    const protocol = interaction.options.getString("contract");
    const loanChoice = interaction.options.getString("loan") || "NEW";
    const isNew = loanChoice === "NEW";

    const db = getDb();
    const discordId = interaction.user.id;
    const discordName = interaction.user.globalName || interaction.user.username || null;
    const userId = getOrCreateUserId(db, { discordId, discordName });

    let matchedSnapshot = null;
    if (!isNew) {
      const rows = db
        .prepare(
          `
          SELECT snapshot_json
          FROM loan_position_snapshots
          WHERE user_id = ? AND protocol = ?
        `
        )
        .all(userId, protocol);
      for (const r of rows) {
        try {
          const snap = JSON.parse(r.snapshot_json);
          if (String(snap?.troveId) === String(loanChoice)) {
            matchedSnapshot = snap;
            break;
          }
        } catch (_) {}
      }
      if (!matchedSnapshot) {
        await interaction.editReply("Selected loan not found for your wallet.");
        return;
      }
    }

    const contractRow = db
      .prepare(
        `
        SELECT id, chain_id, protocol, address_eip55
        FROM contracts
        WHERE kind = 'LOAN_NFT' AND protocol = ? AND is_enabled = 1
        LIMIT 1
      `
      )
      .get(protocol);

    if (!contractRow) {
      await interaction.editReply(`Unknown contract: ${protocol}`);
      return;
    }

    const chainId = String(contractRow.chain_id).toUpperCase();
    const rateRow = db
      .prepare(
        `
        SELECT snapshot_json, snapshot_at
        FROM redemption_rate_snapshots
        WHERE contract_id = ?
        LIMIT 1
      `
      )
      .get(contractRow.id);

    if (!rateRow?.snapshot_json) {
      await interaction.editReply("No redemption-rate snapshot available yet. Run the scan job first.");
      return;
    }

    let rateSnap;
    try {
      rateSnap = JSON.parse(rateRow.snapshot_json);
    } catch (_) {
      await interaction.editReply("Redemption-rate snapshot is invalid.");
      return;
    }

    const totalDebt = Number(rateSnap.totalDebt);
    const globalIrPct = normalizeIrPct(Number(rateSnap.globalIrPct));
    const targets = rateSnap.targets || {};
    const aheadAt = rateSnap.aheadAt || {};
    const irRange = rateSnap.irRange || {};
    const buckets = Array.isArray(rateSnap.buckets) ? rateSnap.buckets : [];

    const embed = new EmbedBuilder()
      .setTitle(`Redemption Target IR - ${protocol}`)
      .setDescription("Higher IR = more debt ahead (safer).")
      .setColor(0x2b2d31)
      .setTimestamp(new Date());
    if (interaction.client?.user) {
      embed.setThumbnail(interaction.client.user.displayAvatarURL());
    }

    if (isNew) {
      embed.addFields({
        name: "Global IR",
        value: fmtPct(globalIrPct),
        inline: true,
      });
    }

    if (!isNew) {
      const loanInfo = matchedSnapshot || {};
      let walletAddress = null;
      let walletLabel = null;
      if (matchedSnapshot) {
        walletAddress = matchedSnapshot.walletAddress || matchedSnapshot.owner || null;
        walletLabel = matchedSnapshot.walletLabel || null;
      }

      const troveLink =
        formatLoanTroveLink(protocol, loanChoice, shortenTroveId(loanChoice)) ||
        shortenTroveId(loanChoice);
      embed.addFields({ name: "Trove", value: troveLink, inline: true });

      const walletLink = walletAddress
        ? formatAddressLink(chainId, walletAddress) || shortenAddress(walletAddress)
        : "n/a";
      embed.addFields({ name: "Wallet", value: walletLink, inline: true });

      embed.addFields({ name: "Label", value: walletLabel || "n/a", inline: true });

      const loanIrPct = normalizeIrPct(Number(loanInfo.interestPct));
      embed.addFields({
        name: "Loan IR",
        value: fmtPct(loanIrPct, 2),
        inline: true,
      });
      const deltaIr =
        Number.isFinite(loanIrPct) && Number.isFinite(globalIrPct)
          ? loanIrPct - globalIrPct
          : null;
      embed.addFields({ name: "Global IR", value: fmtPct(globalIrPct, 2), inline: true });
      embed.addFields({
        name: "Delta IR",
        value: deltaIr == null ? "n/a" : `Δ ${deltaIr >= 0 ? "+" : ""}${deltaIr.toFixed(2)} pp`,
        inline: true,
      });

      embed.addFields({
        name: "Debt (your loan)",
        value: `${fmtNum(loanInfo.debtAmount, 2)} CDP`,
        inline: true,
      });
      embed.addFields({
        name: "Total debt (of contract)",
        value: `${fmtNum(totalDebt, 2)} CDP`,
        inline: true,
      });

      if (totalDebt > 0) {
        const tierVal = loanInfo?.redemptionTier || "UNKNOWN";
        const aheadPctText =
          typeof loanInfo?.redemptionDebtAheadPct === "number"
            ? `${(loanInfo.redemptionDebtAheadPct * 100).toFixed(2)}%`
            : "n/a";
      const offsetPp = getDebtAheadOffsetPpForProtocol(protocol);
      let pctAdj = loanInfo?.redemptionDebtAheadPct;
      let tierAdj = tierVal;
      if (pctAdj != null && Number.isFinite(offsetPp) && offsetPp !== 0) {
        pctAdj = clamp01(pctAdj + offsetPp / 100);
        tierAdj = classifyDebtAheadTier(pctAdj);
      }
      const aheadPctAdjText =
        typeof pctAdj === "number" && Number.isFinite(pctAdj)
          ? `${(pctAdj * 100).toFixed(2)}%`
          : aheadPctText;

      embed.addFields({
        name: "Current loan tier",
        value: `${tierEmoji(tierAdj)} ${tierAdj}: ${redemptionMeaning(tierAdj, aheadPctAdjText)}`,
        inline: false,
      });
      }

      const feeMeta = computeFeeFromSnapshot({
        debtAmount: loanInfo.debtAmount,
        interestPct: loanIrPct,
        lastInterestRateAdjTime: loanInfo.lastInterestRateAdjTime,
      });

      embed.addFields({
        name: "Maximum Change fee (if updated now)",
        value: feeMeta.feeApplies ? `${fmtNum(feeMeta.fee, 2)} CDP (estimated)` : "NONE",
        inline: false,
      });

      embed.addFields({
        name: "IR change lock",
        value:
          feeMeta.nextFree && feeMeta.feeApplies
            ? `Next free change: \`${new Date(feeMeta.nextFree * 1000).toLocaleString("en-US", {
                dateStyle: "long",
                timeStyle: "short",
              })}\``
            : "No lock active",
        inline: false,
      });
    } else {
      embed.addFields({
        name: "Loan",
        value: "NEW (no existing position selected)",
        inline: false,
      });
    }

    if (targets) {
      const fmtAhead = (amt) =>
        amt != null && Number.isFinite(amt)
          ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
              Math.floor(amt)
            )} ahead`
          : "n/a";
      const tierLines = [
        `🟩 LOW - target IR = ${
          targets.LOW != null ? fmtPct(targets.LOW, 1) : "n/a"
        } (${fmtAhead(aheadAt.LOW)})`,
        `🟨 MEDIUM - target IR = ${
          targets.MEDIUM != null ? fmtPct(targets.MEDIUM, 1) : "n/a"
        } (${fmtAhead(aheadAt.MEDIUM)})`,
        `🟧 HIGH - target IR = ${
          targets.HIGH != null ? fmtPct(targets.HIGH, 1) : "n/a"
        } (${fmtAhead(aheadAt.HIGH)})`,
        "🟥 CRITICAL",
      ];
      embed.addFields({
        name: "Tier",
        value: tierLines.join("\n"),
        inline: false,
      });

      if (irRange && Number.isFinite(irRange.min) && Number.isFinite(irRange.max)) {
        embed.addFields({
          name: "IR range (min / median / max)",
          value: `${fmtPct(irRange.min, 2)} / ${fmtPct(irRange.median, 2)} / ${fmtPct(
            irRange.max,
            2
          )}`,
          inline: false,
        });
      }

      if (Array.isArray(buckets) && buckets.length) {
        const bucketLines = buckets.map((b) => {
          const pct = Number.isFinite(b.pct) ? b.pct : 0;
          return `${Number(b.min).toFixed(2)}–${Number(b.max).toFixed(2)}%: ${pct.toFixed(1)}%`;
        });
        const left = bucketLines.slice(0, 5).join("\n");
        const right = bucketLines.slice(5).join("\n");
        embed.addFields(
          { name: "IR buckets (debt-weighted)", value: left || "n/a", inline: true },
          { name: "\u200b", value: right || "n/a", inline: true }
        );
      }

    }

    const snapshotLine = formatSnapshotLine(rateRow.snapshot_at);
    if (snapshotLine) {
      embed.addFields({ name: "Data captured", value: snapshotLine, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
