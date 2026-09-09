import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { VERSION } from "../src/version.js";

const root = resolve(import.meta.dirname, "..");
const exec = promisify(execFile);

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
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.scripts["typecheck:tests"]).toBe("tsc -p tsconfig.tests.json --noEmit");
    expect(pkg.scripts.verify).toContain("typecheck:tests");
  });

  test("ignores interrupted fresh-pack fixtures", async () => {
    const ignore = await readFile(resolve(root, ".gitignore"), "utf8");
    expect(ignore.split(/\r?\n/u)).toContain("/.pack-fixture-*/");
  });

  test("public entrypoint sources exist for the build", async () => {
    await expect(access(resolve(root, "src/cli.ts"))).resolves.toBeUndefined();
    await expect(access(resolve(root, "src/extension.ts"))).resolves.toBeUndefined();
  });

  test("npm pack builds a fresh checkout with no dist directory", async () => {
    const fixture = await mkdtemp(resolve(root, ".pack-fixture-"));
    try {
      for (const entry of ["src", "bin", "package.json", "tsconfig.json", "README.md", "LICENSE"]) {
        await cp(resolve(root, entry), resolve(fixture, entry), { recursive: true });
      }
      await expect(access(resolve(fixture, "dist"))).rejects.toThrow();
      const npmCli = process.env.npm_execpath;
      if (!npmCli) throw new Error("npm_execpath is required for package lifecycle test");
      const { stdout } = await exec(process.execPath, [npmCli, "pack", "--json"], { cwd: fixture });
      const result = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      expect(result[0]?.files.map((file) => file.path)).toContain("dist/cli.js");
      await expect(access(resolve(fixture, "dist", "extension.js"))).resolves.toBeUndefined();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
