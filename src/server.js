import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config/env.js";
import projectsRouter from "./routes/projects.js";
import systemRouter from "./routes/system.js";
import { ensureStorage, syncProjectSettingsFromDiscord } from "./services/projectManager.js";
import { startResourceMonitor } from "./services/resourceMonitor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const { port } = config;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "hosting-panel" });
});

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

await ensureStorage();
await syncProjectSettingsFromDiscord();
startResourceMonitor();

app.listen(port, () => {
  console.log(`Hosting panel running on port ${port}`);
});
