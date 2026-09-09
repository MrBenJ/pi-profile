import { parseArgs } from "@earendil-works/pi-coding-agent";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildEnvironment } from "../src/environment.js";
import { acquireLease, inspectLeases } from "../src/lease.js";
import { runPi, resolvePi, sessionArguments, terminalBroadcastsInterrupt } from "../src/process.js";
import { ProfileStore } from "../src/profile-store.js";
import type { LaunchRequest, Profile } from "../src/contracts.js";

let fixture: string;
let profile: Profile;
let capture: string;
const fakePi = resolve(import.meta.dirname, "fixtures/fake-pi.mjs");

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-process-"));
  const store = new ProfileStore({ profilesRoot: join(fixture, "profiles"), now: () => new Date("2026-09-09T00:00:00.000Z") });
  profile = await store.create(store.metadata("work"));
  capture = join(fixture, "capture.json");
});
afterEach(async () => rm(fixture, { recursive: true, force: true }));

function request(piArgs: string[], extra: NodeJS.ProcessEnv = {}): LaunchRequest {
  return { profile, piArgs, cwd: fixture, env: buildEnvironment(profile, { ...process.env, TEST_CAPTURE: capture, ...extra }) };
}

const executable = { command: process.execPath, prefixArgs: [fakePi] };

test("spawns with exact argument vector, cwd, and filtered profile environment", async () => {
  const args = ["-p", "metacharacters ; $HOME &", "--", "- literal", "ユニコード"];
  expect(await runPi(request(args), executable)).toEqual({ code: 0, signal: null });
  const captured = JSON.parse(await readFile(capture, "utf8"));
  expect(captured.argv.slice(-args.length)).toEqual(args);
  expect(captured.argv[0]).toBe("--extension");
  expect(captured.cwd).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(fixture)));
  expect(captured.profile).toBe("work");
  expect(captured.root).toBe(profile.root);
  expect((await inspectLeases(profile)).active).toHaveLength(0);
});

test("injects extension before a separator and not for native management commands", async () => {
  await runPi(request(["--", "prompt"]), executable);
  let captured = JSON.parse(await readFile(capture, "utf8"));
  expect(captured.argv.indexOf("--extension")).toBeLessThan(captured.argv.indexOf("--"));
  for (const args of [["config"], ["auth", "status"], ["uninstall", "npm:pkg"], ["--export", "session.jsonl"]]) {
    await runPi(request(args), executable);
    captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.argv).toEqual(args);
  }
  for (const args of [["--offline", "auth", "--help"], ["-c", "list"], ["--export=session.jsonl"]]) {
    await runPi(request(args), executable);
    captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.argv.slice(-args.length)).toEqual(args);
    expect(captured.argv[0]).toBe("--extension");
  }
});

test("propagates nonzero and signal exits", async () => {
  expect(await runPi(request([], { TEST_EXIT_CODE: "7" }), executable)).toEqual({ code: 7, signal: null });
  if (process.platform !== "win32") {
    expect((await runPi(request([], { TEST_SELF_SIGNAL: "SIGTERM" }), executable)).signal).toBe("SIGTERM");
  }
});

test("terminal SIGINT detection survives redirected stdout and preserves non-TTY propagation", () => {
  expect(terminalBroadcastsInterrupt({ stdin: true, stdout: false, stderr: true }, "darwin", { processGroup: 42, terminalForegroundGroup: 42 })).toBe(true);
  expect(terminalBroadcastsInterrupt({ stdin: true, stdout: false, stderr: false }, "darwin", { processGroup: 42, terminalForegroundGroup: 42 })).toBe(true);
  expect(terminalBroadcastsInterrupt({ stdin: true, stdout: false, stderr: true }, "darwin", { processGroup: 42, terminalForegroundGroup: 99 })).toBe(false);
  expect(terminalBroadcastsInterrupt({ stdin: false, stdout: false, stderr: false }, "darwin", { processGroup: 42, terminalForegroundGroup: 42 })).toBe(true);
  expect(terminalBroadcastsInterrupt({ stdin: false, stdout: false, stderr: false }, "darwin", { processGroup: 42, terminalForegroundGroup: 99 })).toBe(false);
});

