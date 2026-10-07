import fs from "node:fs/promises";
import { constants } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { config } from "../config/env.js";
import { listProjectFiles, normalizeProjectRelativePath } from "./fileManager.js";
import { getProject } from "./projectManager.js";
import { lockProject } from "../utils/projectOperationLock.js";

const GITHUB_API = "https://api.github.com";
const MAX_IMPORT_FILES = 1000;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 2;

function parseRepositoryUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("올바른 GitHub 저장소 주소를 입력하세요.");
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) {
    throw new Error("https://github.com/owner/repository 형식의 공개 저장소 주소만 지원합니다.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("저장소 첫 화면 주소를 입력하세요. (예: https://github.com/owner/repository)");
  }

  const [owner, rawRepository] = segments;
  const repository = rawRepository.replace(/\.git$/i, "");
  const namePattern = /^[A-Za-z0-9_.-]+$/;
  if (!namePattern.test(owner) || !namePattern.test(repository) || repository === "." || repository === "..") {
    throw new Error("GitHub 주소에 올바르지 않은 저장소 이름이 있습니다.");
  }

  return { owner, repository };
}

async function fetchGitHubJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "hosting-panel",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw githubError("GitHub에 연결하지 못했습니다. 네트워크 상태를 확인하고 다시 시도하세요.", 502);
  }

  if (!response.ok) {
    const error = new Error(
      response.status === 404
        ? "공개 저장소를 찾을 수 없습니다. 주소를 확인하세요."
        : response.status === 403
          ? "GitHub API 요청 한도에 도달했거나 요청이 제한되었습니다. 잠시 후 다시 시도하세요."
          : `GitHub 요청 실패 (${response.status}).`
    );
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }

  return response.json();
}

function githubError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function getRepositoryFiles(owner, repository, requestedCommitSha = "") {
  const repoUrl = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repositoryInfo = await fetchGitHubJson(repoUrl);
  const branch = repositoryInfo.default_branch;
  if (!branch) throw githubError("저장소의 기본 브랜치를 확인할 수 없습니다.", 502);

  let commitSha = requestedCommitSha;
  if (commitSha && !/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw githubError("올바르지 않은 커밋 ID입니다.");
  }
  if (!commitSha) {
    const encodedBranch = encodeURIComponent(branch);
    const ref = await fetchGitHubJson(`${repoUrl}/git/ref/heads/${encodedBranch}`);
    commitSha = ref.object?.sha;
  }
  if (!commitSha) throw githubError("저장소의 최신 커밋을 확인할 수 없습니다.", 502);

  const tree = await fetchGitHubJson(`${repoUrl}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`);
  if (tree.truncated) {
    throw githubError("저장소 파일 목록이 너무 커서 가져올 수 없습니다.");
  }

  const allFiles = (tree.tree || []).filter((entry) =>
    entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755") &&
    entry.path.toLowerCase() !== ".env"
  );

  if (allFiles.length > MAX_IMPORT_FILES) {
    throw githubError(`저장소 파일이 ${MAX_IMPORT_FILES}개를 초과합니다.`);
  }

  let totalBytes = 0;
  const files = allFiles.map((entry) => {
    const relativePath = normalizeProjectRelativePath(entry.path);
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw githubError(`파일 크기를 지원하지 않습니다: ${relativePath}`);
    }
    totalBytes += size;
    return { path: relativePath, size };
  });

  if (totalBytes > MAX_IMPORT_BYTES) {
    throw githubError("저장소 전체 크기가 100MB 제한을 초과합니다.");
  }

  return { repositoryInfo, branch, commitSha, files, totalBytes };
}

export async function listPublicGitHubCommits(repositoryUrl) {
  const { owner, repository } = parseRepositoryUrl(repositoryUrl);
  const repoUrl = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repositoryInfo = await fetchGitHubJson(repoUrl);
  const commits = await fetchGitHubJson(
    `${repoUrl}/commits?sha=${encodeURIComponent(repositoryInfo.default_branch)}&per_page=30`
  );
  return {
    repository: repositoryInfo.full_name || `${owner}/${repository}`,
    branch: repositoryInfo.default_branch,
    commits: commits.map((item) => ({
      sha: item.sha,
      message: String(item.commit?.message || "").split("\n", 1)[0],
      author: item.commit?.author?.name || item.author?.login || "Unknown",
      date: item.commit?.author?.date || "",
      url: item.html_url
    }))
  };
}

