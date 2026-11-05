import crypto from "node:crypto";
import { config } from "../config/env.js";

const COOKIE_NAME = "hosting_panel_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const sessions = new Map();
const loginAttempts = new Map();

function equalSecret(candidate, expected) {
  const candidateBuffer = Buffer.from(String(candidate ?? ""));
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function readSessionToken(request) {
  const cookieHeader = request.headers.cookie || "";
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== COOKIE_NAME) continue;
    return decodeURIComponent(entry.slice(separator + 1).trim());
  }
  return "";
}

export function isAuthenticated(request) {
  const token = readSessionToken(request);
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getAttemptRecord(ip) {
  const now = Date.now();
  let record = loginAttempts.get(ip);
  if (!record || now - record.startedAt >= LOGIN_WINDOW_MS) {
    record = { startedAt: now, count: 0 };
    loginAttempts.set(ip, record);
  }
  return record;
}

export function validateAuthConfiguration() {
  if (!config.authUsername || !config.authPassword) {
    throw new Error("로그인을 사용하려면 패널 루트 .env에 AUTH_USERNAME과 AUTH_PASSWORD를 설정하세요.");
  }
}

export function authenticateLogin(request, response) {
  const ip = request.ip || request.socket.remoteAddress || "unknown";
  const attempts = getAttemptRecord(ip);
  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    return response.status(429).json({ error: "로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요." });
  }

  const usernameMatches = equalSecret(request.body?.username, config.authUsername);
  const passwordMatches = equalSecret(request.body?.password, config.authPassword);
  if (!usernameMatches || !passwordMatches) {
    attempts.count += 1;
    return response.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { expiresAt, username: config.authUsername });
  const secure = request.secure ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  response.setHeader("Cache-Control", "no-store");
  return response.json({ authenticated: true });
}

export function clearLoginSession(request, response) {
  const token = readSessionToken(request);
  if (token) sessions.delete(token);
  const secure = request.secure ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`);
  response.setHeader("Cache-Control", "no-store");
  return response.json({ authenticated: false });
}

export function loginStatus(request, response) {
  const session = sessions.get(readSessionToken(request));
  const valid = Boolean(session && session.expiresAt > Date.now());
  if (session && !valid) sessions.delete(readSessionToken(request));
  response.setHeader("Cache-Control", "no-store");
  return response.json({ authenticated: valid, username: valid ? session.username : undefined });
}

function isPublicAsset(pathname) {
  return pathname === "/login.html" ||
    pathname === "/js/login.js" ||
    pathname === "/css/login.css" ||
    pathname === "/favicon.ico";
}

export function requireLogin(request, response, next) {
  const pathname = request.path;
  if (isPublicAsset(pathname) || pathname === "/api/health") return next();

  if (isAuthenticated(request)) return next();

  response.setHeader("Cache-Control", "no-store");
  if (pathname.startsWith("/api/")) {
    return response.status(401).json({ error: "로그인이 필요합니다." });
  }
  return response.redirect(303, "/login.html");
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [ip, attempt] of loginAttempts) {
    if (now - attempt.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 60_000).unref();
