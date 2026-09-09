import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
let fixture: string;
let home: string;
let fakeBin: string;
let environment: NodeJS.ProcessEnv;

beforeAll(async () => {
  await exec(process.execPath, [resolve(repository, "node_modules/typescript/bin/tsc")], { cwd: repository });
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-e2e-"));
  home = join(fixture, "home");
  fakeBin = join(fixture, "bin");
  await mkdir(home);
  await mkdir(fakeBin);
  const fakeSource = resolve(repository, "tests/fixtures/fake-pi.mjs");
  if (process.platform === "win32") {
    const bundle = join(fakeBin, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(join(bundle, ".."), { recursive: true });
    await copyFile(fakeSource, bundle);
    await writeFile(join(fakeBin, "pi.cmd"), "@echo off\r\n");
  } else {
    await copyFile(fakeSource, join(fakeBin, "pi"));
    await chmod(join(fakeBin, "pi"), 0o755);
  }
  environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "synthetic-parent-key",
    TEST_ORDINARY: "preserved",
  };
});
afterAll(async () => rm(fixture, { recursive: true, force: true }));

const cli = (...args: string[]) => exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), ...args], { cwd: fixture, env: environment });

test("built CLI keeps work and personal roots independent during concurrent launches", async () => {
  const unprofiled = join(home, ".pi", "agent", "settings.json");
  await mkdir(join(unprofiled, ".."), { recursive: true });
  await writeFile(unprofiled, '{"unprofiled":true}\n');
  const before = await readFile(unprofiled, "utf8");

  await cli("create", "work");
  await cli("create", "personal");
  const workCwd = join(fixture, "work cwd");
  const personalCwd = join(fixture, "personal cwd");
  await mkdir(workCwd); await mkdir(personalCwd);
  await cli("config", "work", "--default-cwd", workCwd);
  await cli("config", "personal", "--default-cwd", personalCwd);

  const workCapture = join(fixture, "work.json");
  const personalCapture = join(fixture, "personal.json");
  await Promise.all([
    exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), "work", "--session-dir", "/explicit/work", "--", "work prompt"], { cwd: fixture, env: { ...environment, TEST_CAPTURE: workCapture } }),
    exec(process.execPath, [resolve(repository, "bin/pi-profile.js"), "personal", "--fork", "/explicit/personal.jsonl", "--", "personal prompt"], { cwd: fixture, env: { ...environment, TEST_CAPTURE: personalCapture } }),
  ]);

  const work = JSON.parse(await readFile(workCapture, "utf8"));
  const personal = JSON.parse(await readFile(personalCapture, "utf8"));
  expect(work.root).not.toBe(personal.root);
  expect(work.cwd).toBe(await realpath(workCwd));
  expect(personal.cwd).toBe(await realpath(personalCwd));
  expect(work.argv).toContain("/explicit/work");
  expect(personal.argv).toContain("/explicit/personal.jsonl");
  expect(work.openaiPresent).toBe(false);
  expect(personal.openaiPresent).toBe(false);
  expect(work.ordinary).toBe("preserved");
  expect(await readFile(unprofiled, "utf8")).toBe(before);
});
