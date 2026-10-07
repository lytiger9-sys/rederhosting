import os from "node:os";

let previousCpu = process.cpuUsage();
let previousSampleTime = process.hrtime.bigint();

let latestStats = {
  timestamp: new Date().toISOString(),
  cpu: { usagePercent: 0 },
  process: {
    cpuPercent: 0,
    memoryBytes: process.memoryUsage().rss
  },
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

  latestStats = {
    timestamp: new Date().toISOString(),
    cpu: latestStats.cpu,
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

  setInterval(() => {
    refresh();
    refreshProcessUsage();
  }, 2000);
}

export function getSystemStats() {
  return latestStats;
}