test("bare export remains a session while export with a value exits natively", () => {
  const bare = parseArgs(["--export"]);
  expect(bare.export).toBeUndefined();
  expect(bare.unknownFlags.get("export")).toBe(true);
  expect(sessionArguments(["--export"])[0]).toBe("--extension");

  const valid = parseArgs(["--export", "session.html"]);
  expect(valid.export).toBe("session.html");
  expect(valid.unknownFlags.size).toBe(0);
  expect(sessionArguments(["--export", "session.html"])).toEqual(["--export", "session.html"]);
});

test("SIGINT waits for a synthetic child and releases its lease", async () => {
  if (process.platform === "win32") return;
  const running = runPi(request([], { TEST_WAIT_FOR_SIGNAL: "1" }), executable);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(capture);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await access(capture);
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.kill(process.pid, "SIGINT");
  await expect(running).resolves.toEqual({ code: null, signal: "SIGINT" });
  expect((await inspectLeases(profile)).active).toHaveLength(0);
});

test("releases its own lease when publication fails and child exit is proven", async () => {
  const leaseFactory = async (selected: Profile) => {
    const lease = await acquireLease(selected);
    return { ...lease, setChild: async () => { throw new Error("injected publication failure"); } };
  };
  await expect(runPi(request([], { TEST_WAIT_FOR_SIGNAL: "1" }), executable, { leaseFactory })).rejects.toThrow(/exit.*confirmed/i);
  expect(await inspectLeases(profile)).toEqual({ active: [], ambiguous: [], stale: [] });
});

test("retains actionable lease evidence when publication failure child exit is unproven", async () => {
  let retained: Awaited<ReturnType<typeof acquireLease>> | undefined;
  let retainedPath = "";
  const leaseFactory = async (selected: Profile) => {
    const lease = await acquireLease(selected);
    retained = lease;
    retainedPath = join(selected.root, "retained-authoritative", `${lease.lease.id}.json`);
    return {
      ...lease,
      path: retainedPath,
      setChild: async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { await access(capture); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
        }
        await access(capture);
        throw new Error("injected publication failure");
      },
    };
  };
  let failure: Error | undefined;
  try {
    await runPi(request([], { TEST_WAIT_FOR_SIGNAL: "1", TEST_IGNORE_SIGTERM: "1" }), executable, { leaseFactory, publicationDrainMs: 30 });
  } catch (error) {
    failure = error as Error;
  }
  expect(failure?.message).toMatch(/could not be confirmed.*manually remov/i);
  expect(failure?.message).toContain(retained!.lease.id);
  expect(failure?.message).toContain(retainedPath);
  expect((await inspectLeases(profile)).active).toHaveLength(1);
  const child = JSON.parse(await readFile(capture, "utf8")) as { pid: number };
  process.kill(child.pid, "SIGKILL");
  await retained?.release();
});

test.each([
  ["success", {}, { code: 0, signal: null }],
  ["nonzero", { TEST_EXIT_CODE: "7" }, { code: 7, signal: null }],
] as const)("preserves %s child outcome and surfaces lease cleanup warning", async (_label, environment, expected) => {
  const warnings: string[] = [];
  const leaseFactory = async () => ({
    lease: { version: 1 as const, id: "cleanup", hostname: "test", launcherPid: process.pid, childPid: null, createdAt: new Date().toISOString(), state: "starting" as const },
    path: join(profile.root, ".pi-profile-leases", "cleanup.json"),
    setChild: async () => undefined,
    release: async () => { throw new Error("injected release failure"); },
  });
  await expect(runPi(request([], environment), executable, { leaseFactory, onWarning: (message) => warnings.push(message) })).resolves.toEqual(expected);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/lease cleanup.*injected release failure/i);
});

