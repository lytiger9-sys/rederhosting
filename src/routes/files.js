import { Router } from "express";
import {
  deleteProjectFile,
  getProjectFile,
  listProjectFiles
} from "../services/fileManager.js";
import { isProjectLocked } from "../utils/projectOperationLock.js";

const router = Router({ mergeParams: true });

router.use((req, res, next) => {
  if (isProjectLocked(req.params.id)) {
    return res.status(409).json({ error: "A project operation is in progress. Try again shortly." });
  }
  next();
});

function sendError(res, error) {
  const status = error.status || (error.code === "ENOENT" ? 404 : 400);
  res.status(status).json({ error: error.message || "File operation failed." });
}

router.get("/", async (req, res) => {
  try {
    res.json(await listProjectFiles(req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/", (_req, res) => {
  res.status(405).json({ error: "프로젝트 파일은 GitHub 저장소를 통해서만 추가할 수 있습니다." });
});

router.post("/folders", (_req, res) => {
  res.status(405).json({ error: "폴더는 GitHub 저장소를 통해서만 추가할 수 있습니다." });
});

router.get("/download", async (req, res) => {
  try {
    const file = await getProjectFile(req.params.id, req.query.path);
    res.download(file.path, file.name, (error) => {
      if (error && !res.headersSent) sendError(res, error);
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/", async (req, res) => {
  try {
    const deletedPath = await deleteProjectFile(req.params.id, req.query.path);
    res.json({ path: deletedPath });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
