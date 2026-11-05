import { Router } from "express";
import { authenticateLogin, clearLoginSession, loginStatus } from "../services/authentication.js";

const router = Router();

router.get("/status", loginStatus);

router.post("/login", (request, response) => {
  authenticateLogin(request, response);
});

router.post("/logout", (request, response) => {
  clearLoginSession(request, response);
});

export default router;
