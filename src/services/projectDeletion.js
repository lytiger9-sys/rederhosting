import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const RETRYABLE_FILESYSTEM_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeWithRetries(target) {
  await fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300
  });
}

export async function removeProjectDirectory(projectRoot, projectDirectory, projectId) {
  const tombstone = path.join(projectRoot, `.deleted-${projectId}-${crypto.randomUUID()}`);
  let moved = false;
  let lastError;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(projectDirectory, tombstone);
      moved = true;
      break;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_FILESYSTEM_ERRORS.has(error.code) || attempt === 4) throw error;
      await wait(300 * (attempt + 1));
    }
  }

  if (!moved) throw lastError;
  await removeWithRetries(tombstone).catch((error) => {
    console.warn(`삭제 대기 폴더를 나중에 정리합니다 (${path.basename(tombstone)}): ${error.message}`);
  });
}

export async function cleanupPendingProjectDeletions(projectRoot) {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(".deleted-")) continue;
    await removeWithRetries(path.join(projectRoot, entry.name)).catch((error) => {
      console.warn(`삭제 대기 폴더를 정리하지 못했습니다 (${entry.name}): ${error.message}`);
    });
  }
}
