import { Router } from "express";
import { getProject } from "../services/projectManager.js";
import { readProjectDeploymentHistory, readProjectLogs, readProjectLogsInRange } from "../services/projectLogs.js";

const router = Router({ mergeParams: true });

router.get("/", async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (req.query.deployments === "1") {
      const deployments = await readProjectDeploymentHistory(req.params.id);
      res.set("Cache-Control", "no-store");
      return res.json({ projectId: project.id, deployments });
    }
    const requestedLines = Number(req.query.lines || 500);
    const maxLines = Number.isInteger(requestedLines) ? Math.max(1, Math.min(2000, requestedLines)) : 500;
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    if (req.query.from && !Number.isFinite(from.getTime())) {
      return res.status(400).json({ error: "로그 시작 시간이 올바르지 않습니다." });
    }
    const logs = req.query.all === "1" || from
      ? await readProjectLogsInRange(req.params.id, from, new Date())
      : await readProjectLogs(req.params.id, maxLines);
    res.set("Cache-Control", "no-store");
    res.json({ projectId: project.id, status: project.status, logs, lineCount: logs ? logs.split("\n").length : 0 });
  } catch (error) {
    res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message });
  }
});

export default router;
