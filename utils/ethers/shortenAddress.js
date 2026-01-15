// utils/ethers/shortenAddress.js
// Standard address shortening: 0x1234...5678 (4...4).

function shortenAddress(addr, head = 4, tail = 4) {
  if (!addr) return "";
  const s = String(addr);
  const lower = s.toLowerCase();
  const prefixLen = lower.startsWith("0x") ? 2 : lower.startsWith("xdc") ? 3 : 0;
  const headLen = prefixLen + head;
  if (s.length <= headLen + tail + 3) return s;
  return `${s.slice(0, headLen)}...${s.slice(-tail)}`;
}

module.exports = { shortenAddress };
