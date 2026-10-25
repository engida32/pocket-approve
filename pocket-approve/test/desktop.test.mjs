import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildNotifyArgs,
  buildCloseArgs,
  parseNotifyId,
  parseActionLine,
  createDesktop,
} from "../lib/desktop.mjs";

function fakeSpawn({
  id = 7,
  callCode = 0,
  callStdout = null,
  throwOnCall = false,
  throwOnMonitor = false,
} = {}) {
  const children = [];
  const spawnFn = (cmd, args) => {
    if (throwOnMonitor && args[0] === "monitor") throw new Error("monitor spawn failed");
    if (throwOnCall && args[0] === "call") throw new Error("spawn failed");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.args = args;
    children.push(child);
    if (args[0] === "call") {
      queueMicrotask(() => {
        child.stdout.write(callStdout ?? `(uint32 ${id},)\n`);
        child.emit("close", callCode);
      });
    }
    return child;
  };
  return { spawnFn, children };
}

function monitorChild(children) {
  return children.find((child) => child.args[0] === "monitor");
}

test("buildNotifyArgs carries the title, summary, urgency, icon and three actions", () => {
  const args = buildNotifyArgs({ title: "Bash: touch x", summary: "touch x" });
  assert.deepEqual(args, [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.Notifications",
    "--object-path",
    "/org/freedesktop/Notifications",
    "--method",
    "org.freedesktop.Notifications.Notify",
    "--",
    "Pocket Approve",
    "0",
    "dialog-question",
    "Bash: touch x",
    "touch x",
    "['once','Allow once','always','Allow always','reject','Deny']",
    "{'urgency': <byte 2>}",
    "-1",
  ]);
});

test("buildCloseArgs closes the notification by id", () => {
  assert.deepEqual(buildCloseArgs(39), [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.Notifications",
    "--object-path",
    "/org/freedesktop/Notifications",
    "--method",
    "org.freedesktop.Notifications.CloseNotification",
    "39",
  ]);
});

test("parses the notification id and action signal", () => {
  assert.equal(parseNotifyId("(uint32 39,)\n"), 39);
  assert.deepEqual(
    parseActionLine(
      "/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 39, 'always')",
    ),
    { id: 39, decision: "always" },
  );
  assert.deepEqual(
    parseActionLine(
      "/org/freedesktop/Notifications: org.freedesktop.Notifications.NotificationClosed (uint32 39, uint32 2)",
    ),
    { id: 39, closed: true },
  );
  assert.equal(parseActionLine("Monitoring signals from all objects"), null);
});

test("parsers tolerate whitespace and reject noise", () => {
  assert.equal(parseNotifyId("( uint32  41 , )\n"), 41);
  assert.equal(parseNotifyId("error: nothing here\n"), null);
  assert.deepEqual(
    parseActionLine(
      "/org/freedesktop/Notifications: org.freedesktop.Notifications.NotificationClosed (uint32 5, uint32 1)",
    ),
    { id: 5, closed: true },
  );
  assert.equal(
    parseActionLine(
      "/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 5, 'other')",
    ).id,
    5,
  );
});

test("action resolves the request, fires onAction, and close dismisses it", async () => {
  const { spawnFn, children } = fakeSpawn();
  const actions = [];
  const closed = [];
  const desktop = createDesktop({ spawnFn, log: { error() {} } });
  desktop.onAction((event) => actions.push(event));
  desktop.onClosed((event) => closed.push(event));

  const pending = desktop.notify({ id: "per_1", title: "Bash: touch x", summary: "touch x" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  monitorChild(children).stdout.write(
    "/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 7, 'once')\n",
  );
  assert.deepEqual(await pending, { id: 7, decision: "once" });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].requestId, "per_1");
  assert.equal(actions[0].decision, "once");

  const second = desktop.notify({ id: "per_2", title: "Bash: touch y", summary: "touch y" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  desktop.close("per_2");
  assert.deepEqual(await second, { id: 7, decision: null });
  assert.equal(closed.length, 0);
  assert.ok(
    children.some(
      (child) =>
        child.args.includes("org.freedesktop.Notifications.CloseNotification") &&
        child.args.at(-1) === "7",
    ),
  );

  desktop.stop();
});

test("NotificationClosed releases the request without approving", async () => {
  const { spawnFn, children } = fakeSpawn({ id: 11 });
  const closed = [];
  const desktop = createDesktop({ spawnFn, log: { error() {} } });
  desktop.onClosed((event) => closed.push(event));

  const pending = desktop.notify({ id: "per_9", title: "t", summary: "s" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  monitorChild(children).stdout.write(
    "/org/freedesktop/Notifications: org.freedesktop.Notifications.NotificationClosed (uint32 11, uint32 2)\n",
  );

  assert.deepEqual(await pending, { id: 11, decision: null });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].requestId, "per_9");
  desktop.stop();
});

test("an unknown action never becomes a decision", async () => {
  const { spawnFn, children } = fakeSpawn();
  const desktop = createDesktop({ spawnFn, log: { error() {} } });
  const pending = desktop.notify({ id: "per_4", title: "t", summary: "s" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const monitor = monitorChild(children);

  monitor.stdout.write(
    "/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 7, 'dismiss')\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  desktop.close("per_4");
  assert.deepEqual(await pending, { id: 7, decision: null });
  desktop.stop();
});

test("failed gdbus calls are logged and resolve null, never throw", async () => {
  const errors = [];
  const log = { error: (...args) => errors.push(args) };

  const broken = fakeSpawn({ callCode: 2, callStdout: "error: no daemon\n" });
  const first = createDesktop({ spawnFn: broken.spawnFn, log });
  assert.deepEqual(await first.notify({ id: "a", title: "t", summary: "s" }), {
    id: null,
    decision: null,
  });
  first.stop();

  const throwing = fakeSpawn({ throwOnCall: true });
  const second = createDesktop({ spawnFn: throwing.spawnFn, log });
  assert.deepEqual(await second.notify({ id: "b", title: "t", summary: "s" }), {
    id: null,
    decision: null,
  });
  second.stop();

  assert.equal(errors.length, 2);
});

test("a monitor crash releases pending requests without a decision", async () => {
  const errors = [];
  const { spawnFn, children } = fakeSpawn();
  const desktop = createDesktop({ spawnFn, log: { error: (...args) => errors.push(args) } });

  const pending = desktop.notify({ id: "per_3", title: "t", summary: "s" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  monitorChild(children).emit("close", 1);

  assert.deepEqual(await pending, { id: null, decision: null });
  assert.equal(errors.length, 1);
  desktop.stop();
});

test("a monitor that cannot start fails closed", async () => {
  const errors = [];
  const { spawnFn } = fakeSpawn({ throwOnMonitor: true });
  const desktop = createDesktop({ spawnFn, log: { error: (...args) => errors.push(args) } });

  assert.deepEqual(await desktop.notify({ id: "per_6", title: "t", summary: "s" }), {
    id: null,
    decision: null,
  });
  assert.equal(errors.length, 1);
  desktop.stop();
});

test("a throwing action handler is logged, not thrown", async () => {
  const errors = [];
  const { spawnFn, children } = fakeSpawn();
  const desktop = createDesktop({ spawnFn, log: { error: (...args) => errors.push(args) } });
  desktop.onAction(() => {
    throw new Error("handler boom");
  });

  const pending = desktop.notify({ id: "per_5", title: "t", summary: "s" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  monitorChild(children).stdout.write(
    "/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 7, 'reject')\n",
  );

  assert.deepEqual(await pending, { id: 7, decision: "reject" });
  assert.equal(errors.length, 1);
  desktop.stop();
});
