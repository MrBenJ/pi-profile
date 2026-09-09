import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildEnvironment } from "../src/environment.js";
import { acquireLease, inspectLeases } from "../src/lease.js";
import { runPi, resolvePi } from "../src/process.js";
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
  for (const args of [["config"], ["auth", "status"], ["uninstall", "npm:pkg"], ["--offline", "auth", "--help"]]) {
    await runPi(request(args), executable);
    captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.argv).toEqual(args);
  }
});

test("propagates nonzero and signal exits", async () => {
  expect(await runPi(request([], { TEST_EXIT_CODE: "7" }), executable)).toEqual({ code: 7, signal: null });
  if (process.platform !== "win32") {
    expect((await runPi(request([], { TEST_SELF_SIGNAL: "SIGTERM" }), executable)).signal).toBe("SIGTERM");
  }
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

test("drains a child after lease publication failure and retains the conservative lease", async () => {
  let retained: Awaited<ReturnType<typeof acquireLease>> | undefined;
  const leaseFactory = async (selected: Profile) => {
    const lease = await acquireLease(selected);
    retained = lease;
    return { ...lease, setChild: async () => { throw new Error("injected publication failure"); } };
  };
  await expect(runPi(request([], { TEST_WAIT_FOR_SIGNAL: "1" }), executable, { leaseFactory })).rejects.toThrow(/lease.*recorded/i);
  expect((await inspectLeases(profile)).active).toHaveLength(1);
  await retained?.release();
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
    ["global", (pathDirectory: string) => join(pathDirectory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")],
    ["local", (pathDirectory: string) => join(pathDirectory, "..", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")],
  ] as const)("resolves a %s Windows npm shim without a shell", async (_layout, bundlePath) => {
    const pathDirectory = join(fixture, "node_modules", ".bin");
    const shim = join(pathDirectory, "pi.cmd");
    const bundle = bundlePath(pathDirectory);
    await mkdir(pathDirectory, { recursive: true });
    await mkdir(join(bundle, ".."), { recursive: true });
    await writeFile(shim, "@echo off\r\n");
    await writeFile(bundle, "// synthetic Pi entrypoint\n");
    await expect(resolvePi({ Path: pathDirectory }, "win32")).resolves.toEqual({ command: process.execPath, prefixArgs: [bundle] });
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
