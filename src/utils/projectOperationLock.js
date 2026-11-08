const lockedProjects = new Set();

export function isProjectLocked(projectId) {
  return lockedProjects.has(projectId);
}

export function lockProject(projectId) {
  if (lockedProjects.has(projectId)) {
    const error = new Error("프로젝트 작업이 진행 중입니다. 완료된 뒤 다시 시도하세요.");
    error.status = 409;
    throw error;
  }

  lockedProjects.add(projectId);
  return () => lockedProjects.delete(projectId);
}
