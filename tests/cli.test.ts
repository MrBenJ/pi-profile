import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, parseCli, type CliDependencies } from "../src/cli.js";
import { ProfileStore } from "../src/profile-store.js";
import type { LaunchRequest, Profile } from "../src/contracts.js";

let fixture: string;
let store: ProfileStore;
let stdout: string[];
let stderr: string[];
let launched: LaunchRequest[];
let imported: string[];
let deps: CliDependencies;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-cli-"));
  store = new ProfileStore({ profilesRoot: join(fixture, "profiles"), now: () => new Date("2026-09-09T00:00:00.000Z") });
  stdout = []; stderr = []; launched = []; imported = [];
  deps = {
    store,
    runPi: async (request) => { launched.push(request); return { code: 0, signal: null }; },
    inspectImport: async () => ({ externalResources: ["/shared/extension.ts"] }),
    importProfile: async (targetStore, name) => { imported.push(name); return targetStore.create(targetStore.metadata(name)); },
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    isTTY: false,
    cwd: fixture,
    env: { PATH: "/synthetic", OPENAI_API_KEY: "fake" },
    home: fixture,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
});
afterEach(async () => rm(fixture, { recursive: true, force: true }));

const create = (name: string) => store.create(store.metadata(name));

describe("parseCli", () => {
  test("preserves every argument after the profile", () => {
    expect(parseCli(["--cwd", "/repo", "work", "-p", "--", "- literal"])).toEqual({ command: "launch", profile: "work", cwd: "/repo", piArgs: ["-p", "--", "- literal"] });
  });
  test.each([
    [["--help"], { command: "help" }],
    [["-h"], { command: "help" }],
    [["help"], { command: "help" }],
    [["--version"], { command: "version" }],
    [["-v"], { command: "version" }],
    [["create", "work"], { command: "create", name: "work" }],
    [["list"], { command: "list" }],
    [["recover"], { command: "recover" }],
    [["show", "work"], { command: "show", name: "work" }],
    [["rename", "work", "office", "--clear-stale-leases"], { command: "rename", oldName: "work", newName: "office", clearStaleLeases: true }],
    [["remove", "work", "--force"], { command: "remove", name: "work", force: true, clearStaleLeases: false }],
    [["import", "personal", "/source", "--yes"], { command: "import", name: "personal", source: "/source", yes: true }],
    [["config", "work", "--pi"], { command: "config", name: "work", operation: { type: "pi" } }],
    [["config", "work", "--default-cwd", "/repo"], { command: "config", name: "work", operation: { type: "default-cwd", path: "/repo" } }],
    [["config", "work", "--clear-default-cwd"], { command: "config", name: "work", operation: { type: "clear-default-cwd" } }],
    [["config", "work", "--inherit", "AWS_PROFILE"], { command: "config", name: "work", operation: { type: "inherit", name: "AWS_PROFILE" } }],
    [["config", "work", "--no-inherit", "AWS_PROFILE"], { command: "config", name: "work", operation: { type: "no-inherit", name: "AWS_PROFILE" } }],
  ] as const)("parses %j", (argv, expected) => expect(parseCli([...argv])).toEqual(expected));
});

test("--cwd before a manager command reports a clear usage error", () => {
  expect(() => parseCli(["--cwd", fixture, "config"])).toThrow(/--cwd.*profile.*management/i);
  expect(() => parseCli([`--cwd=${fixture}`, "recover"])).toThrow(/--cwd.*profile.*management/i);
});

test("production dependency construction failures are contained by main", async () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(main(["--help"], undefined, () => { throw Object.assign(new Error("cwd is unavailable"), { code: "ENOENT" }); })).resolves.toBe(2);
    expect(write.mock.calls.flat().join("")).toContain("cwd is unavailable");
  } finally {
    write.mockRestore();
  }
});

test("help and version are usable without profiles", async () => {
  expect(await main(["--help"], deps)).toBe(0);
  expect(stdout.join("\n")).toContain("Usage: pi-profile");
  expect(stdout.join("\n")).toContain("--clear-stale-leases");
  stdout = [];
  expect(await main(["--version"], deps)).toBe(0);
  expect(stdout).toEqual(["1.0.1"]);
});

test("create, list, show, and rename avoid secret-bearing contents", async () => {
  expect(await main(["create", "work"], deps)).toBe(0);
  expect(await main(["list"], deps)).toBe(0);
  expect(await main(["show", "work"], deps)).toBe(0);
  expect(stdout.join("\n")).not.toContain("auth.json");
  expect(await main(["rename", "work", "office"], deps)).toBe(0);
  expect((await store.get("office")).metadata.name).toBe("office");
});

test("list and picker report invalid roots while preserving healthy profiles", async () => {
  await create("healthy");
  const broken = join(store.profilesRoot, "broken");
  await mkdir(broken);
  await writeFile(join(broken, ".pi-profile.json"), "{bad-json");
  expect(await main(["list"], deps)).toBe(0);
  expect(stdout.join("\n")).toContain("healthy");
  expect(stderr.join("\n")).toContain(broken);
  expect(stderr.join("\n")).toMatch(/inspect.*manually/i);

  let choices: string[] = [];
  deps = { ...deps, isTTY: true, select: async (_title, values) => { choices = values; return "healthy"; } };
  expect(await main([], deps)).toBe(0);
  expect(choices).toEqual(["healthy"]);
  expect(launched).toHaveLength(1);
  await expect(writeFile(join(broken, "still-present"), "yes")).resolves.toBeUndefined();
});

