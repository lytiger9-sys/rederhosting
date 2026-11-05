import { Router } from "express";
import { closeProjectTerminal, createProjectTerminal } from "../services/projectTerminal.js";

const router = Router({ mergeParams: true });

router.post("/", async (req, res) => {
  try {
    res.status(201).json(await createProjectTerminal(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "터미널을 열지 못했습니다." });
  }
});

router.delete("/:sessionId", (req, res) => {
  res.json({ closed: closeProjectTerminal(req.params.id, req.params.sessionId) });
});

export default router;
