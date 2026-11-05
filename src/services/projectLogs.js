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

export async function readProjectLogsInRange(projectId, from, to = new Date()) {
  const activeQueue = queues.get(projectId);
  if (activeQueue) await activeQueue.catch(() => {});
  try {
    const contents = await fs.readFile(logPath(projectId), "utf8");
    const start = from ? new Date(from).getTime() : Number.NEGATIVE_INFINITY;
    const end = to ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
    return contents.split(/\r?\n/).filter((line) => {
      const match = /^\[(.*?)\]/.exec(line);
      if (!match) return false;
      const timestamp = new Date(match[1]).getTime();
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
    }).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function readProjectDeploymentHistory(projectId) {
  const contents = await readProjectLogsInRange(projectId, null, new Date());
  const deployments = [];
  let current = null;
  for (const line of contents.split(/\r?\n/).filter(Boolean)) {
    const parsed = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/.exec(line);
    if (!parsed) continue;
    const [, timestamp, level, message] = parsed;
    const started = /^커밋 ([0-9a-f]{7,40}) 배포 시작$/i.exec(message);
    if (started) {
      current = {
        commit: started[1],
        startedAt: timestamp,
        finishedAt: null,
        status: "running",
        logs: [line]
      };
      deployments.push(current);
      continue;
    }
    if (!current) continue;
    current.logs.push(line);
    const completed = /^커밋 ([0-9a-f]{7,40}) 배포 완료$/i.exec(message);
    if (completed) {
      current.finishedAt = timestamp;
      current.status = "success";
    } else if (/^배포 실패:/.test(message)) {
      current.finishedAt = timestamp;
      current.status = "failed";
    }
    if (current.status !== "running") current = null;
  }
  return deployments.reverse();
}

export async function clearProjectLogs(projectId) {
  await serialize(projectId, () => fs.rm(logPath(projectId), { force: true }));
}