async function downloadRepositoryFiles(owner, repository, commitSha, files, stagingRoot) {
  let actualTotalBytes = 0;

  for (let index = 0; index < files.length; index += DOWNLOAD_CONCURRENCY) {
    const batch = files.slice(index, index + DOWNLOAD_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (file) => {
      const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${commitSha}/${encodedPath}`;
      let response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      } catch {
        throw githubError(`GitHub 파일 다운로드에 실패했습니다: ${file.path}`, 502);
      }
      if (!response.ok) {
        throw githubError(`저장소 파일을 받지 못했습니다: ${file.path}`, 502);
      }

      const content = Buffer.from(await response.arrayBuffer());
      if (content.length > MAX_FILE_BYTES) {
        throw githubError(`파일 크기가 50MB를 초과합니다: ${file.path}`);
      }
      actualTotalBytes += content.length;
      if (actualTotalBytes > MAX_IMPORT_BYTES) {
        throw githubError("저장소 전체 크기가 100MB 제한을 초과합니다.");
      }

      const stagingPath = path.join(stagingRoot, ...file.path.split("/"));
      await fs.mkdir(path.dirname(stagingPath), { recursive: true });
      await fs.writeFile(stagingPath, content, { flag: "wx" });
    }));

    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  return actualTotalBytes;
}

async function moveFilesIntoProject(projectId, projectRoot, stagingRoot, files) {
  const movedFiles = [];
  const createdDirectories = [];

  try {
    for (const file of files) {
      const segments = file.path.split("/");
      let currentDirectory = projectRoot;

      for (const segment of segments.slice(0, -1)) {
        currentDirectory = path.join(currentDirectory, segment);
        try {
          await fs.mkdir(currentDirectory);
          createdDirectories.push(currentDirectory);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const existing = await fs.lstat(currentDirectory);
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw error;
        }
      }

      const destination = path.resolve(projectRoot, ...segments);
      if (!destination.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error("Invalid repository file path.");
      }

      const stagedFile = path.join(stagingRoot, ...segments);
      await fs.copyFile(stagedFile, destination, constants.COPYFILE_EXCL);
      movedFiles.push(destination);
    }
  } catch (error) {
    await Promise.all(movedFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    for (const directory of createdDirectories.reverse()) {
      await fs.rmdir(directory).catch(() => {});
    }
    throw error;
  }

  return movedFiles.length;
}

export async function importPublicGitHubRepository(projectId, repositoryUrl) {
  await getProject(projectId);
  const unlock = lockProject(projectId);
  let stagingRoot;

  try {
    stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hosting-panel-github-"));
    const projectRoot = path.resolve(config.projectRoot, projectId);

    if ((await listProjectFiles(projectId)).length > 0) {
      throw githubError("기존 파일을 덮어쓰지 않도록 비어 있는 프로젝트에만 가져올 수 있습니다.", 409);
    }

    const { owner, repository } = parseRepositoryUrl(repositoryUrl);
    const { repositoryInfo, branch, commitSha, files, totalBytes } = await getRepositoryFiles(owner, repository);
    if (!files.length) throw githubError("저장소에 가져올 파일이 없습니다.");

    const actualTotalBytes = await downloadRepositoryFiles(owner, repository, commitSha, files, stagingRoot);
    const importedCount = await moveFilesIntoProject(projectId, projectRoot, stagingRoot, files);

    return {
      repository: repositoryInfo.full_name || `${owner}/${repository}`,
      repositoryUrl: `https://github.com/${owner}/${repository}`,
      branch,
      commit: commitSha,
      fileCount: importedCount,
      sizeBytes: actualTotalBytes || totalBytes
    };
  } finally {
    unlock();
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function deployPublicGitHubCommit(projectId, repositoryUrl, commitSha) {
  await getProject(projectId);
  const { owner, repository } = parseRepositoryUrl(repositoryUrl);
  let stagingRoot;
  let replacementRoot;
  let backupRoot;

  try {
    stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hosting-panel-github-deploy-"));
    const { repositoryInfo, branch, commitSha: resolvedSha, files, totalBytes } =
      await getRepositoryFiles(owner, repository, commitSha);
    if (!files.length) throw githubError("저장소 커밋에 가져올 파일이 없습니다.");
    const actualTotalBytes = await downloadRepositoryFiles(owner, repository, resolvedSha, files, stagingRoot);

    const projectRoot = path.resolve(config.projectRoot, projectId);
    const projectStats = await fs.lstat(projectRoot);
    if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
      throw githubError("프로젝트 폴더가 올바르지 않습니다.", 409);
    }
    replacementRoot = path.join(config.projectRoot, `.deploy-${projectId}-${crypto.randomUUID()}`);
    backupRoot = path.join(config.projectRoot, `.backup-${projectId}-${crypto.randomUUID()}`);
    await fs.mkdir(replacementRoot, { recursive: true });

    for (const controlFile of ["project.json", ".env"]) {
      const source = path.join(projectRoot, controlFile);
      try {
        const stats = await fs.lstat(source);
        if (!stats.isFile() || stats.isSymbolicLink()) throw githubError(`프로젝트 ${controlFile} 파일이 올바르지 않습니다.`, 409);
        await fs.copyFile(source, path.join(replacementRoot, controlFile));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    await moveFilesIntoProject(projectId, replacementRoot, stagingRoot, files);
    await fs.rename(projectRoot, backupRoot);
    try {
      await fs.rename(replacementRoot, projectRoot);
    } catch (error) {
      await fs.rename(backupRoot, projectRoot).catch(() => {});
      throw error;
    }
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => {});

    return {
      repository: repositoryInfo.full_name || `${owner}/${repository}`,
      repositoryUrl: `https://github.com/${owner}/${repository}`,
      branch,
      commit: resolvedSha,
      fileCount: files.length,
      sizeBytes: actualTotalBytes || totalBytes
    };
  } finally {
    if (replacementRoot) await fs.rm(replacementRoot, { recursive: true, force: true });
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
