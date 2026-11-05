const $ = (selector) => document.querySelector(selector);

let activeProjectId = null;
let environmentProjectId = null;
let deploymentProjectId = null;
let deletionProjectId = null;
let logsProjectId = null;
let logsRefreshTimer = null;
let projectDetailId = null;
let projectDetailTab = "overview";
let dashboardPage = "stats";
let detailLogsRefreshTimer = null;
let projectDetailLogsInitialLoad = false;
let projectsById = new Map();
const operationFeedback = new Map();

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

function projectStatusLabel(status) {
  const labels = {
    stopped: "중지됨",
    starting: "시작 중",
    running: "실행 중",
    stopping: "중지 중",
    completed: "명령 종료",
    start_failed: "실행 오류",
    crashed: "비정상 종료",
    stop_failed: "중지 오류",
    deploying: "배포 중",
    build_failed: "빌드 실패",
    deploy_failed: "배포 실패"
  };
  return labels[status] || status || "상태 확인 중";
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
    if (response.status === 401) window.location.replace("/login.html");
    throw new Error(data.error || "요청을 처리하지 못했습니다.");
  }
  return data;
}

$("#logoutButton").addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.replace("/login.html");
  }
});

async function loadSystem() {
  try {
    const response = await fetch("/api/system/resources");
    const data = await readResponse(response);

    $("#cpu").textContent = `${data.cpu?.usagePercent ?? 0}%`;
    $("#memory").textContent =
      `${data.memory.usagePercent}% ` +
      `(${formatBytes(data.memory.usedBytes)} / ${formatBytes(data.memory.totalBytes)})`;
    $("#publicIp").textContent = data.publicIp || "확인 불가";
    window.updateResourceChart?.(data);
  } catch {
    $("#cpu").textContent = "오류";
    $("#memory").textContent = "오류";
    $("#publicIp").textContent = "확인 불가";
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
    ${renderProjectCard(project, expandedIds.has(project.id))}
  `).join("");

  for (const projectId of expandedIds) {
    const article = Array.from(document.querySelectorAll(".project")).find((item) => item.dataset.projectId === projectId);
    if (!article) continue;
    article.querySelector(".project-expanded").hidden = false;
    article.querySelector(".project-chevron").textContent = "▾";
  }
}

function renderProjectCard(project, expanded = false) {
  const operation = operationFeedback.get(project.id);
  const message = operation?.pending ? operation.message : (operation?.message || project.operationMessage || "");
  const statusIsError = ["start_failed", "crashed", "stop_failed"].includes(project.status);
  const feedbackTone = operation?.tone || (statusIsError ? "error" : "");
  const busy = Boolean(operation?.pending);
  const canStop = ["running", "starting", "stopping", "stop_failed"].includes(project.status);
  const startLabel = project.status === "running" ? "실행 중" :
    project.status === "starting" ? "시작 중..." :
      ["start_failed", "crashed"].includes(project.status) ? "다시 실행" : "실행";

  return `
    <article class="project" data-project-id="${escapeHtml(project.id)}">
      <div class="project-heading">
      <button type="button" class="project-toggle" data-action="details" data-project-id="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.name)} 간단 정보 펼치기" aria-expanded="${expanded}">
        <span class="project-chevron" aria-hidden="true">▸</span>
      </button>
      <button type="button" class="project-info" data-action="project-detail" data-project-id="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.name)} 상세 페이지 열기">
        <span class="project-info-text">
        <strong>${escapeHtml(project.name)}</strong>
        <small>
          ${escapeHtml(projectStatusLabel(project.status))}
          ${project.pid ? ` · 프로세스 번호 ${project.pid}` : ""}
        </small>
        </span>
      </button>
      </div>

      <div class="project-actions">
        <button type="button" data-action="files" data-project-id="${escapeHtml(project.id)}" ${busy ? "disabled" : ""}>소스 파일</button>
        <button type="button" data-action="deploy" data-project-id="${escapeHtml(project.id)}" ${busy ? "disabled" : ""}>배포하기</button>
        <button type="button" data-action="logs" data-project-id="${escapeHtml(project.id)}" ${busy ? "disabled" : ""}>로그 보기</button>
        <button type="button" data-action="terminal" data-project-id="${escapeHtml(project.id)}" ${busy ? "disabled" : ""}>터미널</button>
        <button type="button" data-action="start" data-project-id="${escapeHtml(project.id)}" ${busy || ["running", "starting"].includes(project.status) ? "disabled" : ""}>${startLabel}</button>
        <button type="button" data-action="stop" data-project-id="${escapeHtml(project.id)}" ${busy || !canStop ? "disabled" : ""}>${project.status === "stopping" ? "중지 중..." : "중지"}</button>
        <button type="button" class="danger-button" data-action="delete" data-project-id="${escapeHtml(project.id)}" ${busy ? "disabled" : ""}>삭제</button>
      </div>

      <p class="project-feedback ${feedbackTone}" role="status" aria-live="polite" ${message ? "" : "hidden"}>${escapeHtml(message)}</p>

      <div class="project-expanded" hidden>
        <div><span>프로젝트 접속 주소</span>${project.slug
          ? `<a href="${escapeHtml(`${window.location.origin}/${project.slug}/`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(`${window.location.host}/${project.slug}/`)}</a>`
          : "<strong>영문 이름으로 프로젝트를 다시 만들어야 합니다.</strong>"}</div>
        <div><span>실행 포트</span><strong>${project.port ? escapeHtml(project.port) : "실행 시 자동 할당"}</strong></div>
        <div><span>GitHub</span><strong>${escapeHtml(project.repositoryUrl || "저장소 연결 안 됨")}</strong></div>
        <div><span>배포 커밋</span><strong>${escapeHtml(project.deployedCommit ? project.deployedCommit.slice(0, 7) : "배포 전")}</strong></div>
        <div><span>빌드 커맨드</span><strong>${escapeHtml(project.buildCommand || "설정되지 않음")}</strong></div>
        <div><span>실행 커맨드</span><strong>${escapeHtml(project.startCommand || "설정되지 않음")}</strong></div>
      </div>
    </article>
  `;
}

function setOperationFeedback(projectId, message, tone = "", pending = false) {
  operationFeedback.set(projectId, { message, tone, pending });
  const article = document.querySelector(`.project[data-project-id="${CSS.escape(projectId)}"]`);
  const feedback = article?.querySelector(".project-feedback");
  if (feedback) {
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.classList.toggle("error", tone === "error");
    feedback.classList.toggle("pending", tone === "pending");
  }
  article?.querySelectorAll(".project-actions button").forEach((button) => {
    if (pending) button.disabled = true;
  });
}

async function controlProject(id, action) {
  const actionLabel = action === "start" ? "실행" : "중지";
  setOperationFeedback(id, `${actionLabel} 요청을 처리하고 있습니다...`, "pending", true);
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/${action}`, {
      method: "POST"
    });
    await readResponse(response);
    operationFeedback.delete(id);
    await refresh();
    await openLogsModal(id);
  } catch (error) {
    setOperationFeedback(id, error.message, "error");
    await refresh();
    await openLogsModal(id);
  }
}

