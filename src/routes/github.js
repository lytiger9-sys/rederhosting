import { Router } from "express";
import {
  importPublicGitHubRepository,
  listPublicGitHubCommits
} from "../services/githubImporter.js";
import { getProject, setProjectRepository } from "../services/projectManager.js";
import { deployProjectCommit } from "../services/deploymentManager.js";

const router = Router({ mergeParams: true });

router.post("/import", async (req, res) => {
  try {
    const result = await importPublicGitHubRepository(req.params.id, req.body.repositoryUrl);
    const project = await setProjectRepository(req.params.id, result);
    result.discordSync = project.discordSync;
    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "GitHub 저장소를 가져오지 못했습니다." });
  }
});

router.get("/commits", async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project.repositoryUrl) {
      return res.status(409).json({ error: "먼저 GitHub 저장소를 연결하세요." });
    }
    res.set("Cache-Control", "no-store");
    res.json(await listPublicGitHubCommits(project.repositoryUrl));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.post("/deploy", async (req, res) => {
  try {
    res.json(await deployProjectCommit(req.params.id, String(req.body?.commit || "")));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

export default router;
