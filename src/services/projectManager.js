import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config/env.js";
import { getProcess, startProcess, stopProcess, stopProcessAndWait, waitForProcessStartup } from "../utils/processManager.js";
import { isProjectLocked, lockProject } from "../utils/projectOperationLock.js";
import {
  normalizeProjectEnvironment,
  readProjectEnvironment,
  writeProjectEnvironmentFile
} from "./projectEnvironment.js";
import { isDiscordSyncConfigured, readLatestProjectSnapshot, sendProjectSnapshot } from "./discordSync.js";
import { appendProjectLog, clearProjectLogs } from "./projectLogs.js";
import { cleanupPendingProjectDeletions, removeProjectDirectory } from "./projectDeletion.js";
import { normalizeProjectSlug, validateProjectName } from "./projectSlug.js";
import { releaseProjectPort, reserveProjectPort } from "./projectPorts.js";

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let creatingProject = false;

export async function ensureStorage() {
  await fs.mkdir(config.projectRoot, { recursive: true });
  await cleanupPendingProjectDeletions(config.projectRoot);
  const entries = await fs.readdir(config.projectRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await readMetadata(entry.name);
      if (!["running", "stopping", "deploying"].includes(project.status)) continue;
      project.status = "stopped";
      delete project.pid;
      delete project.port;
      await writeMetadata(project);
    } catch (error) {
      console.warn(`프로젝트 실행 상태를 초기화하지 못했습니다 (${entry.name}): ${error.message}`);
    }
  }
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
  return { ...publicProject, slug: project.slug || normalizeProjectSlug(project.name) };
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
        slug: project.slug || normalizeProjectSlug(project.name),
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

export async function findProjectBySlug(slug) {
  const entries = await fs.readdir(config.projectRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await readMetadata(entry.name);
      const projectSlug = project.slug || normalizeProjectSlug(project.name);
      if (projectSlug === slug) return withoutEnvironment({ ...project, slug: projectSlug });
    } catch {}
  }
  return null;
}

