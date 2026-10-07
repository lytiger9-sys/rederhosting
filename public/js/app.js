const $ = (selector) => document.querySelector(selector);

let activeProjectId = null;
let environmentProjectId = null;
let deploymentProjectId = null;
let deletionProjectId = null;
let logsProjectId = null;
let logsRefreshTimer = null;
let projectsById = new Map();

function formatBytes(bytes) {
  if (!bytes) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function readResponse(response) {
  let data = {};
  const fallbackResponse = response.clone();
  try {
    data = await response.json();
  } catch {
    if (!response.ok) {
      const body = await fallbackResponse.text().catch(() => "");
      const detail = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
      data.error = detail || `서버가 요청을 처리하지 못했습니다 (${response.status} ${response.statusText}).`;
    }
  }

  if (!response.ok) {
    throw new Error(data.error || "요청을 처리하지 못했습니다.");
  }
  return data;
}

async function loadSystem() {
  try {
    const response = await fetch("/api/system/resources");
    const data = await readResponse(response);

    $("#cpu").textContent = `${data.process?.cpuPercent ?? 0}%`;
    $("#memory").textContent =
      `${data.memory.usagePercent}% ` +
      `(${formatBytes(data.memory.usedBytes)} / ${formatBytes(data.memory.totalBytes)})`;
  } catch {
    $("#cpu").textContent = "오류";
    $("#memory").textContent = "오류";
  }
}

async function loadProjects() {
  const response = await fetch("/api/projects");
  const projects = await readResponse(response);
  const expandedIds = new Set(Array.from(document.querySelectorAll(".project-expanded:not([hidden])"), (details) =>
    details.closest(".project")?.querySelector('[data-action="details"]')?.dataset.projectId
  ).filter(Boolean));
  projectsById = new Map(projects.map((project) => [project.id, project]));
  $("#projectCount").textContent = projects.length;

  $("#projects").innerHTML = projects.map((project) => `
    <article class="project" data-project-id="${escapeHtml(project.id)}">
      <button type="button" class="project-info" data-action="details" data-project-id="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.name)} 상세 정보 보기" aria-expanded="${expandedIds.has(project.id)}">
        <span class="project-chevron" aria-hidden="true">▸</span>
        <span class="project-info-text">
        <strong>${escapeHtml(project.name)}</strong>
        <small>
          ${escapeHtml(project.status)}
          ${project.pid ? ` · 프로세스 번호 ${project.pid}` : ""}
        </small>
        </span>
      </button>

      <div class="project-actions">
        <button type="button" data-action="files" data-project-id="${escapeHtml(project.id)}">소스 파일</button>
        <button type="button" data-action="deploy" data-project-id="${escapeHtml(project.id)}">배포하기</button>
        <button type="button" data-action="logs" data-project-id="${escapeHtml(project.id)}">로그 보기</button>
        <button type="button" data-action="start" data-project-id="${escapeHtml(project.id)}">실행</button>
        <button type="button" data-action="stop" data-project-id="${escapeHtml(project.id)}">중지</button>
        <button type="button" class="danger-button" data-action="delete" data-project-id="${escapeHtml(project.id)}">삭제</button>
      </div>

      <div class="project-expanded" hidden>
        <div><span>GitHub</span><strong>${escapeHtml(project.repositoryUrl || "저장소 연결 안 됨")}</strong></div>
        <div><span>배포 커밋</span><strong>${escapeHtml(project.deployedCommit ? project.deployedCommit.slice(0, 7) : "배포 전")}</strong></div>
        <div><span>빌드 커맨드</span><strong>${escapeHtml(project.buildCommand || "설정되지 않음")}</strong></div>
        <div><span>실행 커맨드</span><strong>${escapeHtml(project.startCommand || "설정되지 않음")}</strong></div>
        <button type="button" data-action="environment" data-project-id="${escapeHtml(project.id)}">.env 보기</button>
      </div>
    </article>
  `).join("");

  for (const projectId of expandedIds) {
    const article = Array.from(document.querySelectorAll(".project")).find((item) => item.dataset.projectId === projectId);
    if (!article) continue;
    article.querySelector(".project-expanded").hidden = false;
    article.querySelector(".project-chevron").textContent = "▾";
  }
}

async function controlProject(id, action) {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/${action}`, {
      method: "POST"
    });
    await readResponse(response);
    await refresh();
  } catch (error) {
    alert(error.message);
  }
}

$("#projects").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const { action, projectId } = button.dataset;
  if (action === "files") {
    await openFileManager(projectId);
  } else if (action === "environment") {
    await openEnvironmentModal(projectId);
  } else if (action === "details") {
    toggleProjectDetails(button);
  } else if (action === "deploy") {
    await openDeploymentModal(projectId);
  } else if (action === "logs") {
    await openLogsModal(projectId);
  } else if (action === "delete") {
    openDeleteProjectModal(projectId);
  } else {
    await controlProject(projectId, action);
  }
});

function toggleProjectDetails(button) {
  const article = button.closest(".project");
  const details = article?.querySelector(".project-expanded");
  if (!details) return;
  details.hidden = !details.hidden;
  button.querySelector(".project-chevron").textContent = details.hidden ? "▸" : "▾";
    button.setAttribute("aria-expanded", String(!details.hidden));
}

$("#projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("#projectName").value,
        buildCommand: $("#buildCommand").value,
        startCommand: $("#startCommand").value
      })
    });

    const created = await readResponse(response);
    if (created.discordSync?.configured && !created.discordSync.ok) {
      alert(`프로젝트는 생성했지만 Discord 전송에 실패했습니다: ${created.discordSync.error || "연결 설정을 확인하세요."}`);
    } else if (created.discordSync && !created.discordSync.configured) {
      alert("프로젝트는 생성했습니다. Discord 동기화를 사용하려면 패널 루트 .env에 봇 토큰과 채널 ID를 설정하세요.");
    }
    event.target.reset();
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

function projectUrl(projectId, suffix = "") {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

function projectFilesUrl(suffix = "") {
  return projectUrl(activeProjectId, `/files${suffix}`);
}

async function openDeploymentModal(projectId) {
  const project = projectsById.get(projectId);
  if (!project) return;
  if (!project.repositoryUrl) {
    alert("먼저 소스 파일에서 공개 GitHub 저장소를 연결하세요.");
    await openFileManager(projectId);
    return;
  }

  deploymentProjectId = projectId;
  $("#deploymentTitle").textContent = `${project.name} 커밋 선택`;
  $("#deploymentMessage").textContent = "커밋 기록을 불러오는 중...";
  $("#deploymentMessage").classList.remove("error");
  $("#commitList").replaceChildren();
  $("#deploymentModal").showModal();
  try {
    const result = await readResponse(await fetch(projectUrl(projectId, "/github/commits")));
    $("#deploymentMessage").textContent = `${result.repository} · ${result.branch} 브랜치의 최근 커밋`;
    for (const commit of result.commits) renderCommit(commit);
    if (!result.commits.length) $("#commitList").textContent = "표시할 커밋이 없습니다.";
  } catch (error) {
    $("#deploymentMessage").textContent = error.message;
    $("#deploymentMessage").classList.add("error");
  }
}

function renderCommit(commit) {
  const row = document.createElement("article");
  row.className = "commit-row";
  const details = document.createElement("div");
  details.className = "commit-details";
  const message = document.createElement("strong");
  message.textContent = commit.message || "(커밋 메시지 없음)";
  const meta = document.createElement("small");
  const current = projectsById.get(deploymentProjectId)?.deployedCommit === commit.sha;
  meta.textContent = `${commit.sha.slice(0, 7)}${current ? " · 현재 배포" : ""} · ${commit.author} · ${commit.date ? new Date(commit.date).toLocaleString() : "날짜 없음"}`;
  details.append(message, meta);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = current ? "이 커밋 재배포" : "이 커밋 배포";
  button.addEventListener("click", () => deployCommit(commit, button));
  row.append(details, button);
  $("#commitList").append(row);
}

async function deployCommit(commit, button) {
  if (!deploymentProjectId) return;
  for (const item of $("#commitList").querySelectorAll("button")) item.disabled = true;
  $("#deploymentMessage").classList.remove("error");
  $("#deploymentMessage").textContent = `${commit.sha.slice(0, 7)} 커밋을 받아 빌드하고 실행하는 중...`;
  button.textContent = "배포 중...";
  try {
    const result = await readResponse(await fetch(projectUrl(deploymentProjectId, "/github/deploy"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commit: commit.sha })
    }));
    $("#deploymentMessage").textContent = `${result.commit.slice(0, 7)} 배포 완료 · ${result.fileCount}개 파일 · 빌드 후 실행 중`;
    await refresh();
    for (const item of $("#commitList").querySelectorAll("button")) item.disabled = false;
    button.textContent = "이 커밋 재배포";
  } catch (error) {
    $("#deploymentMessage").textContent = error.message;
    $("#deploymentMessage").classList.add("error");
    for (const item of $("#commitList").querySelectorAll("button")) item.disabled = false;
    button.textContent = "이 커밋 배포";
  }
}

async function openLogsModal(projectId) {
  const project = projectsById.get(projectId);
  if (!project) return;
  logsProjectId = projectId;
  $("#logsTitle").textContent = `${project.name} 로그`;
  $("#logsOutput").textContent = "로그를 불러오는 중...";
  $("#logsModal").showModal();
  await refreshProjectLogs();
  clearInterval(logsRefreshTimer);
  logsRefreshTimer = setInterval(() => refreshProjectLogs(), 2000);
}

async function refreshProjectLogs() {
  if (!logsProjectId) return;
  try {
    const result = await readResponse(await fetch(projectUrl(logsProjectId, "/logs?lines=1000"), {
      cache: "no-store"
    }));
    $("#logsOutput").textContent = result.logs || "아직 기록된 로그가 없습니다.";
    const status = result.status || "상태 정보 없음";
    const lineCount = Number.isFinite(result.lineCount)
      ? result.lineCount
      : (result.logs ? result.logs.split("\n").length : 0);
    $("#logsStatus").textContent = `${status} · 최근 로그 ${lineCount}줄`;
    $("#logsOutput").scrollTop = $("#logsOutput").scrollHeight;
  } catch (error) {
    $("#logsOutput").textContent = error.message;
  }
}

function closeLogsModal() {
  clearInterval(logsRefreshTimer);
  logsRefreshTimer = null;
  logsProjectId = null;
  $("#logsModal").close();
}

$("#logsModal").addEventListener("close", () => {
  clearInterval(logsRefreshTimer);
  logsRefreshTimer = null;
  logsProjectId = null;
});

$("#closeLogsButton").addEventListener("click", closeLogsModal);
$("#refreshLogsButton").addEventListener("click", refreshProjectLogs);

function openDeleteProjectModal(projectId) {
  const project = projectsById.get(projectId);
  if (!project) return;
  deletionProjectId = projectId;
  $("#deleteProjectDescription").textContent = `${project.name} 프로젝트와 저장된 소스 파일, 설정을 삭제합니다. 실행 중이면 먼저 프로세스를 종료합니다. 이 작업은 되돌릴 수 없습니다.`;
  $("#deleteProjectMessage").textContent = "";
  $("#deleteProjectMessage").classList.remove("error");
  $("#deleteProjectModal").showModal();
}

async function confirmDeleteProject() {
  if (!deletionProjectId) return;
  const button = $("#confirmDeleteProjectButton");
  button.disabled = true;
  $("#deleteProjectMessage").textContent = "프로젝트 삭제 중...";
  $("#deleteProjectMessage").classList.remove("error");
  try {
    await readResponse(await fetch(projectUrl(deletionProjectId), { method: "DELETE" }));
    if (activeProjectId === deletionProjectId) {
      $("#fileManager").hidden = true;
      activeProjectId = null;
    }
    if (logsProjectId === deletionProjectId) closeLogsModal();
    $("#deleteProjectModal").close();
    deletionProjectId = null;
    await refresh();
  } catch (error) {
    $("#deleteProjectMessage").textContent = error.message;
    $("#deleteProjectMessage").classList.add("error");
  } finally {
    button.disabled = false;
  }
}

$("#closeDeleteProjectButton").addEventListener("click", () => $("#deleteProjectModal").close());
$("#cancelDeleteProjectButton").addEventListener("click", () => $("#deleteProjectModal").close());
$("#confirmDeleteProjectButton").addEventListener("click", confirmDeleteProject);
$("#closeDeploymentButton").addEventListener("click", () => $("#deploymentModal").close());

async function openEnvironmentModal(projectId) {
  const project = projectsById.get(projectId);
  if (!project) return;
  environmentProjectId = projectId;
  $("#environmentTitle").textContent = `${project.name} 환경변수`;
  $("#environmentMessage").textContent = "불러오는 중...";
  $("#environmentMessage").classList.remove("error");
  $("#environmentRows").replaceChildren();
  $("#environmentModal").showModal();
  try {
    const result = await readResponse(await fetch(projectUrl(projectId, "/environment")));
    const variables = Array.isArray(result) ? result : result?.variables;
    if (!Array.isArray(variables)) {
      throw new Error("환경변수 API 응답 형식이 올바르지 않습니다. 서버를 재시작하고 페이지를 새로고침하세요.");
    }
    for (const variable of variables) addEnvironmentRow(variable.key, variable.value);
    if (!variables.length) addEnvironmentRow();
    $("#environmentMessage").textContent = "";
  } catch (error) {
    $("#environmentMessage").textContent = error.message;
    $("#environmentMessage").classList.add("error");
  }
}

function addEnvironmentRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "environment-row";
  const keyInput = document.createElement("input");
  keyInput.className = "environment-key";
  keyInput.placeholder = "예: API_TOKEN";
  keyInput.autocomplete = "off";
  keyInput.value = key;
  keyInput.setAttribute("aria-label", "환경변수 이름");
  const valueInput = document.createElement("input");
  valueInput.className = "environment-value";
  valueInput.type = "password";
  valueInput.placeholder = "값";
  valueInput.autocomplete = "new-password";
  valueInput.value = value;
  valueInput.setAttribute("aria-label", "환경변수 값");
  const actions = document.createElement("div");
  actions.className = "environment-row-actions";
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.textContent = "보기";
  reveal.addEventListener("click", () => {
    valueInput.type = valueInput.type === "password" ? "text" : "password";
    reveal.textContent = valueInput.type === "password" ? "보기" : "숨기기";
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "삭제";
  remove.addEventListener("click", () => row.remove());
  actions.append(reveal, remove);
  row.append(keyInput, valueInput, actions);
  $("#environmentRows").append(row);
}

$("#addEnvironmentButton").addEventListener("click", () => addEnvironmentRow());
$("#closeEnvironmentButton").addEventListener("click", () => $("#environmentModal").close());
$("#cancelEnvironmentButton").addEventListener("click", () => $("#environmentModal").close());
$("#environmentModal").addEventListener("close", () => {
  $("#environmentRows").replaceChildren();
  environmentProjectId = null;
});
$("#environmentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!environmentProjectId) return;
  const button = $("#saveEnvironmentButton");
  const variables = Array.from($("#environmentRows").querySelectorAll(".environment-row"), (row) => ({
    key: row.querySelector(".environment-key").value,
    value: row.querySelector(".environment-value").value
  }));
  button.disabled = true;
  const message = $("#environmentMessage");
  message.classList.remove("error");
  message.textContent = "저장 중...";
  try {
    const result = await readResponse(await fetch(projectUrl(environmentProjectId, "/environment"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables })
    }));
    message.textContent = result.discordSync?.configured && !result.discordSync.ok
      ? `로컬에는 저장했지만 Discord 전송에 실패했습니다: ${result.discordSync.error || "연결 설정을 확인하세요."}`
      : !result.discordSync?.configured
        ? "로컬에 저장했습니다. Discord 동기화는 패널 루트 .env에 봇 토큰과 채널 ID를 설정하면 활성화됩니다."
        : "저장했습니다. 실행 중인 프로젝트에는 중지 후 다시 실행해야 적용됩니다.";
    message.classList.toggle("error", Boolean(result.discordSync?.configured && !result.discordSync.ok));
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  } finally {
    button.disabled = false;
  }
});

async function openFileManager(projectId) {
  const project = projectsById.get(projectId);
  if (!project) return;

  activeProjectId = projectId;
  $("#fileManagerTitle").textContent = `${project.name} 파일 관리`;
  $("#githubImportPanel").hidden = Boolean(project.repositoryUrl);
  $("#githubRepositoryConnected").hidden = !project.repositoryUrl;
  $("#githubRepositoryConnected").textContent = project.repositoryUrl
    ? `연결된 저장소: ${project.repositoryUrl} · 파일은 커밋 배포로 업데이트됩니다.`
    : "";
  $("#fileManager").hidden = false;
  $("#fileMessage").textContent = "";
  await loadProjectFiles();
  $("#fileManager").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadProjectFiles() {
  if (!activeProjectId) return;

  try {
    const files = await readResponse(await fetch(projectFilesUrl()));
    renderFileTree(files);
  } catch (error) {
    $("#fileTree").textContent = "파일 목록을 불러오지 못했습니다.";
    showFileMessage(error.message, true);
  }
}

function renderFileTree(files) {
  const tree = $("#fileTree");
  tree.replaceChildren();

  if (!files.length) {
    tree.textContent = "아직 프로젝트 파일이 없습니다.";
    return;
  }

  for (const file of files) {
    const depth = file.path.split("/").length - 1;
    const row = document.createElement("div");
    row.className = `file-row ${file.type === "directory" ? "directory-row" : ""}`;

    const name = document.createElement("span");
    name.className = "file-name";
    name.style.paddingInlineStart = `${depth * 18}px`;
    name.textContent = `${file.type === "directory" ? "📁" : "📄"} ${file.path.split("/").at(-1)}`;
    name.title = file.path;

    const size = document.createElement("span");
    size.className = "file-meta";
    size.textContent = file.type === "directory" ? "폴더" : formatBytes(file.size);

    const modified = document.createElement("span");
    modified.className = "file-meta";
    modified.textContent = new Date(file.modifiedAt).toLocaleString();

    const actions = document.createElement("div");
    actions.className = "file-actions";

    if (file.type === "file") {
      const download = document.createElement("a");
      download.href = projectFilesUrl(`/download?path=${encodeURIComponent(file.path)}`);
      download.textContent = "다운로드";
      actions.append(download);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "삭제";
      remove.addEventListener("click", () => deleteFile(file.path));
      actions.append(remove);
    }

    row.append(name, size, modified, actions);
    tree.append(row);
  }
}

async function deleteFile(filePath) {
  if (!confirm(`'${filePath}' 파일을 삭제할까요?`)) return;

  try {
    const query = new URLSearchParams({ path: filePath });
    await readResponse(await fetch(projectFilesUrl(`?${query}`), { method: "DELETE" }));
    showFileMessage("파일을 삭제했습니다.");
    await loadProjectFiles();
  } catch (error) {
    showFileMessage(error.message, true);
  }
}

async function importGitHubRepository() {
  const repositoryUrl = $("#githubRepositoryUrl").value.trim();
  if (!repositoryUrl) {
    showFileMessage("GitHub 저장소 주소를 입력하세요.", true);
    return;
  }

  const button = $("#importGitHubButton");
  button.disabled = true;
  try {
    showFileMessage("GitHub 저장소를 확인하고 파일을 가져오는 중입니다.");
    const response = await fetch(projectUrl(activeProjectId, "/github/import"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl })
    });
    const result = await readResponse(response);
    $("#githubRepositoryUrl").value = "";
    await loadProjects();
    await openFileManager(activeProjectId);
    showFileMessage(result.discordSync?.configured && !result.discordSync.ok
      ? `${result.repository} 파일은 가져왔지만 Discord 알림 전송에 실패했습니다.`
      : `${result.repository} (${result.branch})에서 ${result.fileCount}개 파일을 가져왔습니다. 배포하기에서 커밋을 선택해 실행하세요.`,
    Boolean(result.discordSync?.configured && !result.discordSync.ok));
  } catch (error) {
    showFileMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function showFileMessage(message, isError = false) {
  const element = $("#fileMessage");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

$("#importGitHubButton").addEventListener("click", importGitHubRepository);

$("#closeFileManagerButton").addEventListener("click", () => {
  $("#fileManager").hidden = true;
  activeProjectId = null;
});

$("#refreshButton").addEventListener("click", refresh);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refresh() {
  try {
    await Promise.all([loadSystem(), loadProjects()]);
    if (activeProjectId) await loadProjectFiles();
  } catch (error) {
    alert(error.message);
  }
}

refresh();
setInterval(loadSystem, 2000);
setInterval(() => loadProjects().catch(() => {}), 5000);
