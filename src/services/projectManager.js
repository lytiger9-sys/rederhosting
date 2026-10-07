import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config/env.js";
import { getProcess, startProcess, stopProcess, stopProcessAndWait } from "../utils/processManager.js";
import { isProjectLocked, lockProject } from "../utils/projectOperationLock.js";
import {
  normalizeProjectEnvironment,
  readProjectEnvironment,
  writeProjectEnvironmentFile
} from "./projectEnvironment.js";
import { isDiscordSyncConfigured, readLatestProjectSnapshot, sendProjectSnapshot } from "./discordSync.js";
import { clearProjectLogs } from "./projectLogs.js";
import { cleanupPendingProjectDeletions, removeProjectDirectory } from "./projectDeletion.js";

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let creatingProject = false;

export async function ensureStorage() {
  await fs.mkdir(config.projectRoot, { recursive: true });
  await cleanupPendingProjectDeletions(config.projectRoot);
}

function projectPath(id) {
  if (!projectIdPattern.test(id)) {
    throw new Error("Invalid project ID.");
  }

  return path.join(config.projectRoot, id);
}

export function getProjectDirectory(id) {
  return projectPath(id);
}

async function readMetadata(id) {
  return JSON.parse(
    await fs.readFile(path.join(projectPath(id), "project.json"), "utf8")
  );
}

