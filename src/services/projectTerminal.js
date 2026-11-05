import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { WebSocketServer } from "ws";
import { getProject, getProjectDirectory } from "./projectManager.js";
import { readProjectEnvironment } from "./projectEnvironment.js";
import { isAuthenticated } from "./authentication.js";
import { isProjectLocked } from "../utils/projectOperationLock.js";

const sessions = new Map();
const MAX_BUFFER = 256 * 1024;
const terminalUpgradePath = /^\/api\/projects\/([0-9a-f-]+)\/terminal\/([0-9a-f-]+)\/ws$/i;
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function removeSession(session) {
  if (sessions.get(session.projectId) !== session) return;
  sessions.delete(session.projectId);
  try { session.terminal.kill(); } catch {}
}

export async function createProjectTerminal(projectId) {
  await getProject(projectId);
  if (isProjectLocked(projectId)) {
    const error = new Error("프로젝트 작업이 진행 중입니다. 잠시 후 다시 시도하세요.");
    error.status = 409;
    throw error;
  }
  if (sessions.has(projectId)) {
    const error = new Error("이 프로젝트의 터미널이 이미 열려 있습니다.");
    error.status = 409;
    throw error;
  }

  const cwd = getProjectDirectory(projectId);
  const variables = await readProjectEnvironment(cwd);
  const env = { ...process.env, ...Object.fromEntries(variables.map(({ key, value }) => [key, value])) };
  const isWindows = process.platform === "win32";
  const shell = isWindows ? (process.env.COMSPEC || "powershell.exe") : (process.env.SHELL || "/bin/bash");
  const args = isWindows && /powershell/i.test(shell) ? ["-NoLogo", "-NoExit"] : [];
  const terminal = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: 100,
    rows: 28,
    cwd: path.resolve(cwd),
    env,
    useConpty: isWindows,
    encoding: "utf8"
  });
  const session = {
    id: crypto.randomUUID(),
    projectId,
    terminal,
    socket: null,
    buffer: "",
    closed: false
  };
  sessions.set(projectId, session);

  terminal.onData((data) => {
    session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
    send(session.socket, { type: "data", data });
  });
  terminal.onExit(({ exitCode }) => {
    send(session.socket, { type: "exit", exitCode });
    session.closed = true;
    if (sessions.get(projectId) === session) sessions.delete(projectId);
  });

  return { sessionId: session.id, platform: os.platform(), shell: path.basename(shell) };
}

export function closeProjectTerminal(projectId, sessionId) {
  const session = sessions.get(projectId);
  if (!session || session.id !== sessionId) return false;
  removeSession(session);
  return true;
}

export function closeProjectTerminalForProject(projectId) {
  const session = sessions.get(projectId);
  if (!session) return false;
  removeSession(session);
  return true;
}

export function handleProjectTerminalUpgrade(request, socket, head) {
  const url = new URL(request.url || "/", "http://localhost");
  const match = terminalUpgradePath.exec(url.pathname);
  if (!match) return false;

  const [, projectId, sessionId] = match;
  const session = sessions.get(projectId);
  if (!isAuthenticated(request)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return true;
  }
  const origin = request.headers.origin;
  if (origin && new URL(origin).host !== request.headers.host) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return true;
  }
  if (!session || session.id !== sessionId || session.closed) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return true;
  }

  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    if (session.socket && session.socket.readyState === session.socket.OPEN) session.socket.close(1000, "Replaced");
    session.socket = websocket;
    send(websocket, { type: "data", data: session.buffer });
    websocket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "input" && typeof message.data === "string" && message.data.length <= 60_000) {
        session.terminal.write(message.data);
      } else if (message.type === "resize") {
        const cols = Math.max(20, Math.min(300, Number(message.cols) || 80));
        const rows = Math.max(5, Math.min(100, Number(message.rows) || 24));
        try { session.terminal.resize(cols, rows); } catch {}
      }
    });
    websocket.on("close", () => {
      if (session.socket === websocket) {
        session.socket = null;
        removeSession(session);
      }
    });
    websocket.on("error", () => {
      if (session.socket === websocket) removeSession(session);
    });
  });
  return true;
}
