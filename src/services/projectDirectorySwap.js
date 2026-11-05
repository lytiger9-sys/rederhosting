import fs from "node:fs/promises";
import path from "node:path";

const RETRYABLE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"]);
const RENAME_ATTEMPTS = 7;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function renameWithRetries(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      if (!RETRYABLE_ERRORS.has(error.code) || attempt >= RENAME_ATTEMPTS - 1) throw error;
      await wait(250 * (attempt + 1));
    }
  }
}

export async function replaceProjectDirectory(projectRoot, replacementRoot, backupRoot) {
  await renameWithRetries(projectRoot, backupRoot);

  try {
    await renameWithRetries(replacementRoot, projectRoot);
  } catch (replaceError) {
    try {
      await renameWithRetries(backupRoot, projectRoot);
    } catch (restoreError) {
      const recoveryError = new Error(
        `새 파일을 적용하지 못했고 기존 프로젝트도 자동 복구하지 못했습니다. 기존 파일은 '${backupRoot}', 새 파일은 '${replacementRoot}'에 보존했습니다. 서버를 중지하고 해당 폴더를 확인하세요.`,
        { cause: replaceError }
      );
      recoveryError.code = replaceError.code;
      recoveryError.recoveryPending = true;
      recoveryError.restoreError = restoreError;
      throw recoveryError;
    }
    throw replaceError;
  }

  await fs.rm(backupRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300
  }).catch((error) => {
    console.warn(`배포 후 이전 프로젝트 백업을 정리하지 못했습니다 (${backupRoot}): ${error.message}`);
  });
}

export async function recoverProjectDirectoryBackups(projectRoot) {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^\.backup-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-/i.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;

    const backupPath = path.join(projectRoot, entry.name);
    const projectPath = path.join(projectRoot, match[1]);
    try {
      await fs.lstat(projectPath);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") continue;
    }

    try {
      await renameWithRetries(backupPath, projectPath);
      console.warn(`중단된 배포에서 기존 프로젝트를 복구했습니다: ${match[1]}`);
    } catch (error) {
      console.error(`프로젝트 백업을 자동 복구하지 못했습니다 (${backupPath}): ${error.message}`);
    }
  }
}
