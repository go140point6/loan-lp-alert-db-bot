// utils/ethers/shortenTroveId.js
// Standard trove/position shortening: 4...4.

function shortenTroveId(id, head = 4, tail = 4) {
  if (id == null) return "";
  const s = String(id);
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

module.exports = { shortenTroveId };
