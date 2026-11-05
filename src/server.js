import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config/env.js";
import projectsRouter from "./routes/projects.js";
import systemRouter from "./routes/system.js";
import authenticationRouter from "./routes/authentication.js";
import { ensureStorage, syncProjectSettingsFromDiscord } from "./services/projectManager.js";
import { startResourceMonitor } from "./services/resourceMonitor.js";
import { requireLogin, validateAuthConfiguration } from "./services/authentication.js";
import { proxyProjectRequest, proxyProjectUpgrade } from "./services/projectProxy.js";
import { handleProjectTerminalUpgrade } from "./services/projectTerminal.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
const { port } = config;

app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/api/auth", authenticationRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "hosting-panel" });
});

// Hosted project sites are public; only the panel and its APIs require login.
app.use(proxyProjectRequest);
app.use(requireLogin);
app.use("/vendor/xterm", express.static(path.join(__dirname, "..", "node_modules", "@xterm", "xterm")));
app.use("/vendor/xterm-fit", express.static(path.join(__dirname, "..", "node_modules", "@xterm", "addon-fit")));
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));
app.use("/api/projects", projectsRouter);
app.use("/api/system", systemRouter);

// Express 5 requires named wildcards. The brace form also matches `/`.
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: error.message || "Internal server error." });
});

validateAuthConfiguration();
await ensureStorage();
await syncProjectSettingsFromDiscord();
startResourceMonitor();

const server = app.listen(port, () => {
  console.log(`Hosting panel running on port ${port}`);
});
server.on("upgrade", (request, socket, head) => {
  if (!handleProjectTerminalUpgrade(request, socket, head)) proxyProjectUpgrade(request, socket, head);
});
