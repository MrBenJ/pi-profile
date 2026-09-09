import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { resolvePi } from "../src/process.js";

const exec = promisify(execFile);
let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-native-parser-"));
  await mkdir(join(fixture, "agent"));
});
afterAll(async () => rm(fixture, { recursive: true, force: true }));

test.each(["auth", "uninstall"])("native Pi offline parser recognizes %s as management", async (command) => {
  const target = await resolvePi();
  const result = await exec(target.command, [...target.prefixArgs, "--offline", command, "--help"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(fixture, "agent"), PI_OFFLINE: "1" },
  });
  expect(result.stdout).toContain(`pi ${command}`);
  expect(result.stdout).not.toContain("session_start");
});
