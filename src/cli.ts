import { homedir } from "node:os";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LaunchRequest, Profile } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import { buildEnvironment, isReservedEnvironmentName } from "./environment.js";
import { importProfile as copyProfile, inspectImport as inspectSource } from "./import.js";
import { inspectLeases } from "./lease.js";
import { selectWorkingDirectory } from "./launch-policy.js";
import { validateEnvironmentName } from "./metadata.js";
import { ProfileStore } from "./profile-store.js";
import { createPrompts } from "./prompts.js";
import { resolvePi, runPi as spawnPi } from "./process.js";

export type ConfigOperation =
  | { type: "pi" }
  | { type: "default-cwd"; path: string }
  | { type: "clear-default-cwd" }
  | { type: "inherit"; name: string }
  | { type: "no-inherit"; name: string };

export type CliCommand =
  | { command: "launch"; profile?: string; cwd?: string; piArgs: string[] }
  | { command: "create"; name?: string }
  | { command: "list" }
  | { command: "recover" }
  | { command: "show"; name?: string }
  | { command: "rename"; oldName?: string; newName?: string; clearStaleLeases: boolean }
  | { command: "remove"; name?: string; force: boolean; clearStaleLeases: boolean }
  | { command: "import"; name?: string; source?: string; yes: boolean }
  | { command: "config"; name?: string; operation?: ConfigOperation };

export interface CliDependencies {
  store: ProfileStore;
  runPi(request: LaunchRequest): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  inspectImport(source: string): Promise<{ externalResources: string[] }>;
  importProfile(store: ProfileStore, name: string, source: string): Promise<Profile>;
  select(title: string, choices: string[]): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  input(message: string): Promise<string | undefined>;
  isTTY: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  stdout(line: string): void;
  stderr(line: string): void;
}

const managerCommands = new Set(["create", "list", "recover", "show", "rename", "remove", "import", "config"]);

function usage(message: string): never {
  throw new ProfileError("USAGE", message);
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) usage(`${flag} requires a value`);
  return value;
}

export function parseCli(argv: string[]): CliCommand {
  if (argv.length === 0) return { command: "launch", piArgs: [] };
  if (argv[0] === "--cwd") {
    const cwd = takeValue(argv, 0, "--cwd");
    const profile = argv[2];
    if (!profile) usage("--cwd requires a profile name");
    return { command: "launch", profile, cwd, piArgs: argv.slice(3) };
  }
  if (argv[0]?.startsWith("--cwd=")) {
    const cwd = argv[0].slice("--cwd=".length);
    if (!cwd) usage("--cwd requires a value");
    const profile = argv[1];
    if (!profile) usage("--cwd requires a profile name");
    return { command: "launch", profile, cwd, piArgs: argv.slice(2) };
  }
  const first = argv[0];
  if (!first) return { command: "launch", piArgs: [] };
  if (!managerCommands.has(first)) return { command: "launch", profile: first, piArgs: argv.slice(1) };
  switch (first) {
    case "create":
      if (argv.length > 2) usage("Usage: pi-profile create [name]");
      return argv[1] ? { command: "create", name: argv[1] } : { command: "create" };
    case "list":
      if (argv.length !== 1) usage("Usage: pi-profile list");
      return { command: "list" };
    case "recover":
      if (argv.length !== 1) usage("Usage: pi-profile recover");
      return { command: "recover" };
    case "show":
      if (argv.length > 2) usage("Usage: pi-profile show <name>");
      return argv[1] ? { command: "show", name: argv[1] } : { command: "show" };
    case "rename": {
      const positional = argv.slice(1).filter((arg) => arg !== "--clear-stale-leases");
      const unknown = argv.slice(1).filter((arg) => arg.startsWith("--") && arg !== "--clear-stale-leases");
      if (unknown.length || positional.length > 2) usage("Usage: pi-profile rename <old> <new> [--clear-stale-leases]");
      return {
        command: "rename",
        ...(positional[0] ? { oldName: positional[0] } : {}),
        ...(positional[1] ? { newName: positional[1] } : {}),
        clearStaleLeases: argv.includes("--clear-stale-leases"),
      };
    }
    case "remove": {
      const flags = new Set(argv.slice(1).filter((arg) => arg.startsWith("--")));
      if ([...flags].some((flag) => !["--force", "--clear-stale-leases"].includes(flag))) usage("Unknown remove option");
      const positional = argv.slice(1).filter((arg) => !arg.startsWith("--"));
      if (positional.length > 1) usage("Usage: pi-profile remove <name> [--force] [--clear-stale-leases]");
      return { command: "remove", ...(positional[0] ? { name: positional[0] } : {}), force: flags.has("--force"), clearStaleLeases: flags.has("--clear-stale-leases") };
    }
    case "import": {
      const yes = argv.includes("--yes");
      const unknown = argv.slice(1).filter((arg) => arg.startsWith("--") && arg !== "--yes");
      const positional = argv.slice(1).filter((arg) => !arg.startsWith("--"));
      if (unknown.length || positional.length > 2) usage("Usage: pi-profile import <name> <source-directory> [--yes]");
      return { command: "import", ...(positional[0] ? { name: positional[0] } : {}), ...(positional[1] ? { source: positional[1] } : {}), yes };
    }
    case "config": {
      const name = argv[1];
      const rest = argv.slice(2);
      let operation: ConfigOperation | undefined;
      if (rest.length) {
        const flag = rest[0];
        if (flag === "--pi" && rest.length === 1) operation = { type: "pi" };
        else if (flag === "--clear-default-cwd" && rest.length === 1) operation = { type: "clear-default-cwd" };
        else if (flag === "--default-cwd" && rest.length === 2) operation = { type: "default-cwd", path: rest[1]! };
        else if (flag === "--inherit" && rest.length === 2) operation = { type: "inherit", name: rest[1]! };
        else if (flag === "--no-inherit" && rest.length === 2) operation = { type: "no-inherit", name: rest[1]! };
        else usage("Invalid config operation");
      }
      return { command: "config", ...(name ? { name } : {}), ...(operation ? { operation } : {}) };
    }
    default:
      return usage(`Unknown command: ${first}`);
  }
}

