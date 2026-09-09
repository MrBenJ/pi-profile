import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import extension from "../src/extension.js";

let previousName: string | undefined;
let previousRoot: string | undefined;
beforeEach(() => {
  previousName = process.env.PI_PROFILE_NAME;
  previousRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_PROFILE_NAME = "work";
  process.env.PI_CODING_AGENT_DIR = resolve("/profiles/work");
});
afterEach(() => {
  if (previousName === undefined) delete process.env.PI_PROFILE_NAME; else process.env.PI_PROFILE_NAME = previousName;
  if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousRoot;
});

function harness(mode: "tui" | "rpc" | "json" | "print" = "tui", hasUI = mode === "tui" || mode === "rpc") {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, { handler: Function }>();
  const ui = { setStatus: vi.fn(), setTitle: vi.fn(), notify: vi.fn() };
  const api = {
    on: vi.fn((event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
    registerCommand: vi.fn((name: string, command: { handler: Function }) => commands.set(name, command)),
    appendEntry: () => { throw new Error("transcript API called"); },
    sendMessage: () => { throw new Error("model-context API called"); },
    registerTool: () => { throw new Error("tool API called"); },
  };
  extension(api as never);
  const ctx = { ui, mode, hasUI, cwd: "/code/project" };
  return { handlers, commands, ui, ctx };
}

test.each(["startup", "reload", "new", "resume", "fork"])("reapplies indicators on %s", async (reason) => {
  const { handlers, ui, ctx } = harness();
  await handlers.get("session_start")?.[0]?.({ reason }, ctx);
  expect(ui.setStatus).toHaveBeenCalledWith("pi-profile", "profile: work");
  expect(ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("[work]"));
  expect(ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("project"));
});

test("registers a read-only profile command using transient UI", async () => {
  const { commands, ui, ctx } = harness();
  expect(commands.has("profile")).toBe(true);
  await commands.get("profile")?.handler("", ctx);
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("work"), "info");
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(process.env.PI_CODING_AGENT_DIR!), "info");
  await commands.get("profile")?.handler("personal", ctx);
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("cannot switch"), "warning");
});

test.each(["json", "print"] as const)("is a UI no-op in %s mode", async (mode) => {
  const { handlers, ui, ctx } = harness(mode, false);
  await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
  expect(ui.setStatus).not.toHaveBeenCalled();
  expect(ui.setTitle).not.toHaveBeenCalled();
});

test("RPC uses supported status UI but avoids terminal title", async () => {
  const { handlers, ui, ctx } = harness("rpc", true);
  await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
  expect(ui.setStatus).toHaveBeenCalledWith("pi-profile", "profile: work");
  expect(ui.setTitle).not.toHaveBeenCalled();
});

test.each([
  [undefined, "/profiles/work"],
  ["Work", "/profiles/work"],
  ["work", "relative/root"],
])("quietly avoids indicators for malformed markers", async (name, root) => {
  if (name === undefined) delete process.env.PI_PROFILE_NAME; else process.env.PI_PROFILE_NAME = name;
  process.env.PI_CODING_AGENT_DIR = root;
  const { handlers, ui, ctx } = harness();
  if (name === undefined) delete process.env.PI_PROFILE_NAME; else process.env.PI_PROFILE_NAME = name;
  process.env.PI_CODING_AGENT_DIR = root;
  await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
  expect(ui.setStatus).not.toHaveBeenCalled();
});

test("coexists by setting only its namespaced status key", async () => {
  const { handlers, ui, ctx } = harness();
  await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
  expect(ui.setStatus).toHaveBeenCalledTimes(1);
  expect(ui.setStatus.mock.calls[0]?.[0]).toBe("pi-profile");
});
