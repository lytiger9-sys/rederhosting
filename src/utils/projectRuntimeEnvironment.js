import path from "node:path";

const panelOnlyEnvironmentKeys = [
  "PROJECT_ROOT",
  "LOG_ROOT",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CHANNEL_ID",
  "DISCORD_SYNC_ENCRYPTION_KEY",
  "GITHUB_TOKEN"
];

export function createProjectRuntimeEnvironment(projectEnvironment = {}, projectDirectory) {
  const runtimeEnvironment = { ...process.env };
  for (const key of panelOnlyEnvironmentKeys) {
    delete runtimeEnvironment[key];
  }
  const environment = { ...runtimeEnvironment, ...projectEnvironment };
  if (projectDirectory) {
    // Keep npm from walking up into the hosting panel and selecting its package.json.
    environment.npm_config_prefix = path.resolve(projectDirectory);
  }
  return environment;
}
