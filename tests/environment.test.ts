import { describe, expect, test } from "vitest";
import { AUTH_ENVIRONMENT_VARIABLES, buildEnvironment } from "../src/environment.js";
import type { Profile } from "../src/contracts.js";

const work: Profile = {
  root: "/profiles/work",
  metadata: { version: 1, name: "work", defaultCwd: null, inheritEnvironment: [], createdAt: "2026-09-09T00:00:00.000Z" },
};

test.each(AUTH_ENVIRONMENT_VARIABLES)("strips known provider authentication variable %s", (name) => {
  expect(buildEnvironment(work, { [name]: "synthetic-not-a-secret" })[name]).toBeUndefined();
});

test("preserves ordinary and native explicit session environment while replacing launcher routing", () => {
  const env = buildEnvironment(work, {
    PATH: "/test/bin",
    HOME: "/home/person",
    OPENAI_API_KEY: "fixture",
    PI_CODING_AGENT_DIR: "/personal",
    PI_PROFILE_NAME: "personal",
    PI_CODING_AGENT_SESSION_DIR: "/personal/sessions",
  });
  expect(env.PATH).toBe("/test/bin");
  expect(env.HOME).toBe("/home/person");
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.PI_CODING_AGENT_DIR).toBe(work.root);
  expect(env.PI_PROFILE_NAME).toBe("work");
  expect(env.PI_CODING_AGENT_SESSION_DIR).toBe("/personal/sessions");
});

test("preserves PI_PACKAGE_DIR as Pi runtime-code location rather than profile user data", () => {
  const env = buildEnvironment(work, { PI_PACKAGE_DIR: "/nix/store/pi-coding-agent", PI_CODING_AGENT_DIR: "/personal" });
  expect(env.PI_PACKAGE_DIR).toBe("/nix/store/pi-coding-agent");
  expect(env.PI_CODING_AGENT_DIR).toBe(work.root);
});

test("retains allowlisted names without storing values", () => {
  const profile = { ...work, metadata: { ...work.metadata, inheritEnvironment: ["AWS_PROFILE"] } };
  expect(buildEnvironment(profile, { AWS_PROFILE: "synthetic-work", AWS_SECRET_ACCESS_KEY: "fixture" })).toMatchObject({ AWS_PROFILE: "synthetic-work" });
  expect(buildEnvironment(profile, { AWS_PROFILE: "synthetic-work", AWS_SECRET_ACCESS_KEY: "fixture" }).AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(JSON.stringify(profile.metadata)).not.toContain("synthetic-work");
});

test("Windows matching removes duplicate-cased credential and routing entries", () => {
  const env = buildEnvironment(work, {
    Path: "C:\\bin",
    openai_api_key: "one",
    OPENAI_API_KEY: "two",
    pi_coding_agent_dir: "C:\\personal",
    PI_PROFILE_NAME: "personal",
  }, "win32");
  expect(Object.keys(env).filter((key) => key.toUpperCase() === "OPENAI_API_KEY")).toEqual([]);
  expect(Object.keys(env).filter((key) => key.toUpperCase() === "PI_CODING_AGENT_DIR")).toEqual(["PI_CODING_AGENT_DIR"]);
  expect(env.Path).toBe("C:\\bin");
});

describe("intentional cloud boundary", () => {
  test("strips selectors but preserves HOME and SDK default locations", () => {
    const env = buildEnvironment(work, {
      HOME: "/home/person",
      AWS_PROFILE: "personal",
      AWS_SHARED_CREDENTIALS_FILE: "/home/person/.aws/credentials",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
      CLOUDSDK_CONFIG: "/home/person/.config/gcloud",
    });
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.HOME).toBe("/home/person");
    expect(env.CLOUDSDK_CONFIG).toBe("/home/person/.config/gcloud");
  });
});
