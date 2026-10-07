import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { lockProject } from "../utils/projectOperationLock.js";

const MAX_ENV_SIZE = 64 * 1024;
const MAX_VARIABLES = 100;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function readProjectEnvironment(projectDirectory) {
  try {
    const contents = await fs.readFile(path.join(projectDirectory, ".env"), "utf8");
    return Object.entries(dotenv.parse(contents)).map(([key, value]) => ({ key, value }));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function normalizeProjectEnvironment(variables) {
  if (!Array.isArray(variables) || variables.length > MAX_VARIABLES) {
    throw new Error(`환경변수는 최대 ${MAX_VARIABLES}개까지 저장할 수 있습니다.`);
  }

  const seen = new Set();
  const normalized = variables.map((item) => {
    const key = String(item?.key ?? "").trim();
    const value = String(item?.value ?? "");
    if (!KEY_PATTERN.test(key)) throw new Error(`변수 이름이 올바르지 않습니다: ${key || "(빈 값)"}`);
    if (seen.has(key)) throw new Error(`중복된 변수 이름입니다: ${key}`);
    if (value.includes("\0")) throw new Error(`${key} 값에 사용할 수 없는 문자가 있습니다.`);
    seen.add(key);
    return { key, value };
  });

  const contents = normalized.map(({ key, value }) => `${key}=${JSON.stringify(value)}`).join("\n");
  if (Buffer.byteLength(contents, "utf8") > MAX_ENV_SIZE) {
    const error = new Error("환경변수 파일은 64KB를 초과할 수 없습니다.");
    error.status = 413;
    throw error;
  }
  const parsed = dotenv.parse(contents);
  if (normalized.some(({ key, value }) => parsed[key] !== value)) {
    throw new Error("환경변수 값을 .env 형식으로 변환하지 못했습니다.");
  }

  return normalized;
}

export async function writeProjectEnvironmentFile(projectId, projectDirectory, variables) {
  const normalized = normalizeProjectEnvironment(variables);
  const contents = normalized.map(({ key, value }) => `${key}=${JSON.stringify(value)}`).join("\n");
  const unlock = lockProject(projectId);
  const envPath = path.join(projectDirectory, ".env");
  const tempPath = path.join(projectDirectory, `.env-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, contents ? `${contents}\n` : "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(tempPath, envPath);
    return normalized;
  } finally {
    unlock();
    await fs.rm(tempPath, { force: true });
  }
}
