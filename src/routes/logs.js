import { Router } from "express";
import { getProject } from "../services/projectManager.js";
import { readProjectLogs } from "../services/projectLogs.js";

const router = Router({ mergeParams: true });

router.get("/", async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    const requestedLines = Number(req.query.lines || 500);
    const maxLines = Number.isInteger(requestedLines) ? Math.max(1, Math.min(2000, requestedLines)) : 500;
    const logs = await readProjectLogs(req.params.id, maxLines);
    res.set("Cache-Control", "no-store");
    res.json({ projectId: project.id, status: project.status, logs, lineCount: logs ? logs.split("\n").length : 0 });
  } catch (error) {
    res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message });
  }
});

export default router;
