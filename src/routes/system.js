import { Router } from "express";
import { getSystemStats } from "../services/resourceMonitor.js";

const router = Router();

router.get("/resources", (_req, res) => {
  res.json(getSystemStats());
});

export default router;
