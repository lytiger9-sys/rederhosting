import net from "node:net";

const reservedPorts = new Map();
const pendingProjects = new Set();

export async function reserveProjectPort(projectId) {
  if (reservedPorts.has(projectId) || pendingProjects.has(projectId)) {
    const error = new Error("프로젝트 포트 할당이 이미 진행 중입니다.");
    error.status = 409;
    throw error;
  }

  pendingProjects.add(projectId);
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const server = net.createServer();
      const port = await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve(server.address().port);
        });
      });
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      if ([...reservedPorts.values()].includes(port)) continue;
      reservedPorts.set(projectId, port);
      return port;
    }
    throw new Error("프로젝트 포트를 확보하지 못했습니다. 잠시 후 다시 시도하세요.");
  } finally {
    pendingProjects.delete(projectId);
  }
}

export function releaseProjectPort(projectId) {
  reservedPorts.delete(projectId);
}
