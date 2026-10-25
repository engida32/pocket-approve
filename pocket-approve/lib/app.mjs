import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.mjs";
import { isAuthorized } from "./auth.mjs";
import { DECISIONS, createState } from "./state.mjs";

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(PROJECT_DIR, "public");
const BODY_LIMIT = 64 * 1024;

const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

const STATIC_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
});

const SETUP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocket Approve certificate setup</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #111; }
  code { background: #f2f2f2; padding: 0.1rem 0.3rem; border-radius: 4px; }
  a.button { display: inline-block; margin: 1rem 0; padding: 0.7rem 1rem; background: #111; color: #fff; text-decoration: none; border-radius: 6px; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    code { background: #262626; }
    a.button { background: #eee; color: #111; }
  }
</style>
</head>
<body>
<h1>Pocket Approve</h1>
<p>Install this certificate on the phone before opening the app. It lets the phone trust the local HTTPS server.</p>
<p><a class="button" href="/ca.crt" download="pocket-approve-ca.crt">Download the certificate</a></p>
<ol>
  <li>Download the certificate on the phone.</li>
  <li>Open the downloaded file and install it as a CA certificate.</li>
  <li>Open the app address printed by the setup command.</li>
</ol>
<p>This page only serves the certificate. It does not show the app token and cannot approve anything.</p>
</body>
</html>
`;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function send(res, status, headers, body) {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, body) {
  send(
    res,
    status,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    JSON.stringify(body),
  );
}

function sendText(res, status, text, headers = {}) {
  send(
    res,
    status,
    {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
    text,
  );
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      throw httpError(413, "request body is too large");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "invalid JSON");
  }
}

function methodNotAllowed(res, allow) {
  if (res.headersSent) return;
  res.writeHead(405, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Allow: allow,
  });
  res.end(JSON.stringify({ error: "method not allowed" }));
}

export function createApp({ source, push, desktop, config = {} } = {}) {
  if (!source || typeof source.list !== "function") {
    throw new TypeError("source.list must be a function");
  }
  const state = createState({ source, desktop });
  const token = config?.token ?? null;
  const dataDir = config?.dataDir ?? DATA_DIR;

  async function serveStatic(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      methodNotAllowed(response, "GET, HEAD");
      return;
    }
    const entry = STATIC_FILES[pathname];
    if (!entry) {
      sendText(response, 404, "Not found");
      return;
    }
    const [name, type] = entry;
    let body;
    try {
      body = await readFile(join(PUBLIC_DIR, name));
    } catch (error) {
      if (error.code === "ENOENT") {
        sendText(response, 404, "Not found");
        return;
      }
      sendText(response, 500, "Internal error");
      return;
    }
    send(
      response,
      200,
      {
        "Content-Type": type,
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
      },
      request.method === "HEAD" ? "" : body,
    );
  }

  async function handleApi(request, response, pathname) {
    const method = request.method;

    if (pathname === "/api/health") {
      if (method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (!isAuthorized(request, token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (pathname === "/api/pending") {
      if (method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }
      let requests;
      try {
        requests = await source.list();
      } catch {
        sendJson(response, 502, { error: "upstream failure" });
        return;
      }
      state.replace(Array.isArray(requests) ? requests : []);
      sendJson(response, 200, state.list());
      return;
    }

    if (pathname === "/api/reply") {
      if (method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: "invalid request" });
        return;
      }
      const id = body?.id;
      const decision = body?.decision;
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > 200 ||
        !DECISIONS.includes(decision)
      ) {
        sendJson(response, 400, { error: "invalid request" });
        return;
      }
      let answered;
      try {
        answered = await state.reply(id, decision);
      } catch {
        sendJson(response, 502, { error: "upstream failure" });
        return;
      }
      if (!answered) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === "/api/vapid-public-key") {
      if (method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }
      sendJson(response, 200, { publicKey: push?.publicKey ?? null });
      return;
    }

    if (pathname === "/api/subscribe") {
      if (method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, { error: "invalid request" });
        return;
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        sendJson(response, 400, { error: "invalid request" });
        return;
      }
      try {
        await push.add(body);
      } catch (error) {
        if (error instanceof TypeError) {
          sendJson(response, 400, { error: "invalid request" });
          return;
        }
        sendJson(response, 500, { error: "subscription failed" });
        return;
      }
      sendJson(response, 201, { ok: true });
      return;
    }

    if (pathname === "/api/test-notification") {
      if (method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }
      let result;
      try {
        result = await push.send({
          requestId: "test",
          title: "Pocket Approve",
          summary: "Test notification from Pocket Approve.",
        });
      } catch {
        sendJson(response, 500, { error: "notification failed" });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
      });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  async function handleRequest(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://pocket-approve.invalid").pathname;
    } catch {
      sendText(response, 400, "Bad request");
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApi(request, response, pathname);
      return;
    }

    if (Object.hasOwn(STATIC_FILES, pathname)) {
      await serveStatic(request, response, pathname);
      return;
    }

    sendText(response, 404, "Not found");
  }

  async function handleSetup(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://pocket-approve.invalid").pathname;
    } catch {
      sendText(response, 400, "Bad request");
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      methodNotAllowed(response, "GET, HEAD");
      return;
    }

    if (pathname === "/") {
      send(
        response,
        200,
        {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
        request.method === "HEAD" ? "" : SETUP_PAGE,
      );
      return;
    }

    if (pathname === "/ca.crt") {
      let body;
      try {
        body = await readFile(join(dataDir, "ca.crt"));
      } catch (error) {
        if (error.code === "ENOENT") {
          sendText(response, 404, "Not found");
          return;
        }
        sendText(response, 500, "Internal error");
        return;
      }
      send(
        response,
        200,
        {
          "Content-Type": "application/x-x509-ca-cert",
          "Content-Length": String(body.length),
          "Cache-Control": "no-store",
        },
        request.method === "HEAD" ? "" : body,
      );
      return;
    }

    sendText(response, 404, "Not found");
  }

  function guard(handler) {
    return (request, response) => {
      Promise.resolve(handler(request, response)).catch(() => {
        if (!response.headersSent) {
          sendText(response, 500, "Internal error");
        } else {
          response.end();
        }
      });
    };
  }

  return {
    handler: guard(handleRequest),
    setupHandler: guard(handleSetup),
    state,
  };
}
