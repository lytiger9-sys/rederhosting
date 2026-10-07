import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";
import { getProject } from "./projectManager.js";
import { lockProject } from "../utils/projectOperationLock.js";

export function normalizeProjectRelativePath(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("A file path is required.");
  }

  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) =>
    segment === "." ||
    segment === ".." ||
    segment.includes("\0") ||
    segment.includes(":") ||
    segment.endsWith(".") ||
    segment.endsWith(" ")
  )) {
    throw new Error("Invalid file path.");
  }

  const relativePath = segments.join("/");
  if (!relativePath || ["project.json", ".env"].includes(relativePath.toLowerCase())) {
    throw new Error("프로젝트 메타데이터와 루트 .env 파일은 일반 파일 기능에서 변경할 수 없습니다.");
  }

  return relativePath;
}

async function resolveProjectPath(projectId, relativePath) {
  await getProject(projectId);
  const safeRelativePath = normalizeProjectRelativePath(relativePath);
  const projectRoot = path.resolve(config.projectRoot, projectId);
  const targetPath = path.resolve(projectRoot, ...safeRelativePath.split("/"));

  if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("Invalid file path.");
  }

  let currentPath = projectRoot;
  for (const segment of safeRelativePath.split("/")) {
    currentPath = path.join(currentPath, segment);
    try {
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return { projectRoot, targetPath, relativePath: safeRelativePath };
}

export async function listProjectFiles(projectId) {
  await getProject(projectId);
  const projectRoot = path.resolve(config.projectRoot, projectId);
  const files = [];

  async function walk(directory, parentPath = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    for (const entry of entries) {
      if (!parentPath && ["project.json", ".env"].includes(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) continue;

      const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = await fs.stat(absolutePath);

      if (entry.isDirectory()) {
        files.push({ path: relativePath, type: "directory", size: 0, modifiedAt: stats.mtime.toISOString() });
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({ path: relativePath, type: "file", size: stats.size, modifiedAt: stats.mtime.toISOString() });
      }
    }
  }

  await walk(projectRoot);
  return files;
}

export async function deleteProjectFile(projectId, relativePath) {
  const unlock = lockProject(projectId);
  try {
    const target = await resolveProjectPath(projectId, relativePath);
    const stats = await fs.lstat(target.targetPath);
    if (!stats.isFile()) throw new Error("Only files can be deleted.");
    await fs.unlink(target.targetPath);
    return target.relativePath;
  } finally {
    unlock();
  }
}

export async function getProjectFile(projectId, relativePath) {
  const target = await resolveProjectPath(projectId, relativePath);
  const stats = await fs.stat(target.targetPath);
  if (!stats.isFile()) throw new Error("The requested path is not a file.");
  return { path: target.targetPath, name: path.basename(target.targetPath) };
}
