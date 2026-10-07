import { spawn } from "node:child_process";
import { appendProjectLog } from "../services/projectLogs.js";

const processes = new Map();

export function getProcess(id) {
  return processes.get(id);
}

export function startProcess(id, command, cwd, { env = {}, onExit, onError } = {}) {
  if (processes.has(id)) {
    throw new Error("Project is already running.");
  }

  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });

  processes.set(id, child);
  appendProjectLog(id, `실행 시작: ${command}`).catch(() => {});
  captureOutput(id, child);

  const removeProcess = () => {
    if (processes.get(id) === child) processes.delete(id);
  };

  child.once("exit", (code, signal) => {
    removeProcess();
    appendProjectLog(id, `프로세스 종료 (code=${code}, signal=${signal || "none"})`).catch(() => {});
    onExit?.({ code, signal });
  });

  child.once("error", (error) => {
    removeProcess();
    appendProjectLog(id, `프로세스 오류: ${error.message}`, "ERROR").catch(() => {});
    onError?.(error);
  });

  return child;
}

export function runProjectCommand(id, command, cwd, { env = {} } = {}) {
  if (!command?.trim()) return Promise.resolve({ code: 0, skipped: true });
  if (processes.has(id)) throw new Error("Project already has an active process.");

  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });
  processes.set(id, child);
  appendProjectLog(id, `빌드 시작: ${command}`).catch(() => {});
  captureOutput(id, child);

  return new Promise((resolve, reject) => {
    let settled = false;
    const removeProcess = () => {
      if (processes.get(id) === child) processes.delete(id);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      removeProcess();
      appendProjectLog(id, `빌드 실행 오류: ${error.message}`, "ERROR").catch(() => {});
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      removeProcess();
      appendProjectLog(id, `빌드 종료 (code=${code}, signal=${signal || "none"})`).catch(() => {});
      resolve({ code: code ?? 1, signal });
    });
  });
}

function captureOutput(id, child) {
  child.stdout?.on("data", (chunk) => appendProjectLog(id, chunk.toString(), "OUT").catch(() => {}));
  child.stderr?.on("data", (chunk) => appendProjectLog(id, chunk.toString(), "ERR").catch(() => {}));
}

export function stopProcess(id) {
  const child = getProcess(id);
  if (!child) return false;

  const signalSent = child.kill("SIGTERM");
  if (!signalSent) processes.delete(id);
  return signalSent;
}

export async function stopProcessAndWait(id, timeoutMs = 10000) {
  const child = getProcess(id);
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return new Promise((resolve) => {
    let finished = false;
    let forceKillTimer;
    const finish = (stopped) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(stopped);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      forceKillTimer = setTimeout(() => {
        finish(child.exitCode !== null || child.signalCode !== null);
      }, 2000);
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    if (!child.kill("SIGTERM")) finish(child.exitCode !== null || child.signalCode !== null);
  });
}
