const USERNAME = "opencode";

export function createClient({
  baseUrl,
  username = USERNAME,
  password = null,
  timeoutMs = 5000,
  directory = null,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new TypeError("baseUrl is required");
  function scoped(path) {
    if (!directory) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}directory=${encodeURIComponent(directory)}`;
  }
  async function call(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (password) {
      headers.authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        ...options,
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`OpenCode returned ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout = new Error(`OpenCode timed out after ${timeoutMs} ms`);
        timeout.code = "UPSTREAM_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    list: () => call(scoped("/permission")),
    reply: (id, decision) => call(scoped(`/permission/${encodeURIComponent(id)}/reply`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: decision }),
    }),
  };
}
