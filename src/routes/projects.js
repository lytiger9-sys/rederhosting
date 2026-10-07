import { Router } from "express";
import filesRouter from "./files.js";
import githubRouter from "./github.js";
import environmentRouter from "./environment.js";
import logsRouter from "./logs.js";
import {
  createProject,
  listProjects,
  getProject,
  startProject,
  stopProject,
  deleteProject
} from "../services/projectManager.js";

const router = Router();

router.use("/:id/files", filesRouter);
router.use("/:id/github", githubRouter);
router.use("/:id/environment", environmentRouter);
router.use("/:id/logs", logsRouter);

router.get("/", async (_req, res) => {
  res.json(await listProjects());
});

router.post("/", async (req, res) => {
  try {
    res.status(201).json(await createProject(req.body));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    res.json(await getProject(req.params.id));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    res.json(await deleteProject(req.params.id));
  } catch (error) {
    const message = ["EBUSY", "EPERM"].includes(error.code)
      ? "프로젝트 폴더가 다른 프로그램(예: OneDrive)에서 사용 중입니다. 동기화가 끝난 뒤 다시 삭제하세요."
      : error.message;
    res.status(error.status || 400).json({ error: message });
  }
});

router.post("/:id/start", async (req, res) => {
  try {
    res.json(await startProject(req.params.id));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/:id/stop", async (req, res) => {
  try {
    res.json(await stopProject(req.params.id));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
