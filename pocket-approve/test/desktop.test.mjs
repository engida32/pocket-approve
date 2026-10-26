import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildNotifyArgs,
  buildCloseArgs,
  parseNotifyId,
  createSignalParser,
  gvariantString,
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
    if (throwOnMonitor && cmd === "dbus-monitor") throw new Error("monitor spawn failed");
    if (throwOnCall && args[0] === "call") throw new Error("spawn failed");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.args = args;
    child.cmd = cmd;
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
  return children.find((child) => child.cmd === "dbus-monitor");
}

function actionBlock(id, decision, sender = ":1.24") {
  return [
    `signal time=1792973266.787843 sender=${sender} -> destination=(null destination) serial=198816 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=ActionInvoked`,
    `   uint32 ${id}`,
    `   string "${decision}"`,
    "",
  ].join("\n");
}

function closedBlock(id, sender = ":1.24") {
  return [
    `signal time=1792973266.787843 sender=${sender} -> destination=(null destination) serial=198816 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=NotificationClosed`,
    `   uint32 ${id}`,
    "   uint32 2",
    "",
  ].join("\n");
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
    "",
    '"Bash: touch x"',
    '"touch x"',
    "['once', 'Allow once', 'reject', 'Deny', 'always', 'Allow always']",
    "{'urgency': <byte 2>}",
    "0",
  ]);
});

test("gvariantString quotes backslashes, quotes, and control characters", () => {
  assert.equal(gvariantString(String.raw`C:\Users\me`), String.raw`"C:\\Users\\me"`);
  assert.equal(gvariantString("a\\"), '"a\\\\"');
  assert.equal(gvariantString('a\\"b'), String.raw`"a\\\"b"`);
  assert.equal(gvariantString(String.raw`echo \d+`), String.raw`"echo \\d+"`);
  assert.equal(gvariantString("It's fine"), `"It's fine"`);
  assert.equal(gvariantString("line\nnext"), '"line\\nnext"');
  assert.equal(gvariantString("tab\there"), '"tab\\there"');
  assert.equal(gvariantString("bell\x07"), '"bell\\a"');
  assert.equal(gvariantString("ctl\u0001x"), '"ctl\\u0001x"');
  assert.equal(gvariantString("nul\u0000x"), '"nul\uFFFDx"');
});

test("buildNotifyArgs leaves the title raw but escapes body markup before quoting", () => {
  const args = buildNotifyArgs({ title: "$HOME <b>x</b>", summary: "$HOME <b>x</b>" });
  assert.equal(args.at(-5), '"$HOME <b>x</b>"');
  assert.equal(args.at(-4), '"$HOME &lt;b&gt;x&lt;/b&gt;"');
});

test("buildNotifyArgs round-trips a Windows path through GVariant quoting", () => {
  const args = buildNotifyArgs({ title: String.raw`C:\Users\me`, summary: "a\\b" });
  assert.equal(args.at(-5), String.raw`"C:\\Users\\me"`);
  assert.equal(args.at(-4), '"a\\\\b"');
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

test("parses the notification id", () => {
  assert.equal(parseNotifyId("(uint32 39,)\n"), 39);
  assert.equal(parseNotifyId("( uint32  41 , )\n"), 41);
  assert.equal(parseNotifyId("error: nothing here\n"), null);
});

test("parses real dbus-monitor action and close blocks", () => {
  const events = [];
  const feed = createSignalParser((event) => events.push(event));
  for (const line of actionBlock(39, "always").split("\n")) feed(line);
  for (const line of closedBlock(40).split("\n")) feed(line);
  assert.deepEqual(events, [
    { id: 39, decision: "always" },
    { id: 40, closed: true },
  ]);
});

test("the signal parser ignores noise, other members and other paths", () => {
  const events = [];
  const feed = createSignalParser((event) => events.push(event));
  feed("Monitoring signals from all objects");
  feed("signal time=1.0 sender=:1.24 -> destination=(null destination) serial=1 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=ActionInvoked");
  feed("   string \"once\"");
  feed("signal time=1.0 sender=:1.24 -> destination=(null destination) serial=2 path=/other; interface=org.freedesktop.Notifications; member=ActionInvoked");
  feed("   uint32 7");
  feed("   string \"once\"");
  feed("method call time=1.0 sender=:1.9 -> destination=org.freedesktop.Notifications serial=3 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify");
  feed("   string \"title\"");
  assert.deepEqual(events, []);
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
  monitorChild(children).stdout.write(actionBlock(7, "once"));
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
  monitorChild(children).stdout.write(closedBlock(11));

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

  monitor.stdout.write(actionBlock(7, "dismiss"));
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
  monitorChild(children).stdout.write(actionBlock(7, "reject"));

  assert.deepEqual(await pending, { id: 7, decision: "reject" });
  assert.equal(errors.length, 1);
  desktop.stop();
});