async function writeMetadata(project) {
  const dir = projectPath(project.id);
  await fs.mkdir(dir, { recursive: true });

  const metadataPath = path.join(dir, "project.json");
  const tempPath = path.join(dir, `.project-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, JSON.stringify(project, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(tempPath, metadataPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function withoutEnvironment(project) {
  const { environment: _environment, ...publicProject } = project;
  return publicProject;
}

async function listProjectSnapshots() {
  const entries = await fs.readdir(config.projectRoot, { withFileTypes: true });
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await readMetadata(entry.name);
      const variables = project.environment
        ? Object.entries(project.environment).map(([key, value]) => ({ key, value }))
        : await readProjectEnvironment(projectPath(project.id));
      snapshots.push({
        id: project.id,
        name: project.name,
        buildCommand: project.buildCommand || "",
        startCommand: project.startCommand || "",
        environment: Object.fromEntries(variables.map(({ key, value }) => [key, value])),
        repositoryUrl: project.repositoryUrl || "",
        repository: project.repository || "",
        defaultBranch: project.defaultBranch || "",
        lastImportedCommit: project.lastImportedCommit || "",
        deployedCommit: project.deployedCommit || "",
        createdAt: project.createdAt
      });
    } catch (error) {
      console.warn(`프로젝트 스냅샷을 건너뜁니다 (${entry.name}): ${error.message}`);
    }
  }
  return snapshots;
}

async function publishProjectSnapshot(reason) {
  if (!isDiscordSyncConfigured()) return { configured: false, ok: false };
  try {
    await sendProjectSnapshot(await listProjectSnapshots(), reason);
    return { configured: true, ok: true };
  } catch (error) {
    console.error(`Discord 설정 스냅샷 전송 실패: ${error.message}`);
    return { configured: true, ok: false, error: error.message };
  }
}

export async function listProjects() {
  const entries = await fs.readdir(config.projectRoot, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    try {
      projects.push(withoutEnvironment(await readMetadata(entry.name)));
    } catch {}
  }

  return projects;
}

export async function createProject(input = {}) {
  const name = String(input.name || "").trim();

  if (!name) throw new Error("Project name is required.");
  if (creatingProject) {
    const error = new Error("다른 프로젝트를 생성 중입니다. 잠시 후 다시 시도하세요.");
    error.status = 409;
    throw error;
  }
  creatingProject = true;
  try {
    const duplicate = (await listProjects()).some((project) => project.name.trim().toLowerCase() === name.toLowerCase());
    if (duplicate) throw new Error("같은 이름의 프로젝트가 이미 있습니다.");

    const project = {
      id: crypto.randomUUID(),
      name,
      buildCommand: String(input.buildCommand || ""),
      startCommand: String(input.startCommand || ""),
      environment: {},
      status: "stopped",
      createdAt: new Date().toISOString()
    };

    await fs.mkdir(projectPath(project.id), { recursive: true });
    await writeMetadata(project);
    const discordSync = await publishProjectSnapshot(`프로젝트 생성: ${project.name}`);

    return { ...withoutEnvironment(project), discordSync };
  } finally {
    creatingProject = false;
  }
}

export async function getProject(id) {
  return withoutEnvironment(await readMetadata(id));
}

export async function getProjectDetails(id) {
  const project = await readMetadata(id);
  return {
    id: project.id,
    name: project.name,
    buildCommand: project.buildCommand || "",
    startCommand: project.startCommand || "",
    repositoryUrl: project.repositoryUrl || "",
    repository: project.repository || "",
    defaultBranch: project.defaultBranch || "",
    lastImportedCommit: project.lastImportedCommit || "",
    deployedCommit: project.deployedCommit || "",
    status: project.status,
    createdAt: project.createdAt
  };
}

export async function setProjectRepository(id, repository) {
  const project = await readMetadata(id);
  project.repositoryUrl = repository.repositoryUrl;
  project.repository = repository.repository;
  project.defaultBranch = repository.branch;
  project.lastImportedCommit = repository.commit;
  await writeMetadata(project);
  const discordSync = await publishProjectSnapshot(`GitHub 저장소 연결: ${project.name}`);
  return { project: withoutEnvironment(project), discordSync };
}

export async function updateProjectDeployment(id, repository) {
  const project = await readMetadata(id);
  project.repositoryUrl = repository.repositoryUrl || project.repositoryUrl;
  project.repository = repository.repository || project.repository;
  project.defaultBranch = repository.branch || project.defaultBranch;
  project.deployedCommit = repository.commit;
  await writeMetadata(project);
  const discordSync = await publishProjectSnapshot(`커밋 배포: ${project.name} (${repository.commit.slice(0, 7)})`);
  return { project: withoutEnvironment(project), discordSync };
}

export async function updateProjectStatus(id, status) {
  const project = await readMetadata(id);
  project.status = status;
  if (status !== "running") delete project.pid;
  await writeMetadata(project);
  return project;
}

export async function deleteProject(id) {
  const project = await readMetadata(id);
  const unlock = lockProject(id);
  try {
    if (getProcess(id)) {
      const stopped = await stopProcessAndWait(id);
      if (!stopped) {
        const error = new Error("프로젝트 프로세스를 종료하지 못해 삭제를 중단했습니다.");
        error.status = 409;
        throw error;
      }
    }

    const root = path.resolve(config.projectRoot);
    const target = path.resolve(projectPath(id));
    if (path.dirname(target) !== root) throw new Error("잘못된 프로젝트 경로입니다.");
    const stats = await fs.lstat(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("프로젝트 폴더가 올바르지 않습니다.");
    await removeProjectDirectory(root, target, id);
    await clearProjectLogs(id);
  } finally {
    unlock();
  }

  const discordSync = await publishProjectSnapshot(`프로젝트 삭제: ${project.name}`);
  return { id, deleted: true, discordSync };
}

export async function updateProjectEnvironment(id, variables) {
  const project = await readMetadata(id);
  const normalized = normalizeProjectEnvironment(variables);
  await writeProjectEnvironmentFile(id, projectPath(id), normalized);
  project.environment = Object.fromEntries(normalized.map(({ key, value }) => [key, value]));
  await writeMetadata(project);
  const discordSync = await publishProjectSnapshot(`환경변수 변경: ${project.name}`);
  return { variables: normalized, discordSync };
}

function normalizeSnapshotProjects(projects) {
  if (!Array.isArray(projects)) throw new Error("Discord 프로젝트 목록 형식이 올바르지 않습니다.");
  const names = new Set();
  return projects.map((source) => {
    if (!source || !projectIdPattern.test(String(source.id || ""))) {
      throw new Error("Discord 스냅샷에 올바르지 않은 프로젝트 ID가 있습니다.");
    }
    const name = String(source.name || "").trim();
    if (!name) throw new Error("Discord 스냅샷에 프로젝트 이름이 없습니다.");
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`Discord 스냅샷에 중복된 프로젝트 이름이 있습니다: ${name}`);
    names.add(normalizedName);
    const environment = source.environment && typeof source.environment === "object" && !Array.isArray(source.environment)
      ? Object.entries(source.environment).map(([key, value]) => ({ key, value }))
      : [];
    const validEnvironment = normalizeProjectEnvironment(environment);
    return {
      id: source.id,
      name,
      buildCommand: String(source.buildCommand || ""),
      startCommand: String(source.startCommand || ""),
      environment: Object.fromEntries(validEnvironment.map(({ key, value }) => [key, value])),
      repositoryUrl: String(source.repositoryUrl || ""),
      repository: String(source.repository || ""),
      defaultBranch: String(source.defaultBranch || ""),
      lastImportedCommit: String(source.lastImportedCommit || ""),
      deployedCommit: String(source.deployedCommit || ""),
      createdAt: source.createdAt || new Date().toISOString()
    };
  });
}

export async function syncProjectSettingsFromDiscord() {
  if (!isDiscordSyncConfigured()) {
    console.info("Discord 동기화가 설정되지 않아 로컬 프로젝트 설정을 사용합니다.");
    return;
  }
  try {
    const snapshot = await readLatestProjectSnapshot();
    if (!snapshot) {
      await publishProjectSnapshot("초기 스냅샷");
      return;
    }

    const incoming = normalizeSnapshotProjects(snapshot.projects);
    const incomingIds = new Set(incoming.map((project) => project.id));
    const local = await listProjectSnapshots();
    const mergedNames = new Map();
    for (const project of [...local.filter(({ id }) => !incomingIds.has(id)), ...incoming]) {
      const normalizedName = project.name.trim().toLowerCase();
      if (mergedNames.has(normalizedName)) {
        throw new Error(`Discord 설정을 반영하면 프로젝트 이름이 중복됩니다: ${project.name}`);
      }
      mergedNames.set(normalizedName, project.id);
    }

    for (const settings of incoming) {
      const existing = await readMetadata(settings.id).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const project = {
        ...(existing || {}),
        ...settings,
        status: "stopped"
      };
      delete project.pid;
      await fs.mkdir(projectPath(settings.id), { recursive: true });
      await writeProjectEnvironmentFile(
        settings.id,
        projectPath(settings.id),
        Object.entries(settings.environment).map(([key, value]) => ({ key, value }))
      );
      await writeMetadata(project);
    }
    console.info(`Discord에서 ${incoming.length}개 프로젝트 설정을 반영했습니다.`);
  } catch (error) {
    console.error(`Discord 프로젝트 설정 동기화 실패: ${error.message}`);
  }
}

export async function startProject(id, { operationLockAlreadyHeld = false } = {}) {
  const project = await readMetadata(id);

  if (!operationLockAlreadyHeld && isProjectLocked(id)) {
    throw new Error("A project operation is already in progress.");
  }

  if (getProcess(id)) {
    throw new Error("Project is already running.");
  }

  if (!project.startCommand) {
    throw new Error("Start command is not configured.");
  }

  let metadataWrite = Promise.resolve();
  const markStopped = async () => {
    try {
      await metadataWrite;
      const latest = await readMetadata(id);
      if (latest.pid !== child.pid) return;
      latest.status = "stopped";
      delete latest.pid;
      await writeMetadata(latest);
    } catch {}
  };

  // 개발용 기본 프로세스 관리자. 공개 서비스에는 실행 격리가 필요하다.
  const environment = await readProjectEnvironment(projectPath(id));
  const child = startProcess(id, project.startCommand, projectPath(id), {
    env: Object.fromEntries(environment.map(({ key, value }) => [key, value])),
    onExit: markStopped,
    onError: markStopped
  });

  project.status = "running";
  project.pid = child.pid;
  metadataWrite = writeMetadata(project);
  try {
    await metadataWrite;
  } catch (error) {
    stopProcess(id);
    throw error;
  }

  return withoutEnvironment(project);
}

export async function stopProject(id) {
  if (isProjectLocked(id)) {
    const error = new Error("프로젝트 작업이 진행 중입니다. 잠시 후 다시 시도하세요.");
    error.status = 409;
    throw error;
  }
  const project = await readMetadata(id);
  const child = getProcess(id);

  if (!child) {
    project.status = "stopped";
    delete project.pid;
    await writeMetadata(project);
    return withoutEnvironment(project);
  }

  project.status = "stopping";
  await writeMetadata(project);

  const signalSent = stopProcess(id);
  if (!signalSent) {
    project.status = "stopped";
    delete project.pid;
    await writeMetadata(project);
  }

  return withoutEnvironment(project);
}
