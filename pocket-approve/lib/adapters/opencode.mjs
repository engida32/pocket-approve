import { summarize, titleFor } from "../summarize.mjs";

function normalize(raw) {
  const request = raw ?? {};
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.permission,
    patterns: Array.isArray(request.patterns) ? request.patterns : [],
    metadata:
      request.metadata &&
      typeof request.metadata === "object" &&
      !Array.isArray(request.metadata)
        ? request.metadata
        : {},
  };
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