$("#projects").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const { action, projectId } = button.dataset;
  if (action === "project-detail") {
    showProjectDetail(projectId);
  } else if (action === "files") {
    await openProjectRepository(projectId);
  } else if (action === "details") {
    toggleProjectDetails(button);
  } else if (action === "deploy") {
    await openDeploymentModal(projectId);
  } else if (action === "logs") {
    await openLogsModal(projectId);
  } else if (action === "terminal") {
    await window.openProjectTerminal(projectId, projectsById.get(projectId)?.name || "프로젝트");
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

$("#sidebarNav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (button) showDashboardPage(button.dataset.page);
});

function showDashboardPage(page) {
  stopProjectDetailLogRefresh();
  window.closeProjectTerminalInline?.();
  dashboardPage = page === "projects" ? "projects" : "stats";
  projectDetailId = null;
  activeProjectId = null;
  $("#fileManager").hidden = true;
  $("#projectDetailPage").hidden = true;
  $("#statsSection").hidden = dashboardPage !== "stats";
  $("#resourceChartPanel").hidden = dashboardPage !== "stats";
  $("#projectsSection").hidden = dashboardPage !== "projects";
  $("#pageHeading").hidden = false;
  $("#pageHeading .eyebrow").textContent = dashboardPage === "stats" ? "SERVER / OVERVIEW" : "SERVER / PROJECTS";
  $("#pageHeading h1").textContent = dashboardPage === "stats" ? "서버 스탯" : "프로젝트";
  $("#pageHeading .muted").textContent = dashboardPage === "stats"
    ? "호스팅 서버의 리소스 현황입니다."
    : "호스팅 프로젝트를 관리합니다.";
  $("#breadcrumbPage").textContent = dashboardPage === "stats" ? "서버 스탯" : "프로젝트";
  $("#sidebarNav").querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === dashboardPage);
  });
}

