import test from "node:test";
import assert from "node:assert/strict";
import { summarize, titleFor } from "../lib/summarize.mjs";

test("summary survives empty metadata and truncates long text", () => {
  assert.equal(summarize({ permission: "bash", patterns: [], metadata: {} }), "(no details)");
  assert.equal(summarize({ permission: "bash", patterns: ["rm -rf /tmp/x"], metadata: {} }), "rm -rf /tmp/x");
  const long = summarize({ metadata: { command: "a".repeat(10000) }, patterns: [], permission: "bash" });
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("..."));
});

test("title names the tool and first pattern", () => {
  assert.equal(titleFor({ permission: "bash", patterns: ["git status"] }), "Bash: git status");
});

test("summary prefers command, then description, then path, then patterns", () => {
  assert.equal(
    summarize({
      permission: "bash",
      patterns: ["npm test"],
      metadata: { command: "  npm   test  ", description: "Run the suite", path: "/tmp/file.txt" },
    }),
    "npm test",
  );
  assert.equal(
    summarize({
      permission: "bash",
      patterns: ["npm test"],
      metadata: { description: "Run the suite", path: "/tmp/file.txt" },
    }),
    "Run the suite",
  );
  assert.equal(
    summarize({
      permission: "edit",
      patterns: ["/tmp/file.txt"],
      metadata: { path: "/tmp/file.txt" },
    }),
    "/tmp/file.txt",
  );
  assert.equal(
    summarize({ permission: "bash", patterns: ["git   status", "&&  git\tdiff"], metadata: {} }),
    "git status && git diff",
  );
});

test("summary copes with absent metadata and empty candidates", () => {
  assert.equal(summarize({ permission: "bash" }), "(no details)");
  assert.equal(summarize({ patterns: [], metadata: null }), "(no details)");
  assert.equal(summarize({ patterns: "single", metadata: {} }), "single");
  assert.equal(summarize({ patterns: ["  ", ""], metadata: { command: "   " } }), "(no details)");
});

test("title copes with missing patterns and permission", () => {
  assert.equal(titleFor({ permission: "edit", patterns: [] }), "Edit");
  assert.equal(titleFor({}), "Permission");
  assert.equal(titleFor({ permission: "bash", patterns: ["  git   status  "] }), "Bash: git status");
  assert.equal(titleFor({ permission: "bash", patterns: [null, "second"] }), "Bash: second");
});
