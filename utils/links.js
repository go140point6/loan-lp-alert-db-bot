// utils/links.js
const { shortenAddress } = require("./ethers/shortenAddress");

function getExplorerAddressUrl(chainId, address) {
  if (!chainId || !address) return null;
  const chain = String(chainId).toUpperCase();
  if (chain === "FLR") {
    return `https://flare-explorer.flare.network/address/${address}`;
  }
  if (chain === "XDC") {
    return `https://xdcscan.io/address/${address}`;
  }
  return null;
}

function formatAddressLink(chainId, address) {
  if (!address) return "n/a";
  const url = getExplorerAddressUrl(chainId, address);
  const label = shortenAddress(address);
  return url ? `[${label}](${url})` : label;
}

function getLpPositionUrl(protocol, tokenId) {
  if (!protocol || tokenId == null) return null;
  const p = String(protocol).toUpperCase();
  if (p.includes("ENOSYS")) {
    const base = String(process.env.ENOSYS_LP_POSITION_URL_BASE || "").trim();
    return base ? `${base}${tokenId}` : null;
  }
  if (p.includes("XSWAP")) {
    const base = String(process.env.XSWAP_LP_POSITION_URL_BASE || "").trim();
    return base ? `${base}${tokenId}` : null;
  }
  if (p.includes("SPARKDEX")) {
    const base = String(process.env.SPARKDEX_LP_POSITION_URL_BASE || "").trim();
    return base || null;
  }
  return null;
}

function formatLpPositionLink(protocol, tokenId, label) {
  if (tokenId == null) return "n/a";
  const url = getLpPositionUrl(protocol, tokenId);
  const text = label || String(tokenId);
  return url ? `[${text}](${url})` : text;
}

function getLoanTroveUrl(protocol) {
  if (!protocol) return null;
  const p = String(protocol).toUpperCase();
  if (p.includes("ENOSYS")) {
    const base = String(process.env.ENOSYS_LOAN_TROVE_URL || "").trim();
    return base || null;
  }
  return null;
}

function formatLoanTroveLink(protocol, troveId, label) {
  if (troveId == null) return "n/a";
  const url = getLoanTroveUrl(protocol);
  const text = label || String(troveId);
  return url ? `[${text}](${url})` : text;
}

module.exports = {
  getExplorerAddressUrl,
  formatAddressLink,
  getLpPositionUrl,
  formatLpPositionLink,
  getLoanTroveUrl,
  formatLoanTroveLink,
};
