import os from "node:os";
import { getPublicIp, refreshPublicIp } from "./publicIp.js";

let previousCpu = process.cpuUsage();
let previousSampleTime = process.hrtime.bigint();

function readCpuTotals() {
  return os.cpus().reduce((total, cpu) => ({
    idle: total.idle + cpu.times.idle,
    all: total.all + Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }), { idle: 0, all: 0 });
}

let previousSystemCpu = readCpuTotals();

let latestStats = {
  timestamp: new Date().toISOString(),
  cpu: { usagePercent: 0 },
  process: {
    cpuPercent: 0,
    memoryBytes: process.memoryUsage().rss
  },
  publicIp: "",
  memory: {
    totalBytes: os.totalmem(),
    freeBytes: os.freemem(),
    usedBytes: os.totalmem() - os.freemem(),
    usagePercent: 0
  }
};

function refresh() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const currentSystemCpu = readCpuTotals();
  const elapsed = currentSystemCpu.all - previousSystemCpu.all;
  const idle = currentSystemCpu.idle - previousSystemCpu.idle;
  const systemCpuPercent = elapsed > 0
    ? Number((Math.max(0, (elapsed - idle) / elapsed) * 100).toFixed(2))
    : 0;
  previousSystemCpu = currentSystemCpu;

  latestStats = {
    timestamp: new Date().toISOString(),
    publicIp: getPublicIp(),
    cpu: { usagePercent: systemCpuPercent },
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usagePercent: Number(((used / total) * 100).toFixed(2))
    },
    uptimeSeconds: os.uptime()
  };
}

function refreshProcessUsage() {
  const now = process.hrtime.bigint();
  const elapsedMicroseconds = Number(now - previousSampleTime) / 1000;
  const cpu = process.cpuUsage(previousCpu);
  const usedMicroseconds = cpu.user + cpu.system;

  previousCpu = process.cpuUsage();
  previousSampleTime = now;
  latestStats.process = {
    cpuPercent: elapsedMicroseconds > 0
      ? Number(((usedMicroseconds / elapsedMicroseconds) * 100).toFixed(2))
      : 0,
    memoryBytes: process.memoryUsage().rss
  };
}

export function startResourceMonitor() {
  refresh();
  refreshPublicIp();

  const statsTimer = setInterval(() => {
    refresh();
    refreshProcessUsage();
  }, 2000);
  const publicIpTimer = setInterval(refreshPublicIp, 10 * 60 * 1000);
  return () => {
    clearInterval(statsTimer);
    clearInterval(publicIpTimer);
  };
}

export function getSystemStats() {
  return latestStats;
}
