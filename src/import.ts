import { chmod, copyFile, lstat, mkdir, readFile, readlink, realpath, readdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Profile } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import type { ProfileStore } from "./profile-store.js";
import { validateName } from "./metadata.js";

const excludedNames = new Set([".pi-profile.json", ".pi-profile-leases", ".pi-profile-stage.json"]);
const resourceKeys = new Set(["extensions", "skills", "prompts", "themes", "packages", "source", "sessionDir"]);

function isContained(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonicalPotential(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPotential(parent), absolute.slice(parent.length + 1));
  }
}

async function validateSource(source: string): Promise<string> {
  const absolute = resolve(source);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    throw new ProfileError("IMPORT_SOURCE_MISSING", `Import source directory does not exist: ${absolute}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ProfileError("IMPORT_SOURCE_INVALID", `Import source must be a real directory: ${absolute}`);
  }
  return realpath(absolute);
}

async function validateTree(sourceRoot: string, current = sourceRoot): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (excludedNames.has(entry.name) || entry.name.startsWith(".pi-profile-journal-")) continue;
    const path = join(current, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target)) throw new ProfileError("UNSAFE_SYMLINK", `Import rejects absolute symlink: ${path}`);
      const resolvedTarget = resolve(dirname(path), target);
      if (!isContained(sourceRoot, resolvedTarget)) throw new ProfileError("UNSAFE_SYMLINK", `Import rejects escaping symlink: ${path}`);
      try {
        await lstat(resolvedTarget);
      } catch {
        throw new ProfileError("UNSAFE_SYMLINK", `Import rejects dangling symlink: ${path}`);
      }
    } else if (stats.isDirectory()) {
      await validateTree(sourceRoot, path);
    } else if (!stats.isFile()) {
      throw new ProfileError("UNSUPPORTED_IMPORT_ENTRY", `Import rejects special filesystem entry: ${path}`);
    }
  }
}

function collectExternal(value: unknown, sourceRoot: string, output: string[], key?: string): void {
  if (typeof value === "string") {
    if (key && resourceKeys.has(key) && (value.startsWith("~/") || (isAbsolute(value) && !isContained(sourceRoot, resolve(value))))) {
      output.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExternal(item, sourceRoot, output, key);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) collectExternal(child, sourceRoot, output, childKey);
  }
}

export async function inspectImport(source: string): Promise<{ externalResources: string[] }> {
  const sourceRoot = await validateSource(source);
  await validateTree(sourceRoot);
  const externalResources: string[] = [];
  try {
    const settings = JSON.parse(await readFile(join(sourceRoot, "settings.json"), "utf8")) as unknown;
    collectExternal(settings, sourceRoot, externalResources);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return { externalResources: [...new Set(externalResources)] };
}

async function copyTree(
  sourceRoot: string,
  source: string,
  destination: string,
  beforeCopy?: (sourcePath: string) => void | Promise<void>,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excludedNames.has(entry.name) || entry.name.startsWith(".pi-profile-journal-")) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    await beforeCopy?.(from);
    const before = await lstat(from);
    if (before.isSymbolicLink()) {
      const target = await readlink(from);
      if (isAbsolute(target)) throw new ProfileError("UNSAFE_SYMLINK", `Import rejects absolute symlink: ${from}`);
      const resolvedTarget = resolve(dirname(from), target);
      if (!isContained(sourceRoot, resolvedTarget)) throw new ProfileError("UNSAFE_SYMLINK", `Import rejects escaping symlink: ${from}`);
      await lstat(resolvedTarget).catch(() => { throw new ProfileError("UNSAFE_SYMLINK", `Import rejects dangling symlink: ${from}`); });
      await symlink(target, to, process.platform === "win32" ? (await lstat(resolvedTarget)).isDirectory() ? "junction" : "file" : undefined);
    } else if (before.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await copyTree(sourceRoot, from, to, beforeCopy);
      if (process.platform !== "win32") await chmod(to, 0o700);
    } else if (before.isFile()) {
      await copyFile(from, to);
      if (process.platform !== "win32") await chmod(to, before.mode & 0o100 ? 0o700 : 0o600);
    } else {
      throw new ProfileError("UNSUPPORTED_IMPORT_ENTRY", `Import rejects special filesystem entry: ${from}`);
    }
    const after = await lstat(from);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new ProfileError("IMPORT_SOURCE_CHANGED", `Import source changed during copy: ${from}`);
    }
  }
}

export async function importProfile(
  store: ProfileStore,
  name: string,
  source: string,
  options: { beforeCopy?: (sourcePath: string) => void | Promise<void> } = {},
): Promise<Profile> {
  validateName(name);
  const sourceRoot = await validateSource(source);
  const profilesRoot = await canonicalPotential(store.profilesRoot);
  if (isContained(sourceRoot, profilesRoot) || isContained(profilesRoot, sourceRoot)) {
    throw new ProfileError("IMPORT_OVERLAP", "Import source and profile destination must not overlap");
  }
  await inspectImport(sourceRoot);
  return store.createPopulated(store.metadata(name), async (stagingRoot) => {
    await copyTree(sourceRoot, sourceRoot, stagingRoot, options.beforeCopy);
  });
}
