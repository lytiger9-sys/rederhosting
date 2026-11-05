import http from "node:http";
import { findProjectBySlug } from "./projectManager.js";
import { isReservedProjectSlug } from "./projectSlug.js";

function requestProjectSlug(request) {
  const rawSegment = request.url?.split(/[/?#]/)[1] || "";
  if (!rawSegment) return null;
  try {
    return { rawSegment, slug: decodeURIComponent(rawSegment).toLowerCase() };
  } catch {
    return null;
  }
}

function projectPathname(request, rawSegment) {
  const remainder = request.url.slice(rawSegment.length + 1);
  if (!remainder) return "/";
  if (remainder.startsWith("?")) return `/${remainder}`;
  return remainder.startsWith("/") ? remainder : `/${remainder}`;
}

function forwardedHeaders(request, project, targetPath) {
  const prefix = `/${project.slug}`;
  const host = request.headers.host || "";
  const headers = { ...request.headers };
  if (headers.cookie) {
    const projectCookies = headers.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .filter((cookie) => !/^hosting_panel_session=/i.test(cookie));
    if (projectCookies.length) headers.cookie = projectCookies.join("; ");
    else delete headers.cookie;
  }
  return {
    ...headers,
    host: `127.0.0.1:${project.port}`,
    "x-forwarded-for": request.ip || request.socket.remoteAddress || "",
    "x-forwarded-host": host,
    "x-forwarded-proto": request.headers["x-forwarded-proto"] || (request.socket.encrypted ? "https" : "http"),
    "x-forwarded-prefix": prefix,
    "x-forwarded-uri": request.originalUrl || request.url,
    "x-forwarded-path": targetPath
  };
}

function rewriteResponseHeaders(headers, slug) {
  const prefix = `/${slug}`;
  const output = { ...headers };
  const location = output.location;
  if (typeof location === "string" && location.startsWith("/") && !location.startsWith("//") &&
      location !== prefix && !location.startsWith(`${prefix}/`)) {
    output.location = `${prefix}${location}`;
  }

  if (Array.isArray(output["set-cookie"])) {
    output["set-cookie"] = output["set-cookie"].map((cookie) =>
      /(?:^|;\s*)path=/i.test(cookie)
        ? cookie.replace(/(?:^|;\s*)path=\//i, (match) => `${match.slice(0, match.toLowerCase().indexOf("path="))}Path=${prefix}/`)
        : `${cookie}; Path=${prefix}/`
    );
  }
  return output;
}

function unavailable(response, status, message) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

export async function proxyProjectRequest(request, response, next) {
  const matched = requestProjectSlug(request);
  if (!matched || isReservedProjectSlug(matched.slug)) return next();

  const project = await findProjectBySlug(matched.slug);
  if (!project) return unavailable(response, 404, "프로젝트 주소를 찾을 수 없습니다.");
  if (project.status !== "running" || !Number.isInteger(project.port)) {
    return unavailable(response, 503, "프로젝트가 실행 중이 아닙니다.");
  }

  const remainder = request.url.slice(matched.rawSegment.length + 1);
  if (!remainder || remainder.startsWith("?")) {
    return response.redirect(308, `/${project.slug}/${remainder}`);
  }

  const targetPath = projectPathname(request, matched.rawSegment);
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: project.port,
    method: request.method,
    path: targetPath,
    headers: forwardedHeaders(request, project, targetPath)
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode || 502,
      rewriteResponseHeaders(upstreamResponse.headers, project.slug)
    );
    upstreamResponse.pipe(response);
  });

  upstream.setTimeout(120_000, () => upstream.destroy(new Error("Upstream request timed out.")));
  upstream.on("error", (error) => {
    if (response.headersSent) return response.destroy(error);
    unavailable(response, 502, "프로젝트 서버에 연결할 수 없습니다. 실행 로그와 포트 설정을 확인하세요.");
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

export async function proxyProjectUpgrade(request, socket, head) {
  const matched = requestProjectSlug(request);
  if (!matched || isReservedProjectSlug(matched.slug)) return socket.destroy();

  const project = await findProjectBySlug(matched.slug).catch(() => null);
  if (!project || project.status !== "running" || !Number.isInteger(project.port)) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }

  const targetPath = projectPathname(request, matched.rawSegment);
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: project.port,
    method: "GET",
    path: targetPath,
    headers: forwardedHeaders(request, project, targetPath)
  });

  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const headers = upstreamResponse.rawHeaders;
    let responseHead = `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
    for (let index = 0; index < headers.length; index += 2) {
      responseHead += `${headers[index]}: ${headers[index + 1]}\r\n`;
    }
    socket.write(`${responseHead}\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("response", (upstreamResponse) => {
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
  });
  upstream.on("error", () => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  socket.on("error", () => upstream.destroy());
  upstream.end();
}
