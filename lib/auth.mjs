import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

export function hashToken(token) {
  return digest(token);
}

export function tokensEqual(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") {
    return false;
  }
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearerToken(request) {
  const header = request?.headers?.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function isAuthorized(request, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const presented = bearerToken(request);
  if (presented === null) return false;
  return tokensEqual(presented, expected);
}
