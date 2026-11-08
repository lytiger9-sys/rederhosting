const panelOnlyEnvironmentKeys = [
  "PROJECT_ROOT",
  "LOG_ROOT",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CHANNEL_ID",
  "DISCORD_SYNC_ENCRYPTION_KEY",
  "GITHUB_TOKEN"
];

export function createProjectRuntimeEnvironment(projectEnvironment = {}) {
  const runtimeEnvironment = { ...process.env };
  for (const key of panelOnlyEnvironmentKeys) {
    delete runtimeEnvironment[key];
  }
  return { ...runtimeEnvironment, ...projectEnvironment };
}