test("preserves signaled child outcome when lease cleanup fails", async () => {
  if (process.platform === "win32") return;
  const warnings: string[] = [];
  const leaseFactory = async () => ({
    lease: { version: 1 as const, id: "cleanup", hostname: "test", launcherPid: process.pid, childPid: null, createdAt: new Date().toISOString(), state: "starting" as const },
    path: join(profile.root, ".pi-profile-leases", "cleanup.json"),
    setChild: async () => undefined,
    release: async () => { throw new Error("injected release failure"); },
  });
  await expect(runPi(request([], { TEST_SELF_SIGNAL: "SIGTERM" }), executable, { leaseFactory, onWarning: (message) => warnings.push(message) })).resolves.toEqual({ code: null, signal: "SIGTERM" });
  expect(warnings[0]).toMatch(/lease cleanup/i);
});

test("preserves publication failure as primary when lease cleanup also fails", async () => {
  const primaryLease = {
    lease: { version: 1 as const, id: "cleanup", hostname: "test", launcherPid: process.pid, childPid: null, createdAt: new Date().toISOString(), state: "starting" as const },
    path: join(profile.root, ".pi-profile-leases", "cleanup.json"),
    setChild: async () => { throw new Error("injected publication failure"); },
    release: async () => { throw new Error("injected release failure"); },
  };
  let failure: unknown;
  try {
    await runPi(request([], { TEST_WAIT_FOR_SIGNAL: "1" }), executable, { leaseFactory: async () => primaryLease });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).cause).toMatchObject({ code: "LEASE_PUBLICATION_FAILED" });
  expect((failure as AggregateError).errors[1]).toMatchObject({ message: "injected release failure" });
});

test("reports spawn failures and releases its lease", async () => {
  await expect(runPi(request([]), { command: join(fixture, "missing-pi"), prefixArgs: [] })).rejects.toThrow(/start Pi/i);
  expect((await inspectLeases(profile)).active).toHaveLength(0);
});

test("supports concurrent same-profile launches with distinct leases", async () => {
  const otherCapture = join(fixture, "capture-2.json");
  const second = { ...request([]), env: { ...request([]).env, TEST_CAPTURE: otherCapture } };
  await Promise.all([runPi(request([]), executable), runPi(second, executable)]);
  expect((await inspectLeases(profile)).active).toHaveLength(0);
});

describe("Pi resolution", () => {
  test.each([
    ["global", (pathDirectory: string) => join(pathDirectory, "node_modules", "@earendil-works", "pi-coding-agent")],
    ["local", (pathDirectory: string) => join(pathDirectory, "..", "@earendil-works", "pi-coding-agent")],
  ] as const)("resolves a %s Windows npm shim from package bin metadata without a shell", async (_layout, packagePath) => {
    const pathDirectory = join(fixture, "node_modules", ".bin");
    const shim = join(pathDirectory, "pi.cmd");
    const packageRoot = packagePath(pathDirectory);
    const bundle = join(packageRoot, "custom", "pi-entry.js");
    await mkdir(pathDirectory, { recursive: true });
    await mkdir(join(bundle, ".."), { recursive: true });
    await writeFile(shim, "@echo off\r\n");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ bin: { pi: "custom/pi-entry.js" } }));
    await writeFile(bundle, "// synthetic Pi entrypoint\n");
    await expect(resolvePi({ Path: pathDirectory }, "win32")).resolves.toEqual({ command: process.execPath, prefixArgs: [bundle] });
  });

  test("rejects an escaping Windows package bin target", async () => {
    const pathDirectory = join(fixture, "bin");
    const packageRoot = join(pathDirectory, "node_modules", "@earendil-works", "pi-coding-agent");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(pathDirectory, "pi.cmd"), "@echo off\r\n");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ bin: { pi: "../../../../../outside.js" } }));
    await writeFile(join(fixture, "outside.js"), "// must not execute\n");
    await expect(resolvePi({ PATH: pathDirectory }, "win32")).rejects.toThrow(/unsupported Pi command wrapper/i);
  });

  test("finds an executable from PATH without a shell", async () => {
    const resolved = await resolvePi(process.env, process.platform);
    expect(resolved.command).toBeTruthy();
    expect(resolved.prefixArgs).toBeInstanceOf(Array);
  });
  test("fails clearly when PATH contains no Pi", async () => {
    await expect(resolvePi({ PATH: fixture }, process.platform)).rejects.toThrow(/install Pi/i);
  });
});
