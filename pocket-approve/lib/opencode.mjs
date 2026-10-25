const USERNAME = "opencode";

export function createClient({ baseUrl, password = null } = {}) {
  const auth = password
    ? {
        authorization: `Basic ${Buffer.from(`${USERNAME}:${password}`).toString("base64")}`,
      }
    : {};

  async function call(path, init = {}) {
    const url = new URL(path, baseUrl);
    const response = await fetch(url, {
      ...init,
      headers: { ...auth, ...init.headers },
    });
    if (!response.ok) {
      const error = new Error(
        `OpenCode ${init.method ?? "GET"} ${url.pathname} failed: ${response.status} ${response.statusText}`.trim(),
      );
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  return {
    list() {
      return call("/permission");
    },
    reply(id, decision) {
      return call(`/permission/${encodeURIComponent(id)}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply: decision }),
      });
    },
  };
}