function showProjectDetail(projectId) {
  stopProjectDetailLogRefresh();
  if (!projectsById.has(projectId)) return;
  activeProjectId = null;
  $("#fileManager").hidden = true;
  projectDetailId = projectId;
  projectDetailTab = "overview";
  $("#statsSection").hidden = true;
  $("#resourceChartPanel").hidden = true;
  $("#projectsSection").hidden = true;
  $("#pageHeading").hidden = true;
  $("#projectDetailPage").hidden = false;
  $("#projectDetailNav").querySelectorAll("[data-detail-tab]").forEach((item) => {
    item.classList.toggle("active", item.dataset.detailTab === projectDetailTab);
  });
  $("#sidebarNav").querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  renderProjectDetail();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderProjectDetail() {
  const project = projectsById.get(projectDetailId);
  if (!project) {
    showDashboardPage("projects");
    return;
  }
  $("#projectDetailTitle").textContent = project.name;
  $("#projectDetailSubtitle").textContent = `${projectStatusLabel(project.status)} · ${project.repository || "GitHub 저장소 미연결"}`;
  $("#breadcrumbPage").textContent = project.name;

  const address = project.slug
    ? `<a href="/${encodeURIComponent(project.slug)}/" target="_blank" rel="noopener noreferrer">${escapeHtml(location.host + "/" + project.slug + "/")}</a>`
    : "사용할 수 없음";
  const repositoryUrl = getPublicRepositoryUrl(project.repositoryUrl);
  const contentByTab = {
    overview: `
      <div class="detail-section-heading"><p class="eyebrow">OVERVIEW</p><h2>프로젝트 개요</h2></div>
      <div class="detail-summary-grid">
        <article class="detail-summary-card"><span>상태</span><strong>${escapeHtml(projectStatusLabel(project.status))}</strong></article>
        <article class="detail-summary-card"><span>프로젝트 주소</span><strong>${address}</strong></article>
        <article class="detail-summary-card"><span>실행 포트</span><strong>${project.port ? escapeHtml(project.port) : "실행 시 할당"}</strong></article>
        <article class="detail-summary-card"><span>배포 커밋</span><strong>${escapeHtml(project.deployedCommit ? project.deployedCommit.slice(0, 7) : "배포 전")}</strong></article>
      </div>
      <form id="projectCommandsForm" class="detail-commands-form">
        <div class="detail-section-heading"><p class="eyebrow">BUILD SETTINGS</p><h2>빌드 및 실행 커맨드</h2></div>
        <label>Build Command<input id="detailBuildCommand" value="${escapeHtml(project.buildCommand || "")}" placeholder="예: npm install"></label>
        <label>Start Command<input id="detailStartCommand" value="${escapeHtml(project.startCommand || "")}" placeholder="예: npm start"></label>
        <div class="detail-commands-footer"><p id="projectCommandsMessage" class="file-message" role="status" aria-live="polite">저장 후 실행 또는 배포할 때 적용됩니다.</p><button type="submit">설정 저장</button></div>
      </form>`,
    deploys: `
      <div class="detail-section-heading"><p class="eyebrow">DEPLOYS</p><h2>배포 기록</h2></div>
      <p id="projectDetailDeployMessage" class="file-message" role="status" aria-live="polite">커밋 기록을 불러오는 중...</p>
      <div id="projectDetailCommitList" class="commit-list"></div>`,
    logs: `
      <div class="detail-section-heading"><p class="eyebrow">LOGS</p><h2>프로젝트 로그</h2></div>
      <div class="logs-toolbar">
        <label class="log-range-control"><span class="visually-hidden">로그 조회 기간</span><select id="projectDetailLogRange"><option value="1h">최근 1시간</option><option value="6h">최근 6시간</option><option value="24h">최근 24시간</option><option value="2d" selected>최근 2일</option><option value="7d">최근 7일</option><option value="all">전체 로그</option></select></label>
        <span id="projectDetailLogsStatus" class="muted">로그를 불러오는 중...</span><button type="button" data-detail-action="refresh-logs">새로고침</button>
      </div>
      <div id="projectDetailLogsOutput" class="logs-output logs-list" aria-live="polite">로그를 불러오는 중...</div>`,
    files: `
      <div class="detail-section-heading"><p class="eyebrow">SOURCE FILES</p><h2>소스 파일</h2></div>
      <article class="detail-action-card"><div><strong>GitHub 저장소</strong><p>${escapeHtml(project.repository || "공개 저장소가 연결되지 않았습니다.")}</p></div>${repositoryUrl
        ? `<a class="detail-view-link" href="${escapeHtml(repositoryUrl)}" target="_blank" rel="noopener noreferrer">보기</a>`
        : '<button type="button" data-detail-action="connect-repo">저장소 연결</button>'}</article>`,
    environment: `
      <div class="detail-section-heading"><p class="eyebrow">ENVIRONMENT</p><h2>환경변수</h2></div>
      <article class="detail-action-card"><div><strong>프로젝트 .env</strong><p>저장된 환경변수를 확인하고 수정합니다.</p></div><button type="button" data-detail-action="environment">환경변수 열기</button></article>`,
    terminal: `
      <div class="detail-section-heading"><p class="eyebrow">SHELL</p><h2>프로젝트 터미널</h2></div>
      <p id="detailTerminalMessage" class="environment-description">프로젝트 폴더에서 대화형 터미널을 연결하는 중...</p>
      <div id="detailTerminalOutput" class="terminal-output detail-terminal-output" aria-label="프로젝트 대화형 터미널"></div>`
  };
  $("#projectDetailContent").innerHTML = contentByTab[projectDetailTab] || contentByTab.overview;
  if (projectDetailTab === "deploys") loadProjectDetailCommits();
  if (projectDetailTab === "logs") {
    stopProjectDetailLogRefresh();
    projectDetailLogsInitialLoad = true;
    refreshProjectDetailLogs();
    detailLogsRefreshTimer = setInterval(refreshProjectDetailLogs, 2000);
  }
  if (projectDetailTab === "terminal") {
    window.openProjectTerminalInline?.(projectDetailId, project.name);
  } else {
    window.closeProjectTerminalInline?.();
  }
}

$("#projectDetailNav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-detail-tab]");
  if (!button) return;
  stopProjectDetailLogRefresh();
  projectDetailTab = button.dataset.detailTab;
  $("#projectDetailNav").querySelectorAll("[data-detail-tab]").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  renderProjectDetail();
});

