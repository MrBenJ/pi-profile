import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildEnvironment } from "../src/environment.js";
import { classifyInvocation } from "../src/launch-policy.js";
import type { Profile } from "../src/contracts.js";

test("does not invent strict skill or session exclusions", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-profile-resources-"));
  try {
    const home = join(fixture, "home");
    const root = join(fixture, "profiles", "work");
    const project = join(fixture, "project");
    const resources = [
      join(home, ".agents", "skills", "ambient", "SKILL.md"),
      join(root, "skills", "profile", "SKILL.md"),
      join(project, ".pi", "skills", "trusted", "SKILL.md"),
    ];
    for (const path of resources) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "synthetic skill");
    }
    const profile: Profile = { root, metadata: { version: 1, name: "work", defaultCwd: null, inheritEnvironment: [], createdAt: "2026-09-09T00:00:00.000Z" } };
    const env = buildEnvironment(profile, { HOME: home, PI_CODING_AGENT_SESSION_DIR: join(fixture, "explicit-sessions") });
    const forwarded = ["--session-dir", "/explicit", "--extension", "/shared/extension.ts", "--", "prompt"];
    expect(classifyInvocation(forwarded)).toBe("session");
    expect(forwarded).not.toContain("--no-skills");
    expect(env.HOME).toBe(home);
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe(join(fixture, "explicit-sessions"));
    expect(resources).toHaveLength(3);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("different profiles receive distinct default Pi roots without synthetic session overrides", () => {
  const make = (name: string): Profile => ({ root: `/profiles/${name}`, metadata: { version: 1, name, defaultCwd: null, inheritEnvironment: [], createdAt: "2026-09-09T00:00:00.000Z" } });
  const work = buildEnvironment(make("work"), {});
  const personal = buildEnvironment(make("personal"), {});
  expect(work.PI_CODING_AGENT_DIR).not.toBe(personal.PI_CODING_AGENT_DIR);
  expect(work.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
  expect(personal.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
});
