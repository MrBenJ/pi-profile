import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LaunchRequest } from "./contracts.js";
import { ProfileError } from "./contracts.js";
import { acquireLease } from "./lease.js";
import { classifyInvocation, validateLaunch } from "./launch-policy.js";

export interface Executable {
  command: string;
  prefixArgs: string[];
}

const indicatorEntrypoint = fileURLToPath(new URL("./extension.js", import.meta.url));

async function executable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePi(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Executable> {
  const pathValue = platform === "win32"
    ? Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  const directories = (pathValue ?? "").split(delimiter).filter(Boolean);
  let unsupportedWrapper: string | undefined;
  for (const directory of directories) {
    if (platform === "win32") {
      const direct = join(directory, "pi.exe");
      if (await executable(direct, platform)) return { command: direct, prefixArgs: [] };
      const commandShim = join(directory, "pi.cmd");
      if (await executable(commandShim, platform)) {
        const bundles = [
          // Global npm shim: <global-bin>/node_modules/@scope/package/...
          join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
          // Local npm shim: <project>/node_modules/.bin/pi.cmd
          join(directory, "..", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
        ];
        for (const bundle of bundles) {
          if (await executable(bundle, platform)) return { command: process.execPath, prefixArgs: [bundle] };
        }
        unsupportedWrapper = commandShim;
      }
    } else {
      const candidate = join(directory, "pi");
      if (await executable(candidate, platform)) return { command: candidate, prefixArgs: [] };
    }
  }
  if (unsupportedWrapper) {
    throw new ProfileError("UNSUPPORTED_PI_WRAPPER", `Found an unsupported Pi command wrapper at ${unsupportedWrapper}; install Pi with npm so its Node entrypoint can be resolved safely`);
  }
  throw new ProfileError("PI_NOT_FOUND", "Could not find the Pi executable; install Pi (@earendil-works/pi-coding-agent) and ensure pi is on PATH");
}

function sessionArguments(piArgs: string[]): string[] {
  if (classifyInvocation(piArgs) === "management") return [...piArgs];
  return ["--extension", indicatorEntrypoint, ...piArgs];
}

export async function runPi(
  request: LaunchRequest,
  target: Executable,
  options: { leaseFactory?: typeof acquireLease } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  await validateLaunch(request);
  const owner = await (options.leaseFactory ?? acquireLease)(request.profile);
  let child;
  try {
    child = spawn(target.command, [...target.prefixArgs, ...sessionArguments(request.piArgs)], {
      cwd: request.cwd,
      env: request.env,
      stdio: "inherit",
      shell: false,
      windowsHide: false,
    });
  } catch (error) {
    await owner.release();
    throw new ProfileError("PI_SPAWN_FAILED", `Could not start Pi: ${(error as Error).message}`);
  }

  const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, rejectOutcome) => {
    child.once("error", (error) => rejectOutcome(new ProfileError("PI_SPAWN_FAILED", `Could not start Pi: ${error.message}`)));
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
  // Attach rejection handling immediately. Publication can fail before the
  // normal `await outcome` path, while the child independently emits error.
  const drainedOutcome = outcome.catch(() => undefined);

  const forwardedSignals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const terminalBroadcastsInterrupt = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const interruptHandler = () => {
    // A real terminal sends Ctrl+C to the whole foreground process group, so
    // forwarding here would deliver SIGINT twice. Non-interactive callers that
    // signal only this launcher still need us to propagate it to the child.
    if (!terminalBroadcastsInterrupt && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGINT"); } catch { /* The child may have exited concurrently. */ }
    }
  };
  handlers.set("SIGINT", interruptHandler);
  process.on("SIGINT", interruptHandler);

  let retainLease = false;
  try {
    if (!child.pid) return await outcome;
    try {
      await owner.setChild(child.pid);
    } catch (error) {
      retainLease = true;
      try { child.kill("SIGTERM"); } catch { /* The outcome still drains an already-exited child. */ }
      await drainedOutcome;
      throw new ProfileError("LEASE_PUBLICATION_FAILED", `Pi started but its child lease could not be recorded; the child was reaped and the conservative lease was retained: ${(error as Error).message}`);
    }
    return await outcome;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (!retainLease) await owner.release();
  }
}
