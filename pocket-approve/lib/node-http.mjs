const MAX_BODY = 64 * 1024;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function writeJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function responseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers) headers[name] = value;
  const cookies = response.headers.getSetCookie?.();
  if (Array.isArray(cookies) && cookies.length > 0) headers["set-cookie"] = cookies;
  return headers;
}

function hasBody(method, status) {
  if (method === "HEAD") return false;
  if (status === 204 || status === 304 || status < 200) return false;
  return true;
}

export function toNodeHandler(fetchHandler) {
  if (typeof fetchHandler !== "function") throw new TypeError("fetchHandler is required");
  return async function nodeHandler(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }

      const declared = Number(headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BODY) {
        writeJson(res, 413, { error: "body_too_large" }, { connection: "close" });
        return;
      }

      let body;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) {
            writeJson(res, 413, { error: "body_too_large" }, { connection: "close" });
            return;
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }

      const request = new Request(url, { method: req.method, headers, body });
      const response = await fetchHandler(request);
      res.writeHead(response.status, responseHeaders(response));
      if (!hasBody(req.method, response.status) || response.body === null) {
        res.end();
        return;
      }
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      writeJson(res, 500, { error: "internal_error" });
    }
  };
}