$("#projectDetailContent").addEventListener("change", (event) => {
  if (event.target.id === "projectDetailLogRange") {
    projectDetailLogsInitialLoad = true;
    refreshProjectDetailLogs();
  }
});

$("#projectDetailContent").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-detail-action]");
  if (!button || !projectDetailId) return;
  if (button.dataset.detailAction === "deploy-commit") {
    deploymentProjectId = projectDetailId;
    const commit = { sha: button.dataset.commit, message: "", author: "", date: "" };
    await deployCommit(commit, button, "#projectDetailCommitList", "#projectDetailDeployMessage");
  } else if (button.dataset.detailAction === "refresh-logs") await refreshProjectDetailLogs();
  else if (button.dataset.detailAction === "connect-repo") await openFileManager(projectDetailId);
  else if (button.dataset.detailAction === "environment") await openEnvironmentModal(projectDetailId);
  else if (button.dataset.detailAction === "terminal") {
    await window.openProjectTerminal(projectDetailId, projectsById.get(projectDetailId)?.name || "프로젝트");
  }
});

$("#projectDetailContent").addEventListener("submit", async (event) => {
  if (event.target.id !== "projectCommandsForm" || !projectDetailId) return;
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  $("#projectCommandsMessage").textContent = "저장 중...";
  $("#projectCommandsMessage").classList.remove("error");
  try {
    const result = await readResponse(await fetch(projectUrl(projectDetailId, "/commands"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buildCommand: $("#detailBuildCommand").value,
        startCommand: $("#detailStartCommand").value
      })
    }));
    const currentProjectId = projectDetailId;
    projectsById.set(currentProjectId, { ...projectsById.get(currentProjectId), ...result.project });
    renderProjectDetail();
    const sync = result.discordSync;
    $("#projectCommandsMessage").textContent = sync?.configured && !sync.ok
      ? `설정은 저장했지만 Discord 동기화에 실패했습니다: ${sync.error || "연결을 확인하세요."}`
      : "커맨드를 저장했습니다. 다음 실행 또는 배포부터 적용됩니다.";
  } catch (error) {
    const message = $("#projectCommandsMessage");
    if (message) {
      message.textContent = error.message;
      message.classList.add("error");
    }
  } finally {
    const saveButton = $("#projectCommandsForm button[type=\"submit\"]");
    if (saveButton) saveButton.disabled = false;
  }
});

