import path from "node:path";
import { createProjectNpmShim } from "./projectNpmShim.js";

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
    const npmShimDirectory = createProjectNpmShim(projectDirectory);
    if (npmShimDirectory) {
      const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") || "PATH";
      environment[pathKey] = [npmShimDirectory, environment[pathKey]].filter(Boolean).join(path.delimiter);
    }
  }
  return environment;
}
