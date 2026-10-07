import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const queues = new Map();

function logPath(projectId) {
  return path.join(config.logRoot, `${projectId}.log`);
}

function serialize(projectId, operation) {
  const previous = queues.get(projectId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(projectId, current);
  return current.finally(() => {
    if (queues.get(projectId) === current) queues.delete(projectId);
  });
}

export function appendProjectLog(projectId, text, level = "INFO") {
  const value = String(text ?? "");
  if (!value) return Promise.resolve();
  return serialize(projectId, async () => {
    await fs.mkdir(config.logRoot, { recursive: true });
    const timestamp = new Date().toISOString();
    const line = value.split(/\r?\n/).filter(Boolean).map((part) => `[${timestamp}] [${level}] ${part}`).join("\n");
    const target = logPath(projectId);
    await fs.appendFile(target, `${line}\n`, "utf8");
    const stats = await fs.stat(target);
    if (stats.size > MAX_LOG_BYTES) {
      const contents = await fs.readFile(target);
      const trimmed = contents.subarray(contents.length - Math.floor(MAX_LOG_BYTES / 2));
      await fs.writeFile(target, trimmed);
    }
  });
}

export async function readProjectLogs(projectId, maxLines = 500) {
  const activeQueue = queues.get(projectId);
  if (activeQueue) await activeQueue.catch(() => {});
  try {
    const contents = await fs.readFile(logPath(projectId), "utf8");
    return contents.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function clearProjectLogs(projectId) {
  await serialize(projectId, () => fs.rm(logPath(projectId), { force: true }));
}