$("#backToProjectsButton").addEventListener("click", () => showDashboardPage("projects"));

$("#projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("#projectName").value
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

function getPublicRepositoryUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && !url.username && !url.password) {
      return url.href;
    }
  } catch {}
  return "";
}

async function openProjectRepository(projectId) {
  const repositoryUrl = getPublicRepositoryUrl(projectsById.get(projectId)?.repositoryUrl);
  if (repositoryUrl) {
    window.open(repositoryUrl, "_blank", "noopener,noreferrer");
    return;
  }
  await openFileManager(projectId);
}

async function loadProjectDetailCommits() {
  const projectId = projectDetailId;
  const list = $("#projectDetailCommitList");
  const message = $("#projectDetailDeployMessage");
  if (!projectId || !list || !message) return;
  const project = projectsById.get(projectId);
  if (!project?.repositoryUrl) {
    list.replaceChildren();
    message.textContent = "먼저 소스 파일에서 공개 GitHub 저장소를 연결하세요.";
    return;
  }

  deploymentProjectId = projectId;
  list.replaceChildren();
  message.textContent = "커밋 기록을 불러오는 중...";
  message.classList.remove("error");
  try {
    const result = await readResponse(await fetch(projectUrl(projectId, "/github/commits")));
    if (projectDetailId !== projectId || projectDetailTab !== "deploys") return;
    message.textContent = `${result.repository} · ${result.branch} 브랜치의 최근 커밋`;
    for (const commit of result.commits) renderCommit(commit, "#projectDetailCommitList", "#projectDetailDeployMessage");
    if (!result.commits.length) list.textContent = "표시할 커밋이 없습니다.";
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
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

function renderCommit(commit, listSelector = "#commitList", messageSelector = "#deploymentMessage") {
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
  button.addEventListener("click", () => deployCommit(commit, button, listSelector, messageSelector));
  row.append(details, button);
  $(listSelector).append(row);
}

async function deployCommit(commit, button, listSelector = "#commitList", messageSelector = "#deploymentMessage") {
  if (!deploymentProjectId) return;
  const list = $(listSelector);
  const message = $(messageSelector);
  for (const item of list.querySelectorAll("button")) item.disabled = true;
  message.classList.remove("error");
  message.textContent = `${commit.sha.slice(0, 7)} 커밋을 받아 빌드하고 실행하는 중...`;
  button.textContent = "배포 중...";
  try {
    const result = await readResponse(await fetch(projectUrl(deploymentProjectId, "/github/deploy"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commit: commit.sha })
    }));
    message.textContent = `${result.commit.slice(0, 7)} 배포 완료 · ${result.fileCount}개 파일 · 빌드 후 실행 중`;
    await refresh();
    if (listSelector === "#projectDetailCommitList") {
      await loadProjectDetailCommits();
      return;
    }
    for (const item of list.querySelectorAll("button")) item.disabled = false;
    button.textContent = "이 커밋 재배포";
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
    for (const item of list.querySelectorAll("button")) item.disabled = false;
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
    const logOutput = $("#logsOutput");
    const previousScrollTop = logOutput.scrollTop;
    logOutput.textContent = result.logs || "아직 기록된 로그가 없습니다.";
    logOutput.scrollTop = previousScrollTop;
    const status = result.status || "상태 정보 없음";
    const lineCount = Number.isFinite(result.lineCount)
      ? result.lineCount
      : (result.logs ? result.logs.split("\n").length : 0);
    $("#logsStatus").textContent = `${status} · 최근 로그 ${lineCount}줄`;
  } catch (error) {
    $("#logsOutput").textContent = error.message;
  }
}

