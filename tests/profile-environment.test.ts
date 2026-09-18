import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applyProfileEnvironment } from "../src/profile-environment.js";
import { ProfileError } from "../src/contracts.js";
import type { Profile } from "../src/contracts.js";

let fixture: string;
let profile: Profile;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-env-"));
  const root = join(fixture, "profile-root");
  await mkdir(root);
  profile = { root, metadata: { version: 1, name: "work", defaultCwd: null, inheritEnvironment: [], createdAt: "2026-09-09T00:00:00.000Z" } };
});
afterEach(async () => rm(fixture, { recursive: true, force: true }));

const envPath = () => join(profile.root, ".env");
async function writeEnv(contents: string, mode = 0o600): Promise<void> {
  await writeFile(envPath(), contents, { mode });
  await chmod(envPath(), mode);
}

async function expectRejection(base: NodeJS.ProcessEnv, options?: Parameters<typeof applyProfileEnvironment>[2]): Promise<ProfileError> {
  try {
    await applyProfileEnvironment(profile, base, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileError);
    return error as ProfileError;
  }
  throw new Error("expected applyProfileEnvironment to reject");
}

test("missing .env returns a copy of the base environment unchanged", async () => {
  const base = { PATH: "/synthetic/bin", HOME: "/home/person" };
  const result = await applyProfileEnvironment(profile, base);
  expect(result).toEqual(base);
  expect(result).not.toBe(base);
});

test("valid 0600 regular file is loaded and its values applied", async () => {
  await writeEnv("PROFILE_ORDINARY=applied\n");
  const result = await applyProfileEnvironment(profile, { PATH: "/synthetic/bin" });
  expect(result.PROFILE_ORDINARY).toBe("applied");
  expect(result.PATH).toBe("/synthetic/bin");
});

test("profile values override inherited ordinary variables", async () => {
  await writeEnv("SHARED=from-profile\n");
  const result = await applyProfileEnvironment(profile, { SHARED: "from-parent", PATH: "/synthetic/bin" });
  expect(result.SHARED).toBe("from-profile");
});

test("a provider credential absent from base and .env is not resurrected", async () => {
  await writeEnv("PROFILE_ORDINARY=applied\n");
  const result = await applyProfileEnvironment(profile, { PATH: "/synthetic/bin" });
  expect(result.OPENAI_API_KEY).toBeUndefined();
});

test("a provider credential from the profile .env is present without allowlisting", async () => {
  await writeEnv("OPENAI_API_KEY=synthetic-profile-key\n");
  const result = await applyProfileEnvironment(profile, { PATH: "/synthetic/bin" });
  expect(result.OPENAI_API_KEY).toBe("synthetic-profile-key");
});

test("an inherited allowlisted value is preserved when .env does not touch it", async () => {
  await writeEnv("PROFILE_ORDINARY=applied\n");
  const result = await applyProfileEnvironment(profile, { AWS_PROFILE: "synthetic-work", PATH: "/synthetic/bin" });
  expect(result.AWS_PROFILE).toBe("synthetic-work");
});

test("PI_CODING_AGENT_DIR declared in .env is rejected and never overrides routing", async () => {
  await writeEnv("PI_CODING_AGENT_DIR=/evil/root\n");
  const error = await expectRejection({ PI_CODING_AGENT_DIR: profile.root });
  expect(error.message).not.toContain("/evil/root");
});

test("PI_PROFILE_NAME declared in .env is rejected", async () => {
  await writeEnv("PI_PROFILE_NAME=impersonated\n");
  const error = await expectRejection({ PI_PROFILE_NAME: "work" });
  expect(error.message).not.toContain("impersonated");
});

test("reserved routing names are compared case-insensitively on Windows", async () => {
  await writeEnv("pi_coding_agent_dir=/evil/root\n");
  await expectRejection({}, { platform: "win32" });
});

test("a lowercased routing name is an ordinary variable on POSIX", async () => {
  await writeEnv("pi_coding_agent_dir=/synthetic/other\n");
  const result = await applyProfileEnvironment(profile, {}, { platform: "linux" });
  expect(result.pi_coding_agent_dir).toBe("/synthetic/other");
  expect(result.PI_CODING_AGENT_DIR).toBe(profile.root);
});

test("routing variables are reasserted to authoritative values", async () => {
  await writeEnv("PROFILE_ORDINARY=applied\n");
  const result = await applyProfileEnvironment(profile, { PI_CODING_AGENT_DIR: profile.root, PI_PROFILE_NAME: "work" });
  expect(result.PI_CODING_AGENT_DIR).toBe(profile.root);
  expect(result.PI_PROFILE_NAME).toBe("work");
});

test("a symlinked .env is rejected", async () => {
  const target = join(fixture, "target-env");
  await writeFile(target, "OPENAI_API_KEY=synthetic-profile-key\n", { mode: 0o600 });
  await symlink(target, envPath());
  const error = await expectRejection({});
  expect(error.message).not.toContain("synthetic-profile-key");
});

test("a directory at the .env path is rejected as not a regular file", async () => {
  await mkdir(envPath());
  await expectRejection({});
});

test("a group- or world-accessible .env is rejected", async () => {
  await writeEnv("OPENAI_API_KEY=synthetic-profile-key\n", 0o644);
  const error = await expectRejection({}, { platform: "linux" });
  expect(error.message).not.toContain("synthetic-profile-key");
});

