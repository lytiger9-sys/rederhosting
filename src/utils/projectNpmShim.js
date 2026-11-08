import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function findNpmExecutable() {
  const executableNames = process.platform === "win32" ? ["npm.cmd"] : ["npm"];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    for (const name of executableNames) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function quoteWindows(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createProjectNpmShim(projectDirectory) {
  const npmExecutable = findNpmExecutable();
  if (!npmExecutable) return null;

  const projectRoot = path.resolve(projectDirectory);
  const id = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 20);
  const shimDirectory = path.join(os.tmpdir(), "hosting-panel-npm-shims", id);
  fs.mkdirSync(shimDirectory, { recursive: true });

  if (process.platform === "win32") {
    const shimPath = path.join(shimDirectory, "npm.cmd");
    const contents = [
      "@echo off",
      `call ${quoteWindows(npmExecutable)} --prefix ${quoteWindows(projectRoot)} %*`,
      "exit /b %errorlevel%",
      ""
    ].join("\r\n");
    if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== contents) {
      fs.writeFileSync(shimPath, contents, "utf8");
    }
  } else {
    const shimPath = path.join(shimDirectory, "npm");
    const contents = `#!/bin/sh\nexec ${quoteShell(npmExecutable)} --prefix ${quoteShell(projectRoot)} "$@"\n`;
    if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== contents) {
      fs.writeFileSync(shimPath, contents, { encoding: "utf8", mode: 0o755 });
      fs.chmodSync(shimPath, 0o755);
    }
  }

  return shimDirectory;
}
