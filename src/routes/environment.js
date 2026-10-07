import { Router } from "express";
import { getProject, getProjectDirectory, updateProjectEnvironment } from "../services/projectManager.js";
import { readProjectEnvironment } from "../services/projectEnvironment.js";
import { isProjectLocked } from "../utils/projectOperationLock.js";

const router = Router({ mergeParams: true });

router.use(async (req, res, next) => {
  try {
    await getProject(req.params.id);
    if (isProjectLocked(req.params.id)) {
      return res.status(409).json({ error: "프로젝트 작업이 진행 중입니다." });
    }
    next();
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ variables: await readProjectEnvironment(getProjectDirectory(req.params.id)) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put("/", async (req, res) => {
  try {
    const result = await updateProjectEnvironment(req.params.id, req.body?.variables);
    res.set("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

export default router;