test("show reports exact ambiguous lease evidence and manual guidance", async () => {
  const profile = await create("work");
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases);
  const leasePath = join(leases, "starting.json");
  await writeFile(leasePath, JSON.stringify({ version: 1, id: "starting", hostname: hostname(), launcherPid: 2147483647, childPid: null, createdAt: new Date().toISOString(), state: "starting" }));
  expect(await main(["show", "work"], deps)).toBe(0);
  expect(stdout.join("\n")).toContain(leasePath);
  expect(stdout.join("\n")).toContain("starting");
  expect(stdout.join("\n")).toMatch(/inspect.*manually/i);
});

test("corrupt lease show failure names the retained file and manual safety rule", async () => {
  const profile = await create("work");
  const leases = join(profile.root, ".pi-profile-leases");
  await mkdir(leases);
  const leasePath = join(leases, "corrupt.json");
  await writeFile(leasePath, "{broken");
  expect(await main(["show", "work"], deps)).toBe(2);
  expect(stderr.join("\n")).toContain(leasePath);
  expect(stderr.join("\n")).toMatch(/inspect.*manually.*do not remove/i);
  expect(await readFile(leasePath, "utf8")).toBe("{broken");
});

test("remove requires exact typed confirmation unless forced", async () => {
  await create("work");
  deps = { ...deps, isTTY: true, input: async () => "wrong" };
  expect(await main(["remove", "work"], deps)).toBe(1);
  expect(stderr.join("\n")).toContain("Cancelled");
  await expect(store.get("work")).resolves.toBeDefined();
  expect(await main(["remove", "work", "--force"], deps)).toBe(0);
});

test("import reports scope and requires yes noninteractively", async () => {
  expect(await main(["import", "personal", fixture], deps)).not.toBe(0);
  expect(imported).toEqual([]);
  expect(await main(["import", "personal", fixture, "--yes"], deps)).toBe(0);
  expect(stdout.join("\n")).toContain("/shared/extension.ts");
});

test("explicit recover command invokes conservative store recovery", async () => {
  expect(await main(["recover"], deps)).toBe(0);
  expect(stdout.join("\n")).toContain("Recovery complete");
});

test("concurrent inherited-name config updates retain both changes", async () => {
  await create("work");
  expect(await Promise.all([
    main(["config", "work", "--inherit", "FIRST_KEY"], deps),
    main(["config", "work", "--inherit", "SECOND_KEY"], deps),
  ])).toEqual([0, 0]);
  expect((await store.get("work")).metadata.inheritEnvironment).toEqual(["FIRST_KEY", "SECOND_KEY"]);
});

test("config edits metadata and native pi config launches under the profile", async () => {
  await create("work");
  expect(await main(["config", "work", "--default-cwd", fixture], deps)).toBe(0);
  expect(await main(["config", "work", "--inherit", "AWS_PROFILE"], deps)).toBe(0);
  expect((await store.get("work")).metadata).toMatchObject({ defaultCwd: fixture, inheritEnvironment: ["AWS_PROFILE"] });
  expect(await main(["config", "work", "--no-inherit", "AWS_PROFILE"], deps)).toBe(0);
  expect(await main(["config", "work", "--clear-default-cwd"], deps)).toBe(0);
  expect(await main(["config", "work", "--pi"], deps)).toBe(0);
  expect(launched.at(-1)?.piArgs).toEqual(["config"]);
});

test("config --pi maps signal exits the same way as profile launch", async () => {
  await create("work");
  deps = { ...deps, runPi: async () => ({ code: null, signal: "SIGTERM" }) };
  expect(await main(["config", "work", "--pi"], deps)).toBe(143);
});

test("rejects reserved routing inheritance", async () => {
  await create("work");
  expect(await main(["config", "work", "--inherit", "PI_CODING_AGENT_DIR"], deps)).not.toBe(0);
});

test("bare launch uses picker only with a TTY and cancellation mutates nothing", async () => {
  expect(await main([], deps)).not.toBe(0);
  await create("work");
  deps = { ...deps, isTTY: true, select: async () => undefined };
  expect(await main([], deps)).toBe(1);
  expect(stderr.join("\n")).toContain("Cancelled");
  expect(launched).toEqual([]);
});

test("interactive import and config cancellation are explicit", async () => {
  deps = { ...deps, isTTY: true, confirm: async () => false };
  expect(await main(["import", "personal", fixture], deps)).toBe(1);
  expect(stderr.join("\n")).toContain("Cancelled");
  await create("work");
  stderr = [];
  deps = { ...deps, select: async () => undefined };
  expect(await main(["config", "work"], deps)).toBe(1);
  expect(stderr.join("\n")).toContain("Cancelled");
});

test("explicit launch rejects unknown profiles and forwards native Pi management", async () => {
  expect(await main(["missing"], deps)).not.toBe(0);
  expect(stderr.join("\n")).toContain("pi-profile create missing");
  await create("work");
  expect(await main(["work", "install", "npm:pkg"], deps)).toBe(0);
  expect(launched[0]?.piArgs).toEqual(["install", "npm:pkg"]);
});

test("interactive missing values are collected and noninteractive calls never hang", async () => {
  expect(await main(["create"], deps)).not.toBe(0);
  deps = { ...deps, isTTY: true, input: async () => "work" };
  expect(await main(["create"], deps)).toBe(0);
});
