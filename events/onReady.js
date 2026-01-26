// events/onReady.js
const { Collection } = require("discord.js");

const logger = require("../utils/logger");

const { loadCommands } = require("../handlers/commands/loadCommands");
const { deployGuildCommands } = require("../handlers/commands/deployGuildCommands");
const { startMonitoringJob } = require("../jobs/monitoringJob");
const { startHeartbeatJob } = require("../jobs/heartbeatJob");
const { startFirelightJob } = require("../jobs/firelightJob");
const { setAlertEngineClient } = require("../monitoring/alertEngine");

async function onReady(client) {
  logger.startup(`Ready! Logged in as ${client.user.tag}`);
  const ephOff = process.env.EPHEMERALS_OFF === "1";
  logger.startup(`Ephemeral replies: ${ephOff ? "DISABLED (testing)" : "ENABLED (production)"}`);
  setAlertEngineClient(client);

  // Commands collection (used by onInteraction)
  client.commands = new Collection();

  // Load + deploy slash commands
  const commandsJson = await loadCommands(client);
  await deployGuildCommands(commandsJson);

  // Start background jobs
  startMonitoringJob();
  startHeartbeatJob(client);
  startFirelightJob(client);
}

module.exports = { onReady };
