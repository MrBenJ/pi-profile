import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { LaunchRequest, Profile } from "./contracts.js";
import { ProfileError } from "./contracts.js";

const managementCommands = new Set(["config", "install", "remove", "uninstall", "list", "update", "auth"]);
const managementExitFlags = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);
const sessionForcingFlags = new Set(["--print", "-p", "--mode"]);
const optionsWithValues = new Set([
  "--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt",
  "--mode", "--session", "--session-id", "--fork", "--session-dir", "--name", "-n",
  "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--extension", "-e",
  "--skill", "--prompt-template", "--theme", "--use-theme", "--export", "--tui-mode",
]);

export type InvocationKind = "session" | "management";

export function classifyInvocation(args: string[]): InvocationKind {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") return "session";
    if (managementCommands.has(argument)) return "management";
    if (managementExitFlags.has(argument)) return "management";
    if (!argument.startsWith("-")) return "session";
    const option = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (option === "--export" && argument.includes("=")) return "management";
    if (sessionForcingFlags.has(option)) return "session";
    if (!argument.includes("=") && optionsWithValues.has(option)) index += 1;
  }
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
