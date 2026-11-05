(() => {
  const modal = document.querySelector("#terminalModal");
  let output = document.querySelector("#terminalOutput");
  let message = document.querySelector("#terminalMessage");
  const closeButton = document.querySelector("#closeTerminalButton");
  let terminal = null;
  let fitAddon = null;
  let socket = null;
  let projectId = null;
  let sessionId = null;
  let resizeObserver = null;
  let inlineSession = false;

  function send(type, values = {}) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...values }));
  }

  async function closeSession() {
    const oldProjectId = projectId;
    const oldSessionId = sessionId;
    projectId = null;
    sessionId = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    terminal?.dispose();
    terminal = null;
    fitAddon = null;
    output?.replaceChildren();
    output = document.querySelector("#terminalOutput");
    message = document.querySelector("#terminalMessage");
    inlineSession = false;
    if (oldProjectId && oldSessionId) {
      await fetch(`/api/projects/${encodeURIComponent(oldProjectId)}/terminal/${encodeURIComponent(oldSessionId)}`, {
        method: "DELETE"
      }).catch(() => {});
    }
  }

  async function open(project, name, inline = false) {
    await closeSession();
    projectId = project;
    document.querySelector("#terminalTitle").textContent = `${name} 터미널`;
    inlineSession = inline;
    output = document.querySelector(inline ? "#detailTerminalOutput" : "#terminalOutput");
    message = document.querySelector(inline ? "#detailTerminalMessage" : "#terminalMessage");
    message.textContent = "프로젝트 폴더에서 대화형 셸을 여는 중...";
    if (!inline) modal.showModal();
    try {
      if (typeof window.Terminal !== "function" || !window.FitAddon?.FitAddon) {
        throw new Error("터미널 라이브러리를 불러오지 못했습니다. 페이지를 새로고침하고 패널 서버를 확인하세요.");
      }
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/terminal`, { method: "POST" });
      const created = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(created.error || "터미널을 열지 못했습니다.");
      if (projectId !== project || (inline ? !document.querySelector("#detailTerminalOutput") : !modal.open)) {
        await fetch(`/api/projects/${encodeURIComponent(project)}/terminal/${encodeURIComponent(created.sessionId)}`, { method: "DELETE" });
        return;
      }
      sessionId = created.sessionId;
      message.textContent = `${created.shell} · 프로젝트 폴더에서 실행 중 · 명령 입력 가능`;
      terminal = new window.Terminal({
        cursorBlink: true,
        fontFamily: 'Consolas, "Cascadia Code", monospace',
        fontSize: 13,
        theme: { background: "#080809", foreground: "#e4e4e7", cursor: "#fafafa" },
        scrollback: 3000
      });
      fitAddon = new window.FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(output);
      fitAddon.fit();
      terminal.focus();
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/api/projects/${encodeURIComponent(project)}/terminal/${encodeURIComponent(sessionId)}/ws`);
      socket.addEventListener("open", () => {
        message.textContent = `${created.shell} · ${project} 폴더 · 명령은 호스팅 서버 권한으로 실행됩니다.`;
        send("resize", { cols: terminal.cols, rows: terminal.rows });
        terminal.focus();
      });
      socket.addEventListener("message", (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (payload.type === "data") terminal?.write(payload.data);
        if (payload.type === "exit") message.textContent = `셸이 종료되었습니다 (종료 코드 ${payload.exitCode}). 다시 열어 주세요.`;
      });
      socket.addEventListener("close", () => {
        if (projectId === project && sessionId) message.textContent = "터미널 연결이 종료되었습니다. 닫은 뒤 다시 열어 주세요.";
      });
      socket.addEventListener("error", () => {
        message.textContent = "터미널 연결에 실패했습니다. 패널 서버와 로그인을 확인하세요.";
      });
      terminal.onData((data) => send("input", { data }));
      resizeObserver = new ResizeObserver(() => {
        if (!terminal || !fitAddon) return;
        fitAddon.fit();
        send("resize", { cols: terminal.cols, rows: terminal.rows });
      });
      resizeObserver.observe(output);
    } catch (error) {
      message.textContent = error.message;
    }
  }

  closeButton.addEventListener("click", () => modal.close());
  modal.addEventListener("close", closeSession);
  window.openProjectTerminal = (project, name) => open(project, name, false);
  window.openProjectTerminalInline = (project, name) => open(project, name, true);
  window.closeProjectTerminalInline = () => inlineSession ? closeSession() : Promise.resolve();
})();
