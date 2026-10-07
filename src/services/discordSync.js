import { config } from "../config/env.js";

const API_BASE = "https://discord.com/api/v10";
const SNAPSHOT_MARKER = "hosting-panel-state:v1";
const SNAPSHOT_FILE = "hosting-panel-state-v1.json";
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

function credentials() {
  return { token: config.discordBotToken, channelId: config.discordChannelId };
}

export function isDiscordSyncConfigured() {
  const { token, channelId } = credentials();
  return Boolean(token && channelId);
}

async function discordRequest(endpoint, options = {}) {
  const { token } = credentials();
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(10000),
    headers: { Authorization: `Bot ${token}`, ...options.headers }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    throw new Error(`Discord API 오류 (${response.status}): ${data.message || response.statusText}`);
  }
  return data;
}

export async function sendProjectSnapshot(projects, reason = "변경") {
  if (!isDiscordSyncConfigured()) return { ok: false, skipped: true };

  const payload = {
    format: "hosting-panel-state-v1",
    updatedAt: new Date().toISOString(),
    reason,
    projects
  };
  const contents = JSON.stringify(payload, null, 2);
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error("프로젝트 설정 스냅샷이 Discord 첨부 제한을 초과합니다.");
  }

  const { channelId } = credentials();
  const form = new FormData();
  form.set("payload_json", JSON.stringify({
    content: SNAPSHOT_MARKER,
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: SNAPSHOT_FILE }]
  }));
  form.append("files[0]", new Blob([contents], { type: "application/json" }), SNAPSHOT_FILE);
  await discordRequest(`/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    body: form
  });
  return { ok: true };
}

export async function readLatestProjectSnapshot() {
  if (!isDiscordSyncConfigured()) return null;

  const { channelId } = credentials();
  const me = await discordRequest("/users/@me");
  const messages = await discordRequest(
    `/channels/${encodeURIComponent(channelId)}/messages?limit=100`
  );

  for (const message of messages) {
    if (message.author?.id !== me.id || message.content !== SNAPSHOT_MARKER) continue;
    const attachment = message.attachments?.find((item) => item.filename === SNAPSHOT_FILE);
    if (!attachment?.url) continue;

    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Discord 스냅샷 파일을 읽지 못했습니다 (${response.status}).`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new Error("Discord 스냅샷 파일 크기가 제한을 초과합니다.");
    }
    const snapshot = JSON.parse(text);
    if (snapshot.format !== "hosting-panel-state-v1" || !Array.isArray(snapshot.projects)) {
      throw new Error("Discord에 저장된 프로젝트 스냅샷 형식이 올바르지 않습니다.");
    }
    return snapshot;
  }

  return null;
}
