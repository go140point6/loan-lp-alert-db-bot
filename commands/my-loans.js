// commands/my-loans.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const { getDb, getOrCreateUserId } = require("../db");
const { prepareQueries } = require("../db/queries");
const { ensureDmOnboarding } = require("../utils/discord/dm");
const { ephemeralFlags } = require("../utils/discord/ephemerals");
const { createDecimalFormatter } = require("../utils/intlNumberFormats");
const { formatLoanTroveLink, formatAddressLink } = require("../utils/links");
const logger = require("../utils/logger");
const { getTestOffsets, getDebtAheadOffsetPpForProtocol } = require("../monitoring/testOffsets");
const { shortenAddress } = require("../utils/ethers/shortenAddress");

function requireNumberEnv(name) {
  const raw = process.env[name];
  if (!raw || String(raw).trim() === "") {
    throw new Error(`Missing env var ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be numeric (got "${raw}")`);
  return n;
}

const SNAPSHOT_STALE_WARN_MIN = requireNumberEnv("SNAPSHOT_STALE_WARN_MIN");
const SNAPSHOT_STALE_WARN_MS = Math.max(0, Math.floor(SNAPSHOT_STALE_WARN_MIN * 60 * 1000));

const REDEMP_DEBT_AHEAD_LOW_PCT = Number(process.env.REDEMP_DEBT_AHEAD_LOW_PCT);
const REDEMP_DEBT_AHEAD_MED_PCT = Number(process.env.REDEMP_DEBT_AHEAD_MED_PCT);
const REDEMP_DEBT_AHEAD_HIGH_PCT = Number(process.env.REDEMP_DEBT_AHEAD_HIGH_PCT);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fmt2 = createDecimalFormatter(0, 2);
const fmt4 = createDecimalFormatter(0, 4);
const fmt5 = createDecimalFormatter(0, 5);

function fmtNum(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt4.format(n);
}

function fmtNum2(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt2.format(n);
}

function fmtNum5(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return fmt5.format(n);
}

function shortId(id, head = 4, tail = 4) {
  if (id == null) return "?";
  const s = String(id);
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function classifyDebtAheadTier(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v)) return "UNKNOWN";
  if (!Number.isFinite(REDEMP_DEBT_AHEAD_LOW_PCT)) return "UNKNOWN";
  if (v >= REDEMP_DEBT_AHEAD_LOW_PCT) return "LOW";
  if (!Number.isFinite(REDEMP_DEBT_AHEAD_MED_PCT)) return "UNKNOWN";
  if (v >= REDEMP_DEBT_AHEAD_MED_PCT) return "MEDIUM";
  if (!Number.isFinite(REDEMP_DEBT_AHEAD_HIGH_PCT)) return "UNKNOWN";
  if (v >= REDEMP_DEBT_AHEAD_HIGH_PCT) return "HIGH";
  return "CRITICAL";
}