export async function createProject(input = {}) {
  const name = String(input.name || "").trim();

  const slug = validateProjectName(name);
  if (creatingProject) {
    const error = new Error("다른 프로젝트를 생성 중입니다. 잠시 후 다시 시도하세요.");
    error.status = 409;
    throw error;
  }
  creatingProject = true;
  try {
    const duplicate = (await listProjects()).some((project) => project.slug === slug);
    if (duplicate) throw new Error("같은 이름의 프로젝트가 이미 있습니다.");

    const project = {
      id: crypto.randomUUID(),
      name,
      slug,
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
  if (status !== "running") {
    delete project.pid;
    delete project.port;
  }
  await writeMetadata(project);
  return project;
}

async function rejectProjectStart(project, message, status = "start_failed", httpStatus = 422) {
  releaseProjectPort(project.id);
  project.status = status;
  project.operationMessage = message;
  delete project.pid;
  delete project.port;
  await writeMetadata(project);
  await appendProjectLog(project.id, message, status === "completed" ? "INFO" : "ERROR");
  const error = new Error(message);
  error.status = httpStatus;
  error.projectStatus = status;
  throw error;
}

async function completeProjectCommand(project, message) {
  releaseProjectPort(project.id);
  project.status = "completed";
  project.operationMessage = message;
  delete project.pid;
  delete project.port;
  await writeMetadata(project);
  await appendProjectLog(project.id, message, "INFO");
  return withoutEnvironment(project);
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
  const slugs = new Set();
  return projects.map((source) => {
    if (!source || !projectIdPattern.test(String(source.id || ""))) {
      throw new Error("Discord 스냅샷에 올바르지 않은 프로젝트 ID가 있습니다.");
    }
    const name = String(source.name || "").trim();
    if (!name) throw new Error("Discord 스냅샷에 프로젝트 이름이 없습니다.");
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`Discord 스냅샷에 중복된 프로젝트 이름이 있습니다: ${name}`);
    names.add(normalizedName);
    const slug = normalizeProjectSlug(name);
    if (slug && slugs.has(slug)) throw new Error(`Discord 스냅샷에 중복된 프로젝트 주소가 있습니다: ${slug}`);
    if (slug) slugs.add(slug);
    const environment = source.environment && typeof source.environment === "object" && !Array.isArray(source.environment)
      ? Object.entries(source.environment).map(([key, value]) => ({ key, value }))
      : [];
    const validEnvironment = normalizeProjectEnvironment(environment);
    return {
      id: source.id,
      name,
      slug,
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
      delete project.port;
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
    const error = new Error("프로젝트 프로세스가 이미 실행 중입니다.");
    error.status = 409;
    throw error;
  }

  if (!project.startCommand) {
    return rejectProjectStart(project, "실행 커맨드가 설정되지 않았습니다. 프로젝트 생성 설정에 Start Command를 입력하세요.");
  }

  const slug = project.slug || normalizeProjectSlug(project.name);
  if (!slug) {
    return rejectProjectStart(project, "이 프로젝트 이름은 공개 주소로 사용할 수 없습니다. 영문·숫자·하이픈 이름으로 다시 생성하세요.");
  }

  const sourceEntries = await fs.readdir(projectPath(id));
  if (!sourceEntries.some((entry) => !["project.json", ".env"].includes(entry.toLowerCase()))) {
    return rejectProjectStart(project, "실행할 소스 파일이 없습니다. 소스 파일에서 공개 GitHub 저장소를 연결하고 커밋을 배포하세요.");
  }

  let port;
  try {
    port = await reserveProjectPort(id);
  } catch (error) {
    return rejectProjectStart(project, `실행 포트를 할당하지 못했습니다: ${error.message}`, "start_failed", error.status || 503);
  }
  let metadataWrite = Promise.resolve();
  let child;
  const markStopped = async ({ code, signal, error } = {}) => {
    releaseProjectPort(id);
    try {
      await metadataWrite;
      const latest = await readMetadata(id);
      if (latest.pid !== child?.pid) return;
      const wasStarting = latest.status === "starting";
      const wasRunning = latest.status === "running";
      const wasStopping = latest.status === "stopping";
      if (wasStopping) {
        latest.status = "stopped";
        latest.operationMessage = "프로젝트가 정상적으로 중지되었습니다.";
      } else if (wasStarting || wasRunning) {
        latest.status = code === 0 ? "completed" : (wasStarting ? "start_failed" : "crashed");
        latest.operationMessage = code === 0
          ? "실행 명령이 종료되었습니다. 웹 서버나 봇처럼 계속 실행되는 명령인지 확인하세요."
          : `${wasStarting ? "실행 시작 중" : "실행 중"} 오류로 프로세스가 종료되었습니다 (종료 코드 ${code ?? 1}). 로그를 확인하세요.`;
      } else {
        latest.status = "stopped";
        latest.operationMessage = "실행 프로세스가 종료되었습니다.";
      }
      if (error) {
        latest.status = wasStarting ? "start_failed" : "crashed";
        latest.operationMessage = `프로세스 시작 오류: ${error.message}`;
      }
      latest.lastExitCode = code ?? null;
      latest.lastExitSignal = signal || null;
      delete latest.pid;
      delete latest.port;
      await writeMetadata(latest);
    } catch {}
  };

  try {
    const environment = await readProjectEnvironment(projectPath(id));
    child = startProcess(id, project.startCommand, projectPath(id), {
      env: {
        ...Object.fromEntries(environment.map(({ key, value }) => [key, value])),
        PORT: String(port),
        HOST: "0.0.0.0",
        BASE_PATH: `/${slug}`
      },
      onExit: markStopped,
      onError: markStopped
    });

    project.slug = slug;
    project.port = port;
    project.status = "starting";
    project.operationMessage = "실행 명령을 시작하고 초기 오류를 확인하는 중입니다...";
    project.pid = child.pid;
    metadataWrite = writeMetadata(project);
    await metadataWrite;

    const startup = await waitForProcessStartup(child);
    if (!startup.running || child.exitCode !== null || child.signalCode !== null) {
      const code = startup.code ?? child.exitCode ?? 1;
      const message = code === 0
        ? "실행 명령이 오류 없이 종료되었습니다. 웹 서버나 봇처럼 계속 실행되는 명령인지 확인하세요."
        : `실행 중 오류가 발생해 프로세스가 종료되었습니다 (종료 코드 ${code}). 로그 보기에서 터미널 출력을 확인하세요.`;
      if (code === 0) return completeProjectCommand(project, message);
      return rejectProjectStart(project, message, "start_failed");
    }

    project.status = "running";
    project.operationMessage = `프로젝트가 실행 중입니다. 주소: /${slug}/ · 포트 ${port}`;
    metadataWrite = writeMetadata(project);
    await metadataWrite;

    if (child.exitCode !== null || child.signalCode !== null) {
      const code = child.exitCode ?? 1;
      const message = code === 0
        ? "실행 명령이 오류 없이 종료되었습니다. 웹 서버나 봇처럼 계속 실행되는 명령인지 확인하세요."
        : `실행 중 오류가 발생해 프로세스가 종료되었습니다 (종료 코드 ${code}). 로그 보기에서 터미널 출력을 확인하세요.`;
      if (code === 0) return completeProjectCommand(project, message);
      return rejectProjectStart(project, message, "start_failed");
    }
  } catch (error) {
    if (child) stopProcess(id);
    else releaseProjectPort(id);
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
    const wasActive = ["running", "starting", "stopping"].includes(project.status);
    project.status = "stopped";
    project.operationMessage = wasActive
      ? "실행 프로세스에 연결되지 않아 프로젝트를 중지 상태로 정리했습니다."
      : "프로젝트가 이미 중지되어 있습니다.";
    delete project.pid;
    delete project.port;
    await writeMetadata(project);
    await appendProjectLog(id, project.operationMessage, "INFO");
    return withoutEnvironment(project);
  }

  project.status = "stopping";
  project.operationMessage = "프로젝트 종료를 요청했습니다. 프로세스가 완전히 끝날 때까지 기다리는 중입니다...";
  await writeMetadata(project);
  await appendProjectLog(id, project.operationMessage, "INFO");

  const stopped = await stopProcessAndWait(id);
  if (!stopped) {
    project.status = "stop_failed";
    project.operationMessage = "프로세스를 종료하지 못했습니다. 로그를 확인하고 서버를 점검하세요.";
    await writeMetadata(project);
    await appendProjectLog(id, project.operationMessage, "ERROR");
    const error = new Error(project.operationMessage);
    error.status = 409;
    throw error;
  }

  const latest = await readMetadata(id);
  latest.status = "stopped";
  latest.operationMessage = "프로젝트가 정상적으로 중지되었습니다.";
  delete latest.pid;
  delete latest.port;
  await writeMetadata(latest);
  await appendProjectLog(id, latest.operationMessage, "INFO");
  releaseProjectPort(id);
  return withoutEnvironment(latest);
}
