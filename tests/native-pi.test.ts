import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, test } from "vitest";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
let fixture: string;
let environment: NodeJS.ProcessEnv;
const cli = (...args: string[]) => exec(process.execPath, [join(repository, "bin", "pi-profile.js"), ...args], {
  cwd: fixture,
  env: environment,
});

beforeAll(async () => {
  await exec(process.execPath, [join(repository, "node_modules", "typescript", "bin", "tsc")], { cwd: repository });
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-native-parser-"));
  const home = join(fixture, "home");
  await mkdir(home);
  environment = { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: "1" };
  await cli("create", "work");
});
afterAll(async () => rm(fixture, { recursive: true, force: true }));

test("native parseArgs distinguishes supported export syntax from equals-form extension flags", () => {
  const supported = parseArgs(["--export", "session.jsonl"]);
  expect(supported.export).toBe("session.jsonl");
  expect(supported.unknownFlags.size).toBe(0);

  const equalsForm = parseArgs(["--export=session.jsonl"]);
  expect(equalsForm.export).toBeUndefined();
  expect(equalsForm.unknownFlags.get("export")).toBe("session.jsonl");
});

test.each([
  ["auth", ["auth", "--help"], ["pi auth print-api-key", "Auth commands require"]],
  ["uninstall", ["uninstall", "--help"], ["Alias: pi uninstall", "pi remove <source>"]],
] as const)("built launcher preserves argv[0] native %s help dispatch", async (_command, args, uniqueOutput) => {
  const result = await cli("work", ...args);
  for (const expected of uniqueOutput) expect(result.stdout).toContain(expected);
  expect(result.stdout).not.toContain("AI coding assistant with read, bash, edit, write tools");
});

test("built launcher executes native auth non-help behavior with offline temporary state", async () => {
  let failure: (Error & { code?: number; stdout?: string }) | undefined;
  try {
    await cli("work", "auth", "check", "--provider", "openai", "--json", "--no-refresh");
  } catch (error) {
    failure = error as Error & { code?: number; stdout?: string };
  }
  expect(failure?.code).toBe(1);
  expect(JSON.parse(failure?.stdout ?? "{}")).toEqual({
    status: "not_ready",
    provider: "openai",
    reason: "credentials_not_configured",
  });
});
