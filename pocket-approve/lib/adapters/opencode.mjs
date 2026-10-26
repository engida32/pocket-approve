import { summarize, titleFor } from "../summarize.mjs";

export function normalize(raw = {}) {
  const source = raw ?? {};
  const request = {
    id: source.id,
    sessionID: source.sessionID,
    permission: source.permission,
    patterns: Array.isArray(source.patterns) ? source.patterns : [],
    metadata:
      source.metadata &&
      typeof source.metadata === "object" &&
      !Array.isArray(source.metadata)
        ? source.metadata
        : {},
  };
  if (Array.isArray(source.always)) request.always = source.always;
  if (typeof source.tool === "string") request.tool = source.tool;
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