function expandPath(path: string, deps: CliDependencies): string {
  const expanded = path === "~" ? deps.home : path.startsWith("~/") || path.startsWith("~\\") ? join(deps.home, path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(deps.cwd, expanded);
}

async function requiredValue(value: string | undefined, label: string, deps: CliDependencies): Promise<string> {
  if (value) return value;
  if (!deps.isTTY) usage(`${label} is required in non-interactive mode`);
  const entered = await deps.input(`${label}:`);
  if (!entered) throw new ProfileError("CANCELLED", `${label} entry cancelled`);
  return entered;
}

async function launchProfile(command: Extract<CliCommand, { command: "launch" }>, deps: CliDependencies): Promise<number> {
  let name = command.profile;
  if (!name) {
    if (!deps.isTTY) usage("A profile name is required in non-interactive mode");
    const profiles = await deps.store.list();
    if (!profiles.length) throw new ProfileError("NO_PROFILES", "No profiles exist; run pi-profile create <name>");
    name = await deps.select("Select a Pi profile:", profiles.map((profile) => profile.metadata.name));
    if (!name) return 1;
  }
  let profile: Profile;
  try {
    profile = await deps.store.get(name);
  } catch (error) {
    if (error instanceof ProfileError && error.code === "PROFILE_NOT_FOUND") {
      throw new ProfileError(error.code, `${error.message}. Create it with: pi-profile create ${name}`);
    }
    throw error;
  }
  const cwd = await selectWorkingDirectory(profile, command.cwd ? expandPath(command.cwd, deps) : undefined, deps.cwd);
  const result = await deps.runPi({ profile, piArgs: command.piArgs, cwd, env: buildEnvironment(profile, deps.env) });
  if (result.code !== null) return result.code;
  return result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1;
}

async function retryStale(operation: (clear: boolean) => Promise<void>, clear: boolean, deps: CliDependencies): Promise<void> {
  try {
    await operation(clear);
  } catch (error) {
    if (!(error instanceof ProfileError) || error.code !== "STALE_LEASES" || clear || !deps.isTTY) throw error;
    if (!await deps.confirm("Clear verified stale leases and continue?")) throw new ProfileError("CANCELLED", "Stale lease cleanup cancelled");
    await operation(true);
  }
}

async function dispatch(command: CliCommand, deps: CliDependencies): Promise<number> {
  switch (command.command) {
    case "launch": return launchProfile(command, deps);
    case "create": {
      const name = await requiredValue(command.name, "Profile name", deps);
      const profile = await deps.store.create(deps.store.metadata(name));
      deps.stdout(`Created ${profile.metadata.name}: ${profile.root}`);
      return 0;
    }
    case "list": {
      for (const profile of await deps.store.list()) deps.stdout(`${profile.metadata.name}\t${profile.root}`);
      return 0;
    }
    case "recover": {
      const result = await deps.store.recover();
      deps.stdout(`Recovery complete: lock=${result.lockRecovered ? "recovered" : "absent"}, transactions=${result.transactionsRecovered}, stages=${result.stagesRecovered}`);
      return 0;
    }
    case "show": {
      const name = await requiredValue(command.name, "Profile name", deps);
      const profile = await deps.store.get(name);
      const leases = await inspectLeases(profile);
      deps.stdout(JSON.stringify({ name: profile.metadata.name, root: profile.root, defaultCwd: profile.metadata.defaultCwd, inheritEnvironment: profile.metadata.inheritEnvironment, leases: { active: leases.active.length, ambiguous: leases.ambiguous.length, stale: leases.stale.length } }, null, 2));
      return 0;
    }
    case "rename": {
      const oldName = await requiredValue(command.oldName, "Current profile name", deps);
      const newName = await requiredValue(command.newName, "New profile name", deps);
      await retryStale((clear) => deps.store.rename(oldName, newName, { clearStaleLeases: clear }), command.clearStaleLeases, deps);
      deps.stdout(`Renamed ${oldName} to ${newName}`);
      return 0;
    }
    case "remove": {
      const name = await requiredValue(command.name, "Profile name", deps);
      const profile = await deps.store.get(name);
      if (!command.force) {
        if (!deps.isTTY) usage("Non-interactive removal requires --force");
        const typed = await deps.input(`Type ${name} to permanently delete ${profile.root}:`);
        if (typed !== name) return 1;
      }
      await retryStale((clear) => deps.store.remove(name, { clearStaleLeases: clear }), command.clearStaleLeases, deps);
      deps.stdout(`Removed ${name}`);
      return 0;
    }
    case "import": {
      const name = await requiredValue(command.name, "Profile name", deps);
      const source = expandPath(await requiredValue(command.source, "Source directory", deps), deps);
      const inspection = await deps.inspectImport(source);
      deps.stdout("Import may copy credentials, sessions, and installed code.");
      for (const path of inspection.externalResources) deps.stdout(`External resource preserved: ${path}`);
      if (!command.yes) {
        if (!deps.isTTY) usage("Non-interactive import requires --yes");
        if (!await deps.confirm(`Import ${source} as ${name}?`)) return 1;
      }
      const profile = await deps.importProfile(deps.store, name, source);
      deps.stdout(`Imported ${profile.metadata.name}: ${profile.root}`);
      return 0;
    }
    case "config": {
      const name = await requiredValue(command.name, "Profile name", deps);
      let operation = command.operation;
      if (!operation) {
        if (!deps.isTTY) usage("A config operation is required in non-interactive mode");
        const choice = await deps.select("Configure profile:", ["pi", "default-cwd", "clear-default-cwd", "inherit", "no-inherit"]);
        if (!choice) return 1;
        if (choice === "pi") operation = { type: "pi" };
        else if (choice === "clear-default-cwd") operation = { type: "clear-default-cwd" };
        else {
          const value = await requiredValue(undefined, choice === "default-cwd" ? "Working directory" : "Environment variable", deps);
          operation = choice === "default-cwd" ? { type: "default-cwd", path: value } : choice === "inherit" ? { type: "inherit", name: value } : { type: "no-inherit", name: value };
        }
      }
      if (operation.type === "pi") {
        const profile = await deps.store.get(name);
        const cwd = await selectWorkingDirectory(profile, undefined, deps.cwd);
        const result = await deps.runPi({ profile, piArgs: ["config"], cwd, env: buildEnvironment(profile, deps.env) });
        return result.code ?? 1;
      }
      if (operation.type === "inherit" || operation.type === "no-inherit") {
        validateEnvironmentName(operation.name);
        if (isReservedEnvironmentName(operation.name)) throw new ProfileError("RESERVED_ENVIRONMENT", `${operation.name} is controlled by pi-profile and cannot be inherited`);
      }
      const defaultCwd = operation.type === "default-cwd" ? expandPath(operation.path, deps) : undefined;
      await deps.store.update(name, (metadata) => {
        if (operation.type === "default-cwd") return { ...metadata, defaultCwd: defaultCwd! };
        if (operation.type === "clear-default-cwd") return { ...metadata, defaultCwd: null };
        const names = new Set(metadata.inheritEnvironment);
        if (operation.type === "inherit") names.add(operation.name);
        if (operation.type === "no-inherit") names.delete(operation.name);
        return { ...metadata, inheritEnvironment: [...names].sort() };
      });
      deps.stdout(`Updated ${name}`);
      return 0;
    }
  }
}

function productionDependencies(): CliDependencies {
  const prompts = createPrompts({ isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), input: process.stdin, output: process.stdout });
  const home = homedir();
  const store = new ProfileStore({ profilesRoot: join(home, ".pi", "profiles"), now: () => new Date() });
  return {
    store,
    async runPi(request) { return spawnPi(request, await resolvePi(request.env)); },
    inspectImport: inspectSource,
    importProfile: copyProfile,
    ...prompts,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    cwd: process.cwd(),
    env: process.env,
    home,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

export async function main(argv: string[], dependencies?: CliDependencies): Promise<number> {
  const deps = dependencies ?? productionDependencies();
  try {
    return await dispatch(parseCli(argv), deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(`pi-profile: ${message}`);
    return error instanceof ProfileError && error.code === "CANCELLED" ? 1 : 2;
  }
}
