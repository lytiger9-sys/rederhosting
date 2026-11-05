import "dotenv/config";
import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 3000),
  authUsername: process.env.AUTH_USERNAME || "",
  authPassword: process.env.AUTH_PASSWORD || "",
  projectRoot: path.resolve(process.env.PROJECT_ROOT || "./storage/projects"),
  logRoot: path.resolve(process.env.LOG_ROOT || "./storage/logs"),
  discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
  discordChannelId: process.env.DISCORD_CHANNEL_ID || ""
};
