// utils/discord/ephemerals.js
const { MessageFlags } = require("discord-api-types/v10");

const EPHEMERAL_FLAG = MessageFlags.Ephemeral;

/**
 * Global toggle:
 *  - EPHEMERALS_OFF=1  => returns 0 (public)
 *  - otherwise         => returns Ephemeral flag
 */
function ephemeralFlags() {
  return process.env.EPHEMERALS_OFF === "1" ? 0 : EPHEMERAL_FLAG;
}

/**
 * Optional: for cases where you truly want public even in prod,
 * but still keep the global "off" override.
 */
function ephemeralFlagsDefaultPublic() {
  return 0; // stays public always
}

module.exports = { ephemeralFlags, ephemeralFlagsDefaultPublic, EPHEMERAL_FLAG };
