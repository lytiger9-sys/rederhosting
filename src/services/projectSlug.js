const projectNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
const reservedSlugs = new Set(["api", "css", "js", "login", "login.html", "index", "index.html", "favicon", "favicon.ico"]);

export function normalizeProjectSlug(name) {
  const value = String(name || "").trim();
  if (!projectNamePattern.test(value)) return "";
  const slug = value.toLowerCase();
  return reservedSlugs.has(slug) ? "" : slug;
}

export function isReservedProjectSlug(slug) {
  return reservedSlugs.has(String(slug || "").toLowerCase());
}

export function validateProjectName(name) {
  const slug = normalizeProjectSlug(name);
  if (!slug) {
    const error = new Error("프로젝트 이름은 영문자·숫자로 시작하고, 영문자·숫자·하이픈만 사용할 수 있습니다. (예: my-app)");
    error.status = 400;
    throw error;
  }
  return slug;
}
