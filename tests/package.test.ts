import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION } from "../src/version.js";

const root = resolve(import.meta.dirname, "..");

describe("package manifest", () => {
  test("declares the CLI and extension entrypoints", async () => {
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(pkg.version).toBe(VERSION);
    expect(pkg.bin["pi-profile"]).toBe("bin/pi-profile.js");
    expect(pkg.pi.extensions).toEqual(["./dist/extension.js"]);
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(pkg.files).toEqual(["bin", "dist", "README.md", "LICENSE"]);
    expect(pkg.files).not.toContain("tests");
    expect(pkg.files).not.toContain(".worktrees");
  });

  test("public entrypoint sources exist for the build", async () => {
    await expect(access(resolve(root, "src/cli.ts"))).resolves.toBeUndefined();
    await expect(access(resolve(root, "src/extension.ts"))).resolves.toBeUndefined();
  });
});
