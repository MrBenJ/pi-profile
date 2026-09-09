import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { importProfile, inspectImport } from "../src/import.js";
import { ProfileStore } from "../src/profile-store.js";

let fixture: string;
let source: string;
let store: ProfileStore;
const secretFixture = Buffer.from("opaque-auth-fixture-not-a-real-token");

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "pi-profile-import-"));
  source = join(fixture, "source");
  await mkdir(join(source, "sessions"), { recursive: true });
  await mkdir(join(source, "extensions"));
  await writeFile(join(source, "auth.json"), secretFixture);
  await writeFile(join(source, "sessions", "one.jsonl"), "synthetic session");
  await writeFile(join(source, "extensions", "hello.js"), "export default () => {};", { mode: 0o755 });
  store = new ProfileStore({ profilesRoot: join(fixture, "profiles"), now: () => new Date("2026-09-09T00:00:00.000Z") });
});
afterEach(async () => rm(fixture, { recursive: true, force: true }));

test("copies opaque profile data without changing its source", async () => {
  const before = await stat(join(source, "auth.json"));
  const imported = await importProfile(store, "personal", source);
  expect(await readFile(join(imported.root, "auth.json"))).toEqual(secretFixture);
  expect(await readFile(join(source, "auth.json"))).toEqual(secretFixture);
  expect((await stat(join(source, "auth.json"))).mtimeMs).toBe(before.mtimeMs);
  expect((await lstat(join(imported.root, "extensions", "hello.js"))).mode & 0o111).not.toBe(0);
});

test("preserves contained relative file symlinks", async () => {
  await symlink("sessions/one.jsonl", join(source, "latest"));
  const imported = await importProfile(store, "personal", source);
  expect(await readlink(join(imported.root, "latest"))).toBe("sessions/one.jsonl");
});

test("preserves relative directory symlinks through promotion and profile rename", async () => {
  await symlink("sessions", join(source, "session-link"), "dir");
  const imported = await importProfile(store, "personal", source, { platform: "win32" });
  expect(await readlink(join(imported.root, "session-link"))).toBe("sessions");
  expect(await readFile(join(imported.root, "session-link", "one.jsonl"), "utf8")).toBe("synthetic session");
  await store.rename("personal", "private");
  expect(await readlink(join(fixture, "profiles", "private", "session-link"))).toBe("sessions");
  expect(await readFile(join(fixture, "profiles", "private", "session-link", "one.jsonl"), "utf8")).toBe("synthetic session");
});

test("Windows directory symlink privilege failures are actionable", async () => {
  await symlink("sessions", join(source, "session-link"), "dir");
  const permissionError = Object.assign(new Error("not permitted"), { code: "EPERM" });
  await expect(importProfile(store, "personal", source, {
    platform: "win32",
    createSymlink: async () => { throw permissionError; },
  })).rejects.toMatchObject({ code: "SYMLINK_PERMISSION" });
  await expect(store.get("personal")).rejects.toThrow();
});

test.each([
  ["absolute", (outside: string) => outside],
  ["escaping", () => "../outside.txt"],
  ["dangling", () => "sessions/missing.jsonl"],
] as const)("rejects %s symlinks without touching targets", async (_label, target) => {
  const outside = join(fixture, "outside.txt");
  await writeFile(outside, "keep");
  await symlink(target(outside), join(source, "unsafe"));
  await expect(importProfile(store, "personal", source)).rejects.toThrow(/symlink/i);
  expect(await readFile(outside, "utf8")).toBe("keep");
  await expect(store.get("personal")).rejects.toThrow();
});

test("excludes manager metadata from imported profiles", async () => {
  await writeFile(join(source, ".pi-profile.json"), "source marker");
  await mkdir(join(source, ".pi-profile-leases"));
  await writeFile(join(source, ".pi-profile-leases", "old.json"), "old lease");
  const imported = await importProfile(store, "personal", source);
  expect(JSON.parse(await readFile(join(imported.root, ".pi-profile.json"), "utf8")).name).toBe("personal");
  await expect(readFile(join(imported.root, ".pi-profile-leases", "old.json"))).rejects.toThrow();
});

test("reports but preserves explicit external resource paths", async () => {
  await writeFile(join(source, "settings.json"), JSON.stringify({ extensions: ["/shared/ext.ts"], skills: ["~/shared-skills"], packages: [{ source: "/shared/package" }], sessionDir: "/shared/sessions" }));
  expect((await inspectImport(source)).externalResources).toEqual(["/shared/ext.ts", "~/shared-skills", "/shared/package", "/shared/sessions"]);
  const imported = await importProfile(store, "personal", source);
  expect(JSON.parse(await readFile(join(imported.root, "settings.json"), "utf8")).sessionDir).toBe("/shared/sessions");
});

test("refuses destination collisions and source overlap", async () => {
  await store.create(store.metadata("personal"));
  await expect(importProfile(store, "personal", source)).rejects.toThrow();
  await expect(importProfile(new ProfileStore({ profilesRoot: join(source, "profiles"), now: () => new Date() }), "inside", source)).rejects.toThrow(/overlap/i);
});

test("long copies do not hold the parent mutation lock", async () => {
  let observed = false;
  const imported = await importProfile(store, "personal", source, {
    beforeCopy: async () => {
      if (observed) return;
      observed = true;
      await expect(store.list()).resolves.toEqual([]);
    },
  });
  expect(imported.metadata.name).toBe("personal");
});

test("mid-copy failure leaves no valid destination", async () => {
  let copies = 0;
  await expect(importProfile(store, "personal", source, {
    beforeCopy: () => {
      copies += 1;
      if (copies === 2) throw new Error("injected copy failure");
    },
  })).rejects.toThrow("injected copy failure");
  expect(await readFile(join(source, "auth.json"))).toEqual(secretFixture);
  await expect(store.get("personal")).rejects.toThrow();
});
