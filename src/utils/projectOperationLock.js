const lockedProjects = new Set();

export function isProjectLocked(projectId) {
  return lockedProjects.has(projectId);
}

export function lockProject(projectId) {
  if (lockedProjects.has(projectId)) {
    const error = new Error("A project operation is already in progress.");
    error.status = 409;
    throw error;
  }

  lockedProjects.add(projectId);
  return () => lockedProjects.delete(projectId);
}