test("a .env owned by another user is rejected where ownership can be checked", async () => {
  await writeEnv("OPENAI_API_KEY=synthetic-profile-key\n");
  const foreignUid = (typeof process.getuid === "function" ? process.getuid() : 0) + 1;
  const error = await expectRejection({}, { platform: "linux", currentUid: foreignUid });
  expect(error.message).not.toContain("synthetic-profile-key");
});

test("ownership is not checked when no uid is resolvable", async () => {
  await writeEnv("PROFILE_ORDINARY=applied\n");
  const result = await applyProfileEnvironment(profile, {}, { platform: "linux", currentUid: null });
  expect(result.PROFILE_ORDINARY).toBe("applied");
});

test("a .env larger than the size limit is rejected", async () => {
  const oversized = `BIG=${"x".repeat(64 * 1024 + 1)}\n`;
  await writeEnv(oversized);
  const error = await expectRejection({});
  expect(error.message).not.toContain("xxxx");
});

test("malformed dotenv syntax that would silently drop a variable is rejected", async () => {
  await writeEnv("SECRET_TOKEN=synthetic-super-secret-value\nBARE_NAME_NO_EQUALS\n");
  const error = await expectRejection({});
  expect(error.message).not.toContain("synthetic-super-secret-value");
  expect(error.message).not.toContain("BARE_NAME_NO_EQUALS");
});

test("error messages name the file path but never its contents", async () => {
  await writeEnv("SECRET_TOKEN=synthetic-super-secret-value\n=missing-name\n");
  const error = await expectRejection({});
  expect(error.message).toContain(envPath());
  expect(error.message).not.toContain("synthetic-super-secret-value");
});

test("command-substitution and expansion syntax is passed through as an inert literal", async () => {
  await writeEnv("LITERAL=$(whoami)\nEXPANDED=${HOME}\n");
  const result = await applyProfileEnvironment(profile, {});
  expect(result.LITERAL).toBe("$(whoami)");
  expect(result.EXPANDED).toBe("${HOME}");
});

test("a multiline double-quoted value is accepted as parseEnv accepts it", async () => {
  await writeEnv('CERT="-----BEGIN-----\nline2\nline3\n-----END-----"\nNEXT=ok\n');
  const result = await applyProfileEnvironment(profile, {});
  expect(result.CERT).toBe("-----BEGIN-----\nline2\nline3\n-----END-----");
  expect(result.NEXT).toBe("ok");
});

test("a multiline single-quoted value is accepted", async () => {
  await writeEnv("BLOCK='alpha\nbeta'\nNEXT=ok\n");
  const result = await applyProfileEnvironment(profile, {});
  expect(result.BLOCK).toBe("alpha\nbeta");
  expect(result.NEXT).toBe("ok");
});

test("Windows case-colliding names apply in file order so the last assignment wins", async () => {
  await writeEnv("path=first\nPATH=second\n");
  const result = await applyProfileEnvironment(profile, {}, { platform: "win32" });
  expect(result.PATH).toBe("second");
  expect(Object.keys(result).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
});

test("an unterminated quoted value is rejected rather than silently truncated", async () => {
  await writeEnv('SECRET_TOKEN="synthetic-super-secret-value\nMORE\n');
  const error = await expectRejection({});
  expect(error.message).not.toContain("synthetic-super-secret-value");
});

test("a value containing a NUL byte is rejected before it can reach spawn", async () => {
  await writeEnv("SECRET_TOKEN=synthetic-super-secret\u0000value\n");
  const error = await expectRejection({});
  expect(error.message).not.toContain("synthetic-super-secret");
  expect(error.message).not.toContain("\u0000");
});

test("a space-separated export prefix is stripped and the assignment applied", async () => {
  await writeEnv("export EXPORTED=applied\n");
  const result = await applyProfileEnvironment(profile, {});
  expect(result.EXPORTED).toBe("applied");
});

test("a tab-separated export prefix is rejected rather than silently dropped", async () => {
  await writeEnv("export\tSECRET_TOKEN=synthetic-super-secret-value\n");
  const error = await expectRejection({});
  expect(error.message).not.toContain("synthetic-super-secret-value");
});

test("a multiline backtick-quoted value is accepted as parseEnv accepts it", async () => {
  await writeEnv("BLOCK=`alpha\nbeta`\nNEXT=ok\n");
  const result = await applyProfileEnvironment(profile, {});
  expect(result.BLOCK).toBe("alpha\nbeta");
  expect(result.NEXT).toBe("ok");
});

test("a __proto__ variable name is rejected rather than dropped or polluting the prototype", async () => {
  await writeEnv("__proto__=synthetic-value\nNEXT=ok\n");
  const error = await expectRejection({});
  expect(error.message).not.toContain("synthetic-value");
});

test("content after a closed quoted value is rejected rather than silently dropped", async () => {
  await writeEnv('TOKEN="one" OTHER=synthetic-super-secret\n');
  const error = await expectRejection({});
  expect(error.message).not.toContain("synthetic-super-secret");
});

test("a trailing comment after a quoted value is accepted", async () => {
  await writeEnv('KEY="v" # trailing comment\nNEXT=ok\n');
  const result = await applyProfileEnvironment(profile, {});
  expect(result.KEY).toBe("v");
  expect(result.NEXT).toBe("ok");
});

test("the input base environment object is not mutated", async () => {
  await writeEnv("SHARED=from-profile\nNEWVAR=added\n");
  const base = { SHARED: "from-parent", PATH: "/synthetic/bin" };
  const snapshot = { ...base };
  await applyProfileEnvironment(profile, base);
  expect(base).toEqual(snapshot);
});
