import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Profile } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import { isReservedEnvironmentName } from "./environment.js";

// A profile-owned `.env` is credential-bearing, so it is treated as secret data:
// parsed (never executed), size-capped, and required to be a private regular file
// the current user owns. The limit stays conservative because these files hold a
// handful of provider variables, not application payloads.
const MAX_ENVIRONMENT_BYTES = 64 * 1024;

// `O_NOFOLLOW` makes `open` fail (ELOOP) if the final path component is a symlink,
// so the file the security checks inspect is the exact file we read. Absent on
// platforms that lack it; the earlier `lstat` still rejects a symlink there.
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

// `parseEnv` strips an `export` prefix only when a space follows it (a tab makes
// `export\tKEY` the literal key), so the separator here is a required space plus
// any further whitespace — matching parseEnv exactly to avoid dropping a variable.
const ASSIGNMENT = /^(?:export [ \t]*)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

export interface ProfileEnvironmentOptions {
  /** Overrides the host platform; drives Windows case-insensitive name handling. */
  platform?: NodeJS.Platform;
  /**
   * The uid to compare the file's owner against. `undefined` derives it from
   * `process.getuid()`; `null` disables the ownership check (platforms, such as
   * Windows, where POSIX ownership is not meaningful).
   */
  currentUid?: number | null;
}

function resolveCurrentUid(options: ProfileEnvironmentOptions): number | null {
  if (options.currentUid !== undefined) return options.currentUid;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Return the assignment names in the order they appear in the file, rejecting any
 * meaningful line `parseEnv` would silently discard. Quoted values may span lines
 * exactly as `parseEnv` allows: an opening quote whose match appears later
 * consumes the lines up to it; an opening quote with no match anywhere is a
 * malformed, unterminated value and the launch fails closed. Returning file order
 * lets the Windows case-insensitive overlay honour the file's last-wins semantics,
 * which `parseEnv`'s output object does not preserve.
 */
function scanAssignmentNames(contents: string, path: string): string[] {
  const lines = contents.split(/\r?\n/);
  const names: string[] = [];
  const malformed = (line: number): never => {
    throw new ProfileError("PROFILE_ENV_MALFORMED", `Profile environment file has a malformed assignment on line ${line}: ${path}`);
  };
  // Anything after a value's closing quote is discarded by parseEnv, so a second
  // assignment there would vanish; require only whitespace or a comment.
  const assertTrailing = (rest: string, line: number): void => {
    const trailing = rest.replace(/^[ \t]+/, "");
    if (trailing !== "" && !trailing.startsWith("#")) malformed(line);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/^[ \t]+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) malformed(index + 1);
    const name = match![1]!;
    // `__proto__` collides with Object.prototype's accessor, and parseEnv handles
    // it inconsistently across Node versions; reject it so it can never silently
    // vanish or touch the prototype.
    if (name === "__proto__") malformed(index + 1);
    names.push(name);
    const value = line.slice(match![0].length).replace(/^[ \t]+/, "");
    const quote = value[0];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue; // Unquoted: value is the line remainder.
    const sameLineClose = value.indexOf(quote, 1);
    if (sameLineClose !== -1) {
      assertTrailing(value.slice(sameLineClose + 1), index + 1);
      continue;
    }
    let close = index + 1;
    while (close < lines.length && !lines[close]!.includes(quote)) close += 1;
    if (close >= lines.length) malformed(index + 1); // Unterminated quoted value.
    assertTrailing(lines[close]!.slice(lines[close]!.indexOf(quote) + 1), index + 1);
    index = close; // Consume the spanned value's lines; they are not assignments.
  }
  return names;
}

function assign(environment: NodeJS.ProcessEnv, name: string, value: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    const upper = name.toUpperCase();
    for (const existing of Object.keys(environment)) {
      if (existing !== name && existing.toUpperCase() === upper) delete environment[existing];
    }
  }
  // Safe as a plain assignment because the one prototype-accessor name, `__proto__`,
  // is rejected during scanning before any value reaches here.
  environment[name] = value;
}

