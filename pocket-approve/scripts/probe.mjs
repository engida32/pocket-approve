const base = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const auth = password
  ? { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
  : {};
const [cmd, id, decision] = process.argv.slice(2);
if (cmd === "list") {
  const res = await fetch(`${base}/permission`, { headers: auth });
  console.log(JSON.stringify(await res.json(), null, 2));
} else if (cmd === "reply") {
  const res = await fetch(`${base}/permission/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ reply: decision }),
  });
  console.log(res.status, await res.text());
} else {
  console.error("usage: probe.mjs list | reply <id> once|always|reject");
  process.exit(1);
}
