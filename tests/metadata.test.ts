import { describe, expect, test } from "vitest";
import { parseMetadata, validateName } from "../src/metadata.js";
import { profilePath } from "../src/paths.js";

const valid = {
  version: 1,
  name: "work",
  defaultCwd: null,
  inheritEnvironment: ["AWS_PROFILE"],
  createdAt: "2026-09-09T00:00:00.000Z",
};

test.each(["../work", "Work", "work/other", "con", "nul", "com1", "create", "a--b", "-a"])(
  "rejects unsafe name %s",
  (name) => expect(() => validateName(name)).toThrow(),
);
test("accepts portable slugs", () => expect(validateName("client-a")).toBe("client-a"));
test("rejects unsupported metadata", () => expect(() => parseMetadata({ version: 2 })).toThrow());

describe("metadata schema", () => {
  test("accepts complete version one metadata", () => expect(parseMetadata(valid)).toEqual(valid));
  test.each([
    { ...valid, extra: true },
    { ...valid, createdAt: "yesterday" },
    { ...valid, defaultCwd: "relative" },
    { ...valid, inheritEnvironment: ["A", "A"] },
    { ...valid, inheritEnvironment: ["NOT VALID"] },
  ])("rejects malformed metadata %#", (value) => expect(() => parseMetadata(value)).toThrow());
});

test("profile paths are direct children", () => {
  expect(profilePath("/tmp/profiles", "work")).toBe("/tmp/profiles/work");
  expect(() => profilePath("/tmp/profiles", "../work")).toThrow();
});
