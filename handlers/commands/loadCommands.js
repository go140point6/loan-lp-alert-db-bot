// handlers/commands/loadCommands.js
const fs = require("node:fs");
const path = require("node:path");

const logger = require("../../utils/logger");

/**
 * Loads command modules from /commands and:
 * - stores them in client.commands
 * - returns array of command JSON for REST deployment
 */
async function loadCommands(client) {
  const commands = [];
  const botEnv = (process.env.BOT_ENV || "development").toLowerCase();
  const isProd = botEnv === "production";

  const commandsPath = path.join(__dirname, "..", "..", "commands");
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);

    if (isProd && command.devOnly) {
      logger.info(`[loadCommands] Skipping dev-only command in production: ${command.data?.name || file}`);
      continue;
    }

    if ("data" in command && "execute" in command) {
      client.commands.set(command.data.name, command);
      commands.push(command.data.toJSON());
    } else {
      logger.warn(
        `[loadCommands] The command at ${filePath} is missing a required "data" or "execute" property.`
      );
    }
  }

  return commands;
}

module.exports = { loadCommands };
