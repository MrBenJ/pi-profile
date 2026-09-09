import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { LaunchRequest, Profile } from "./contracts.js";
import { ProfileError } from "./contracts.js";

const managementCommands = new Set(["config", "install", "remove", "uninstall", "list", "update", "auth"]);
const managementExitFlags = new Set(["--help", "-h", "--version", "-v", "--list-models"]);
export type InvocationKind = "session" | "management";

export function classifyInvocation(args: string[]): InvocationKind {
  const first = args[0];
  if (first === "--export") return args.length > 1 ? "management" : "session";
  if (first && (managementCommands.has(first) || managementExitFlags.has(first))) return "management";
  return "session";
}

async function requireDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    if (!(await stat(absolute)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ProfileError("INVALID_CWD", `Working directory does not exist or is not a directory: ${absolute}`);
  }
  return absolute;
}

export async function selectWorkingDirectory(
  profile: Profile,
  cliCwd: string | undefined,
  callerCwd: string,
): Promise<string> {
  return requireDirectory(cliCwd ?? profile.metadata.defaultCwd ?? callerCwd);
}

export async function validateLaunch(request: LaunchRequest): Promise<void> {
  if (resolve(request.profile.root) !== request.profile.root) {
    throw new ProfileError("INVALID_PROFILE_ROOT", `Profile root must be absolute: ${request.profile.root}`);
  }
  await requireDirectory(request.cwd);
}
