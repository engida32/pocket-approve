import { summarize, titleFor } from "../summarize.mjs";

export function normalize(raw = {}) {
  const request = {
    id: raw.id,
    sessionID: raw.sessionID,
    permission: raw.permission,
    patterns: Array.isArray(raw.patterns) ? raw.patterns : [],
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
  };
  if (Array.isArray(raw.always)) request.always = raw.always;
  if (typeof raw.tool === "string") request.tool = raw.tool;
  return request;
}

export function createOpenCodeSource(client) {
  return {
    async list() {
      const requests = await client.list();
      const items = Array.isArray(requests) ? requests : [];
      return items.map((raw) => {
        const request = normalize(raw);
        return {
          ...request,
          title: titleFor(request),
          summary: summarize(request),
        };
      });
    },
    reply(id, decision) {
      return client.reply(id, decision);
    },
  };
}