async function readSecureFile(path: string, platform: NodeJS.Platform, options: ProfileEnvironmentOptions): Promise<string | null> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProfileError("PROFILE_ENV_UNREADABLE", `Profile environment file could not be inspected: ${path}`);
  }
  if (stats.isSymbolicLink()) {
    throw new ProfileError("PROFILE_ENV_SYMLINK", `Profile environment file must be a real file, not a symbolic link: ${path}`);
  }
  if (!stats.isFile()) {
    throw new ProfileError("PROFILE_ENV_NOT_REGULAR_FILE", `Profile environment file must be a regular file: ${path}`);
  }

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // Removed between lstat and open: no profile env to apply.
    if (code === "ELOOP") throw new ProfileError("PROFILE_ENV_SYMLINK", `Profile environment file must be a real file, not a symbolic link: ${path}`);
    throw new ProfileError("PROFILE_ENV_UNREADABLE", `Profile environment file could not be read: ${path}`);
  }
  try {
    // Every check runs against the open descriptor, so a rename swapped in after
    // the initial lstat cannot substitute a different file before we read it.
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new ProfileError("PROFILE_ENV_NOT_REGULAR_FILE", `Profile environment file must be a regular file: ${path}`);
    }
    if (platform !== "win32") {
      const currentUid = resolveCurrentUid(options);
      if (currentUid !== null && opened.uid !== currentUid) {
        throw new ProfileError("PROFILE_ENV_UNSAFE_OWNER", `Profile environment file must be owned by the current user: ${path}`);
      }
      if ((opened.mode & 0o077) !== 0) {
        throw new ProfileError("PROFILE_ENV_UNSAFE_PERMISSIONS", `Profile environment file must not be group- or world-accessible; run chmod 600: ${path}`);
      }
    }
    if (opened.size > MAX_ENVIRONMENT_BYTES) {
      throw new ProfileError("PROFILE_ENV_TOO_LARGE", `Profile environment file exceeds the ${MAX_ENVIRONMENT_BYTES}-byte limit: ${path}`);
    }
    const buffer = await handle.readFile();
    if (buffer.byteLength > MAX_ENVIRONMENT_BYTES) {
      throw new ProfileError("PROFILE_ENV_TOO_LARGE", `Profile environment file exceeds the ${MAX_ENVIRONMENT_BYTES}-byte limit: ${path}`);
    }
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Overlay a validated, profile-owned `<profile.root>/.env` onto an already
 * filtered base environment. The base is copied, never mutated; profile values
 * override inherited ones; the launcher routing variables stay authoritative and
 * can never be set from the file.
 */
export async function applyProfileEnvironment(
  profile: Profile,
  baseEnvironment: NodeJS.ProcessEnv,
  options: ProfileEnvironmentOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform;
  const path = join(profile.root, ".env");

  const contents = await readSecureFile(path, platform, options);
  if (contents === null) return { ...baseEnvironment };

  const orderedNames = scanAssignmentNames(contents, path);

  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(contents) as Record<string, string>;
  } catch {
    throw new ProfileError("PROFILE_ENV_MALFORMED", `Profile environment file could not be parsed: ${path}`);
  }

  for (const [name, value] of Object.entries(parsed)) {
    if (isReservedEnvironmentName(name, platform)) {
      throw new ProfileError("PROFILE_ENV_RESERVED", `Profile environment file must not set the launcher-controlled variable ${name}: ${path}`);
    }
    // A NUL byte is rejected by `spawn`, which echoes the offending value in its
    // error; catch it here so the value never reaches spawn or any diagnostic.
    if (name.includes("\u0000") || value.includes("\u0000")) {
      throw new ProfileError("PROFILE_ENV_MALFORMED", `Profile environment file contains a NUL byte in a variable name or value: ${path}`);
    }
  }

  const result: NodeJS.ProcessEnv = { ...baseEnvironment };
  // Apply in file order so a Windows case-collision (e.g. `path` then `PATH`)
  // resolves to the file's last assignment. A scanned name missing from parseEnv's
  // output means the two disagree about the file, so fail closed rather than launch
  // with a variable the operator declared silently absent.
  for (const name of orderedNames) {
    if (!Object.hasOwn(parsed, name)) {
      throw new ProfileError("PROFILE_ENV_MALFORMED", `Profile environment file has an assignment that could not be parsed: ${path}`);
    }
    assign(result, name, parsed[name]!, platform);
  }
  // Reassert the launcher routing variables defensively, even though the file was
  // already rejected if it declared them, so the child can never be misrouted.
  assign(result, "PI_CODING_AGENT_DIR", profile.root, platform);
  assign(result, "PI_PROFILE_NAME", profile.metadata.name, platform);
  return result;
}