function clamp01(n) {
  if (!Number.isFinite(n)) return n;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function renderPositionBar(pct) {
  if (pct == null || !Number.isFinite(pct)) return "0% |---------------------| 100%";
  const barLen = 21;
  const idx = Math.max(0, Math.min(barLen, Math.round(pct * barLen)));
  const left = "-".repeat(idx);
  const right = "-".repeat(barLen - idx);
  return `0% |${left}o${right}| 100%`;
}

function redemptionMeaning(tier, aheadPctText) {
  const t = (tier || "UNKNOWN").toString().toUpperCase();
  const suffix = aheadPctText ? ` with ${aheadPctText} of total loan debt in front of it.` : ".";
  if (t === "LOW") return `Your loan is comfortably safe from redemption${suffix}`;
  if (t === "MEDIUM") return `Your loan is safe, but at slight risk of redemption${suffix}`;
  if (t === "HIGH") return `Your loan is at elevated risk of redemption${suffix}`;
  if (t === "CRITICAL") return `Your loan is at severe risk of redemption${suffix}`;
  return "Redemption risk is unknown.";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("my-loans")
    .setDescription("Show current monitored loan positions."),

  async execute(interaction) {
    // Decide ephemeral/public ONCE at the start (locked on first response)
    const ephFlags = ephemeralFlags();

    try {
      // Ephemeral in prod, public in testing when EPHEMERALS_OFF=1
      await interaction.deferReply({ flags: ephFlags });

      const db = getDb();
      const q = prepareQueries(db);

      const discordId = interaction.user.id;
      const discordName = interaction.user.globalName || interaction.user.username || null;

      // Ensure user exists + keep name updated
      const userId = getOrCreateUserId(db, { discordId, discordName });

      // DM onboarding check (keyed by users.id)
      const userRow = q.selUser.get(userId);
      const acceptsDm = userRow?.accepts_dm ?? 0;

      await ensureDmOnboarding({
        interaction,
        userId,
        discordId, // logging only
        acceptsDm,
        setUserDmStmt: q.setUserDm, // UPDATE users SET accepts_dm=? WHERE id=?
      });

      // Recommended approach: use summaries (no alert side-effects)
      const { getLoanSummaries, getCdpPrice, classifyCdpRedemptionState } = require("../monitoring/loanMonitor");

      const summaries = await getLoanSummaries(userId);

      if (!summaries.length) {
        await interaction.editReply("No loan positions are currently being monitored for you.");
        return;
      }

      // Sort by LTV descending (most risky first)
      summaries.sort((a, b) => {
        const av = typeof a.ltvPct === "number" ? a.ltvPct : -1;
        const bv = typeof b.ltvPct === "number" ? b.ltvPct : -1;
        return bv - av;
      });

      // CDP context (loanMonitor now supports getCdpPrice() with no args)
      let cdpPrice = null;
      let cdpState = { state: "UNKNOWN", trigger: null, diff: null, label: "no CDP price available" };

      try {
        cdpPrice = await getCdpPrice();
        cdpState = classifyCdpRedemptionState(cdpPrice);
      } catch (e) {
        logger.warn("[my-loans] CDP price/state unavailable:", e?.message || e);
      }
      const { irOffsetPp } = getTestOffsets();
      if (irOffsetPp !== 0 && cdpState) {
        cdpState = {
          ...cdpState,
          state: "ACTIVE",
          label: `${cdpState.label} (test IR override)`,
        };
      }

      const descLines = ["Current status of your monitored loan positions."];

      if (cdpPrice == null) {
        descLines.push("CDP price: *(unknown; CDP price source unavailable)*");
      } else {
        const trigger = Number(cdpState.trigger);
        const diff = typeof cdpState.diff === "number" && Number.isFinite(cdpState.diff)
          ? cdpState.diff
          : null;
        const aboveBelow = diff == null ? "unknown" : diff >= 0 ? "above" : "below";
        const diffText =
          diff == null ? "n/a" : `${Math.abs(diff).toFixed(4)}`;
        const attractText =
          diff == null
            ? "redemption attractiveness unknown"
            : diff < 0
            ? "redemption is economically attractive"
            : "redemption is less attractive";
        descLines.push(
          `CDP: **${fmtNum(cdpPrice)} USD** — ${attractText} (trigger **${fmtNum(trigger)}**, ` +
            `**${diff < 0 ? "-" : "+"}${diffText}** ${aboveBelow})`
        );
      }

      const snapshotTimes = summaries
        .map((s) => (s.snapshotAt ? String(s.snapshotAt) : null))
        .filter(Boolean)
        .map((raw) => {
          const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
          const ts = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
          return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
        })
        .filter((v) => v != null);
      if (snapshotTimes.length) {
        const latest = Math.max(...snapshotTimes);
        const ageMs = Date.now() - latest * 1000;
        const stale = ageMs > SNAPSHOT_STALE_WARN_MS;
        const warn = stale ? " ⚠️ Data may be stale." : "";
        descLines.push("");
        descLines.push(`Data captured: <t:${latest}:f>${warn}`);
      }

      const fields = summaries.map((s) => {
        const rawId = s.troveId ?? s.tokenId ?? s.positionId ?? "?";
        const idLabel = shortId(rawId);
        const idLink = formatLoanTroveLink(s.protocol, rawId, idLabel);
        const header = `${s.protocol || "UNKNOWN_PROTOCOL"} (${s.chainId || "?"})`;

        const valueLines = [];
        valueLines.push(`Trove: ${idLink}`);
        if (s.owner) {
          const walletText = formatAddressLink(s.chainId, s.owner) || `**${shortenAddress(s.owner)}**`;
          valueLines.push(`Wallet: ${walletText}`);
        }

        valueLines.push(`Status: **${s.status || "UNKNOWN"}**`);

        if (s.hasPrice && typeof s.price === "number" && typeof s.liquidationPrice === "number") {
          const ltvText = typeof s.ltvPct === "number" ? `${s.ltvPct.toFixed(2)}%` : "n/a";
          const liqBufferText =
            typeof s.liquidationBufferFrac === "number"
              ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
              : "n/a";

          valueLines.push(`LTV: **${ltvText}**`);
          valueLines.push(`Price / Liq: **${fmtNum5(s.price)} / ${fmtNum5(s.liquidationPrice)}**`);
          valueLines.push(`Liq buffer: **${liqBufferText}** (tier **${s.liquidationTier || "UNKNOWN"}**)`);
        } else {
          valueLines.push("Price / liquidation: *(unavailable; cannot compute LTV / buffer)*");
        }

        if (typeof s.collAmount === "number") {
          valueLines.push(`Collateral: **${fmtNum(s.collAmount)} ${s.collSymbol || ""}**`.trim());
        }
        if (typeof s.debtAmount === "number") {
          valueLines.push(`Debt: **${fmtNum(s.debtAmount)}**`);
        }

        if (typeof s.interestPct === "number") {
          let irLine = `IR: **${s.interestPct.toFixed(2)}% p.a.**`;
          if (typeof s.globalIrPct === "number") {
            irLine += ` vs global **${s.globalIrPct.toFixed(2)}%**`;
          }
          valueLines.push(irLine);

        if (s.redemptionTier) {
          let pctVal =
            typeof s.redemptionDebtAheadPct === "number" && Number.isFinite(s.redemptionDebtAheadPct)
              ? s.redemptionDebtAheadPct
              : null;
          let tierVal = s.redemptionTier;
          const offsetPp = getDebtAheadOffsetPpForProtocol(s.protocol);
          if (pctVal != null && Number.isFinite(offsetPp) && offsetPp !== 0) {
            const adjustedPct = clamp01(pctVal + offsetPp / 100);
            pctVal = adjustedPct;
            tierVal = classifyDebtAheadTier(adjustedPct);
          }
          const pct =
            typeof pctVal === "number" && Number.isFinite(pctVal)
              ? ` (${(pctVal * 100).toFixed(2)}% ahead)`
              : "";
          const aheadPctText =
            typeof pctVal === "number" && Number.isFinite(pctVal)
              ? `${(pctVal * 100).toFixed(2)}%`
              : null;
          const totalDebtVal =
            typeof s.redemptionTotalDebt === "number" && Number.isFinite(s.redemptionTotalDebt)
              ? s.redemptionTotalDebt
              : null;
          const debtAheadVal =
            pctVal != null && totalDebtVal != null
              ? pctVal * totalDebtVal
              : typeof s.redemptionDebtAhead === "number" && Number.isFinite(s.redemptionDebtAhead)
                ? s.redemptionDebtAhead
                : null;
          valueLines.push(
            `Redemption debt: **${fmtNum2(debtAheadVal)}** vs total **${fmtNum2(totalDebtVal)}**`
          );
          valueLines.push(`Redemption tier: **${tierVal}**${pct} - Higher % = safer`);
          valueLines.push(`Redemption position: ${renderPositionBar(pctVal)}`);
          valueLines.push(`Meaning: ${redemptionMeaning(tierVal, aheadPctText)}`);
        }

        }

        let value = valueLines.join("\n");
        if (value.length > 1024) value = value.slice(0, 1020) + "…";

        return { name: header, value };
      });

      const fieldChunks = chunk(fields, 25).slice(0, 10);

      const embeds = fieldChunks.map((fc, idx) => {
        const e = new EmbedBuilder()
          .setColor("DarkBlue")
          .setTitle(idx === 0 ? "My Loan Positions" : "My Loan Positions (cont.)")
          .setTimestamp();

        if (idx === 0) {
          e.setDescription(descLines.join("\n"));
          if (interaction.client?.user) e.setThumbnail(interaction.client.user.displayAvatarURL());
        }

        e.addFields(fc);
        return e;
      });

      await interaction.editReply({ embeds });
    } catch (error) {
      logger.error("Error in /my-loans:", error?.stack || error?.message || error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("An error occurred while processing `/my-loans`.");
        } else {
          await interaction.reply({
            content: "An error occurred while processing `/my-loans`.",
            flags: ephFlags,
          });
        }
      } catch (_) {}
    }
  },
};
