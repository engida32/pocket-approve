export function namespacedId(serverId, rawId) {
  if (typeof serverId !== "string" || serverId === "") throw new TypeError("serverId is required");
  if (typeof rawId !== "string" || rawId === "") throw new TypeError("rawId is required");
  return `${serverId}:${rawId}`;
}

export function parseNamespacedId(value) {
  if (typeof value !== "string") return null;
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  return { serverId: value.slice(0, at), rawId: value.slice(at + 1) };
}
