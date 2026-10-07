import { getProcess, runProjectCommand, stopProcessAndWait } from "../utils/processManager.js";
import { lockProject } from "../utils/projectOperationLock.js";
import {
  getProject,
  getProjectDirectory,
  startProject,
  updateProjectDeployment,
  updateProjectStatus
} from "./projectManager.js";
import { deployPublicGitHubCommit } from "./githubImporter.js";
import { readProjectEnvironment } from "./projectEnvironment.js";
import { appendProjectLog } from "./projectLogs.js";

export async function deployProjectCommit(projectId, commitSha) {
  const project = await getProject(projectId);
  if (!project.repositoryUrl) {
    const error = new Error("먼저 공개 GitHub 저장소를 연결하세요.");
    error.status = 409;
    throw error;
  }
  if (!project.startCommand) {
    const error = new Error("배포 전에 실행 커맨드를 설정해야 합니다.");
    error.status = 409;
    throw error;
  }

  const unlock = lockProject(projectId);
  let deploymentStarted = false;
  let filesDeployed = false;
  try {
    if (getProcess(projectId)) {
      const stopped = await stopProcessAndWait(projectId);
      if (!stopped) {
        const error = new Error("기존 프로세스를 종료하지 못했습니다.");
        error.status = 409;
        throw error;
      }
    }

    deploymentStarted = true;
    await updateProjectStatus(projectId, "deploying");
    await appendProjectLog(projectId, `커밋 ${commitSha.slice(0, 7)} 배포 시작`);
    const result = await deployPublicGitHubCommit(projectId, project.repositoryUrl, commitSha);
    filesDeployed = true;
    await updateProjectDeployment(projectId, result);
    const current = await getProject(projectId);
    const envEntries = await readProjectEnvironment(getProjectDirectory(projectId));
    const env = Object.fromEntries(envEntries.map(({ key, value }) => [key, value]));

    if (current.buildCommand.trim()) {
      const build = await runProjectCommand(projectId, current.buildCommand, getProjectDirectory(projectId), { env });
      if (build.code !== 0) {
        const error = new Error(`빌드에 실패했습니다 (종료 코드 ${build.code}). 로그를 확인하세요.`);
        error.status = 422;
        throw error;
      }
    } else {
      await appendProjectLog(projectId, "빌드 커맨드가 비어 있어 빌드를 건너뜁니다.");
    }

    const started = await startProject(projectId, { operationLockAlreadyHeld: true });
    await appendProjectLog(projectId, `커밋 ${result.commit.slice(0, 7)} 배포 완료`);
    return { ...result, status: started.status };
  } catch (error) {
    if (deploymentStarted) {
      await updateProjectStatus(projectId, filesDeployed ? "build_failed" : "deploy_failed").catch(() => {});
      await appendProjectLog(projectId, `배포 실패: ${error.message}`, "ERROR").catch(() => {});
    }
    throw error;
  } finally {
    unlock();
  }
}
