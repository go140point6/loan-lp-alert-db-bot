// ./config/firelightText.js
const firelightText = {
  open: [
    "Firelight signal:",
    "Capacity state: OPEN.",
    "Condition is transient.",
  ].join("\n"),
  closed: [
    "Firelight signal:",
    "Capacity state: CLOSED.",
    "Additional deposits are blocked.",
  ].join("\n"),
  unknown: [
    "Firelight signal:",
    "Capacity state cannot be confirmed.",
    "Data source is degraded.",
  ].join("\n"),
};

module.exports = { firelightText };
