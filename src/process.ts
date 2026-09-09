import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
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

async function packageBin(packageRoot: string, platform: NodeJS.Platform): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (typeof declared !== "string" || !declared) return undefined;
    const candidate = resolve(packageRoot, declared);
    const fromRoot = relative(packageRoot, candidate);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
    return await executable(candidate, platform) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export async function resolvePi(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Executable> {
  const pathValue = platform === "win32"
    ? Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  const directories = (pathValue ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  let unsupportedWrapper: string | undefined;
  for (const directory of directories) {
    if (platform === "win32") {
      const direct = join(directory, "pi.exe");
      if (await executable(direct, platform)) return { command: direct, prefixArgs: [] };
      const commandShim = join(directory, "pi.cmd");
      if (await executable(commandShim, platform)) {
        const packageRoots = [
          join(directory, "node_modules", "@earendil-works", "pi-coding-agent"),
          join(directory, "..", "@earendil-works", "pi-coding-agent"),
        ];
        for (const packageRoot of packageRoots) {
          const bundle = await packageBin(packageRoot, platform);
          if (bundle) return { command: process.execPath, prefixArgs: [bundle] };
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
  options: {
    leaseFactory?: typeof acquireLease;
    publicationDrainMs?: number;
    onWarning?: (message: string) => void;
  } = {},
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
    const primary = new ProfileError("PI_SPAWN_FAILED", `Could not start Pi: ${(error as Error).message}`);
    try {
      await owner.release();
    } catch (cleanupError) {
      throw new AggregateError([primary, cleanupError], `${primary.message}; lease cleanup also failed: ${(cleanupError as Error).message}`, { cause: primary });
    }
    throw primary;
  }

  const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, rejectOutcome) => {
    child.once("error", (error) => rejectOutcome(new ProfileError("PI_SPAWN_FAILED", `Could not start Pi: ${error.message}`)));
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
  // Attach rejection handling immediately. Publication can fail before the
  // normal `await outcome` path, while the child independently emits error.
  const settledOutcome = outcome.then(
    (value) => ({ kind: "exit" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

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
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let primaryError: unknown;
  try {
    if (!child.pid) {
      result = await outcome;
    } else {
      try {
        await owner.setChild(child.pid);
      } catch (error) {
        try { child.kill("SIGTERM"); } catch { /* Settlement below decides whether evidence is retained. */ }
        const drainMs = options.publicationDrainMs ?? 2_000;
        const settlement = await new Promise<Awaited<typeof settledOutcome> | { kind: "timeout" }>((resolveSettlement) => {
          const timer = setTimeout(() => resolveSettlement({ kind: "timeout" }), drainMs);
          settledOutcome.then((value) => {
            clearTimeout(timer);
            resolveSettlement(value);
          });
        });
        if (settlement.kind === "exit") {
          throw new ProfileError("LEASE_PUBLICATION_FAILED", `Pi started but its child lease could not be recorded; child exit was confirmed and this launcher's lease was released: ${(error as Error).message}`);
        }
        retainLease = true;
        const leasePath = join(request.profile.root, ".pi-profile-leases", `${owner.lease.id}.json`);
        throw new ProfileError(
          "LEASE_PUBLICATION_UNCERTAIN",
          `Pi started but its child lease could not be recorded and child exit could not be confirmed. Evidence was retained at ${leasePath}; verify child PID ${child.pid} is gone before manually removing that exact lease file: ${(error as Error).message}`,
        );
      }
      result = await outcome;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }

  let cleanupError: unknown;
  if (!retainLease) {
    try {
      await owner.release();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError([primaryError, cleanupError], `${primaryMessage}; lease cleanup also failed: ${cleanupMessage}`, { cause: primaryError });
    }
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    const message = `Lease cleanup failed after Pi exited; child status was preserved. Inspect ${request.profile.root} manually: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    try {
      (options.onWarning ?? ((warning) => process.stderr.write(`pi-profile: warning: ${warning}\n`)))(message);
    } catch { /* Warning reporting must not replace the child outcome. */ }
  }
  return result!;
}
