const MAX_SUMMARY = 140;
const ELLIPSIS = "...";
const NO_DETAILS = "(no details)";

function asText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function collapse(value) {
  return asText(value).replace(/\s+/g, " ").trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = collapse(value);
    if (text) return text;
  }
  return "";
}

function patternText(patterns) {
  if (!Array.isArray(patterns)) return collapse(patterns);
  return patterns.map(collapse).filter(Boolean).join(" ");
}

function truncate(text) {
  if (text.length <= MAX_SUMMARY) return text;
  return text.slice(0, MAX_SUMMARY - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}

function toolName(permission) {
  const text = collapse(permission);
  if (!text) return "Permission";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function summarize(request = {}) {
  const metadata = request?.metadata ?? {};
  const text = firstText(
    metadata.command,
    metadata.description,
    metadata.path,
    patternText(request?.patterns),
  );
  return text ? truncate(text) : NO_DETAILS;
}

export function titleFor(request = {}) {
  const tool = toolName(request?.permission);
  const patterns = Array.isArray(request?.patterns)
    ? request.patterns
    : [request?.patterns];
  const first = firstText(...patterns);
  return first ? `${tool}: ${first}` : tool;
}