async function refreshProjectDetailLogs() {
  if (projectDetailTab !== "logs" || !projectDetailId) return;
  const output = $("#projectDetailLogsOutput");
  if (!output) return;
  try {
    const range = document.querySelector("#projectDetailLogRange")?.value || "2d";
    const rangeSince = { "1h": 60 * 60_000, "6h": 6 * 60 * 60_000, "24h": 24 * 60 * 60_000, "2d": 2 * 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000 };
    const query = range === "all" ? "?all=1" : `?from=${encodeURIComponent(new Date(Date.now() - rangeSince[range]).toISOString())}`;
    const result = await readResponse(await fetch(projectUrl(projectDetailId, `/logs${query}`), {
      cache: "no-store"
    }));
    if (projectDetailTab !== "logs" || !output.isConnected) return;
    const previousScrollTop = output.scrollTop;
    renderProjectLogLines(output, result.logs);
    if (projectDetailLogsInitialLoad) {
      output.scrollTop = output.scrollHeight;
      projectDetailLogsInitialLoad = false;
    } else output.scrollTop = previousScrollTop;
    $("#projectDetailLogsStatus").textContent = `${projectStatusLabel(result.status)} · 최근 로그 ${result.lineCount}줄`;
  } catch (error) {
    output.textContent = error.message;
  }
}

function renderProjectLogLines(container, rawLogs) {
  container.replaceChildren();
  const lines = String(rawLogs || "").split("\n").filter(Boolean);
  if (!lines.length) {
    container.textContent = "선택한 기간에 로그가 없습니다.";
    return;
  }
  let currentDay = "";
  let dayGroup;
  for (const line of lines) {
    const match = /^\[(.*?)\]\s*(.*)$/.exec(line);
    const timestamp = match ? new Date(match[1]) : null;
    const message = match?.[2] || line;
    const validTimestamp = timestamp && Number.isFinite(timestamp.getTime());
    const dayLabel = validTimestamp ? timestamp.toLocaleDateString() : "시간 정보 없음";
    if (dayLabel !== currentDay) {
      currentDay = dayLabel;
      dayGroup = document.createElement("section");
      dayGroup.className = "log-day-group";
      const heading = document.createElement("h3");
      heading.textContent = dayLabel;
      dayGroup.append(heading);
      container.append(dayGroup);
    }
    const row = document.createElement("div");
    row.className = "log-row";
    const time = document.createElement("time");
    if (validTimestamp) {
      time.dateTime = timestamp.toISOString();
      time.textContent = timestamp.toLocaleTimeString();
    } else time.textContent = "--:--:--";
    const content = document.createElement("span");
    content.textContent = message;
    const errorLine = /^\[(?:ERROR|ERR|BUILD_ERR)\]/i.test(message) || /\b(error|failed)\b|오류|실패/i.test(message);
    const buildLine = /^\[BUILD\]/i.test(message) || /빌드 (?:시작|종료|실행|커맨드)/i.test(message);
    if (errorLine) row.classList.add("log-row-error");
    else if (buildLine) row.classList.add("log-row-build");
    row.append(time, content);
    dayGroup.append(row);
  }
}

function stopProjectDetailLogRefresh() {
  clearInterval(detailLogsRefreshTimer);
  detailLogsRefreshTimer = null;
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
  $("#environmentTextImport").value = "";
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
function applyEnvironmentText() {
  const result = window.parseEnvironmentText($("#environmentTextImport").value);
  const message = $("#environmentMessage");
  if (result.error) {
    message.textContent = result.error;
    message.classList.add("error");
    return;
  }

  $("#environmentRows").replaceChildren();
  for (const variable of result.variables) addEnvironmentRow(variable.key, variable.value);
  message.textContent = `${result.variables.length}개 변수를 입력란에 반영했습니다. 저장 버튼을 눌러 저장하세요.`;
  message.classList.remove("error");
}

$("#applyEnvironmentTextButton").addEventListener("click", applyEnvironmentText);
$("#environmentTextImport").addEventListener("paste", () => setTimeout(applyEnvironmentText, 0));
$("#closeEnvironmentButton").addEventListener("click", () => $("#environmentModal").close());
$("#cancelEnvironmentButton").addEventListener("click", () => $("#environmentModal").close());
$("#environmentModal").addEventListener("close", () => {
  $("#environmentRows").replaceChildren();
  $("#environmentTextImport").value = "";
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
