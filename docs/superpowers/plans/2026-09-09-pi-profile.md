# Pi Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute serially; do not parallelize implementation tasks.

**Goal:** Provide a cross-platform launcher and status extension for independent work and personal Pi configurations.

**Architecture:** Launch the installed Pi executable with a selected configuration root and sanitized environment. Use native Pi settings for resource selection, opaque filesystem operations for import, and a read-only extension for indicators and `/profile`. Keep profile management, launch policy, filesystem transactions, and child-process supervision separate.

**Tech Stack:** Node.js >=22.19.0, TypeScript, Vitest, native child_process/fs APIs, Pi extension API; compiled ESM CLI.

**Spec:** `docs/superpowers/specs/2026-09-09-pi-profile-design.md`

**Execution status:** Authorized for serial autonomous execution. The user explicitly confirmed the original native Pi boundary: ambient home skills are intentionally shared and native session-path behavior remains unchanged. Repository has no remote; deliver a locally reviewed feature branch without inventing a GitHub destination.

## Global Constraints

- The package requires Node.js 22.19.0 or newer.
- Support macOS, Linux, and Windows.
- Keep plain `pi` and the existing `~/.pi/agent` untouched.
- Profiles live under `~/.pi/profiles/<name>`.
- Share the Pi executable and indicator package, not mutable profile configuration.
- Native Pi settings remain the resource-selection source of truth.
- Never parse, print, or log auth.json; import copies it as opaque bytes.
- Provider environment inheritance uses explicit variable names, not stored secret values.
- Trusted project-local resources retain normal Pi behavior.
- Indicator state must not enter transcripts or model context.
- No OS sandbox, separate Pi installation per profile, backup/export, or in-session switching.
- Run implementation serially with red/green tests and coherent commits on a feature branch, never directly on main.
- Do not import real credentials or run provider login as an automated test.
- Do not claim Windows, Linux, real OAuth, or manual TUI checks passed based on macOS mocks.

---

## Confirmed native Pi boundary

Read the installed Pi docs and runtime before coding. The relevant installation at planning time is `/Users/bjunya/.nvm/versions/node/v26.8.1/lib/node_modules/@earendil-works/pi-coding-agent`.

1. `dist/core/package-manager.js:1976-2017` discovers `$HOME/.agents/skills` independently of the selected agent directory. A fresh profile does not start skill-empty merely because it has a new root.
2. `docs/environment-variables.md` and `docs/settings.md` document `PI_CODING_AGENT_SESSION_DIR`, `sessionDir`, and CLI `--session-dir` precedence. `--session <path>` and `--fork <path>` can explicitly access another profile's sessions.
3. Removing AWS/Google credential variables does not by itself prove that SDK default credential-file discovery is disabled. Validate cloud credential fallback without network requests; do not claim all credential discovery is covered by a denylist.
4. The spec's lease records only the launcher PID. A killed launcher can leave Pi running, so that PID becoming absent is insufficient permission to delete the profile.
5. `/profile` read-only information was approved in conversation but omitted from the written spec. Restore it without introducing switching, auth inspection, or an identity system.
6. The repository has main and no remote. Local execution is possible after feature-branch confirmation; pushing, PR creation, and Aria PR review require an explicitly selected remote.

**User decision:** Do not implement the proposed strict resource/session boundary. Preserve ambient `~/.agents/skills`, trusted project resources, native session settings and all forwarded Pi arguments. The profile directory isolates Pi's default configuration and storage, not every external path Pi is capable of accessing. Document these intentional exceptions instead of claiming filesystem confinement.

Implement the originally agreed known-provider environment denylist with per-profile inheritance by variable name. Do not redirect HOME, USERPROFILE, AWS/Google config directories, metadata services, or cloud SDK credential chains. Document that stripping environment variables is not a guarantee against cloud SDK default-file authentication.

**Execution authorization:** The user requested serial autonomous execution and reaffirmed the original design. Proceed in one feature worktree, keep changes local and unmerged, and do not create a remote. Implement conservative lifecycle protection for destructive operations without adding identity/auth policy.

## File map and interfaces

- `package.json`, `tsconfig.json`, `vitest.config.ts`: build, package exports, tests.
- `bin/pi-profile.js`: tiny ESM entry importing compiled CLI; no shell interpolation.
- `src/contracts.ts`: versioned metadata, operations, runtime lease and errors.
- `src/metadata.ts`: pure name/metadata validation.
- `src/paths.ts`: canonical profile-root containment and platform-safe names.
- `src/profile-store.ts`: listing, creation, metadata writes, rename/removal.
- `src/transactions.ts`: exclusive parent-directory mutation lock and journal recovery.
- `src/import.ts`: staged opaque copies and safe symlinks.
- `src/environment.ts`: deterministic provider-variable filtering and launcher-owned overrides.
- `src/launch-policy.ts`: working-directory selection and session-versus-management invocation classification; no ambient skill/session/cloud restrictions.
- `src/process.ts`: Pi resolution, argument-vector execution, signals and leases.
- `src/lease.ts`: child/launcher liveness and conservative cleanup.
- `src/cli.ts`: grammar, command dispatch, errors and exit statuses.
- `src/prompts.ts`: interactive picker and typed confirmations, injected in tests.
- `src/extension.ts`: footer/title and read-only `/profile`.
- `tests/fixtures/fake-pi.mjs`: records only synthetic test argv/environment/cwd.
- `tests/*.test.ts`: pure, filesystem, process, package and extension tests.
- `docs/manual-smoke.md`, `README.md`, `.github/workflows/verify.yml`: verifiable operation and platform coverage.

Shared types (Task 1 owns definitions):

```ts
export interface ProfileMetadata {
  version: 1;
  name: string;
  defaultCwd: string | null;
  inheritEnvironment: string[];
  createdAt: string;
}
export interface Profile {
  root: string;
  metadata: ProfileMetadata;
}
export interface StoreOptions {
  profilesRoot: string;
  now: () => Date;
}
export interface LaunchRequest {
  profile: Profile;
  piArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export interface Lease {
  version: 1;
  id: string;
  hostname: string;
  launcherPid: number;
  childPid: number | null;
  createdAt: string;
  state: "starting" | "running" | "exited";
}
export class ProfileError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
```

Every test owns a fresh `mkdtemp` directory and deletes only that directory in afterEach. Never use real HOME as the test store. Pure functions accept environment/home paths instead of reading global state during tests.

## Task 1: Portable profile metadata and package foundation

**Files:** Create package/build configuration, `bin/pi-profile.js`, `src/contracts.ts`, `src/metadata.ts`, `src/paths.ts`, `tests/metadata.test.ts`, `tests/package.test.ts`.

**Consumes:** Spec slug/storage/version requirements.
**Produces:** `validateName(input: string): string`, `parseMetadata(input: unknown): ProfileMetadata`, `profilePath(parent: string, name: string): string`.

- [x] Add package scripts `build: tsc`, `typecheck: tsc --noEmit`, `test: vitest run`, `verify: npm run typecheck && npm test && npm run build`. Compile NodeNext ESM into dist. Declare Pi as a peer and a pinned development dependency; do not bundle Pi into runtime dependencies. Set the engine floor and bin/extension manifests.
- [x] Write the failing validation tests:

```ts
import { expect, test } from "vitest";
import { validateName, parseMetadata } from "../src/metadata.js";
test.each(["../work", "Work", "work/other", "con", "nul", "com1", "create", "a--b", "-a"])(
  "rejects unsafe name %s", name => expect(() => validateName(name)).toThrow()
);
test("accepts portable slugs", () => expect(validateName("client-a")).toBe("client-a"));
test("rejects unsupported metadata", () => expect(() => parseMetadata({ version: 2 })).toThrow());
```

- [x] Run `npm test -- tests/metadata.test.ts`; record missing-module/test failure before implementation.
- [x] Implement validation using a slug regex, reserved CLI names and Windows device basenames. Validate all required keys, ISO timestamp, absolute defaultCwd or null, unique environment names, and supported version. Reject unknown metadata keys to catch typos.

```ts
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Reject if !slug.test(name), device.test(name), or reserved.has(name).
```

- [x] Test manifest targets exist after build and published tarball excludes tests, auth fixtures and worktrees. Run `npm run verify` and `npm pack --dry-run`.
- [x] Commit only Task 1 files after green verification.

## Task 2: Transactional store and active-profile safety

**Files:** `src/profile-store.ts`, `src/transactions.ts`, `src/lease.ts`, `tests/store.test.ts`, `tests/transactions.test.ts`, `tests/lease.test.ts`.

**Consumes:** `StoreOptions`, `Profile`, metadata and path validators.
**Produces:** `ProfileStore` with `create(metadata): Promise<Profile>`, `list(): Promise<Profile[]>`, `get(name): Promise<Profile>`, `update(name, metadata): Promise<void>`, `rename(oldName,newName): Promise<void>`, `remove(name): Promise<void>`. `acquireLease(profile): Promise<{lease: Lease; setChild(pid:number): Promise<void>; release(): Promise<void>}>`.

- [x] Write filesystem tests for create/list/get, invalid markers, symlinked root/marker refusal, collisions and rename/remove while a lease is live. Use real filesystem operations in the temp store, not all mocked fs calls.

```ts
const store = new ProfileStore({ profilesRoot: tempRoot, now: () => new Date("2026-09-09T00:00:00Z") });
const work = await store.create({ version: 1, name: "work", defaultCwd: null, inheritEnvironment: [], createdAt: "2026-09-09T00:00:00Z" });
const lease = await acquireLease(work);
await expect(store.remove("work")).rejects.toThrow();
await lease.release();
expect((await store.get("work")).root).toBe(work.root);
```

- [x] Run failing tests, then implement an exclusive mutation lock under the stable parent, not inside a directory being renamed. Lease acquisition and destructive operations use the same lock so launch cannot race a successful emptiness check. A lock acquisition failure is a bounded actionable error, never a spin forever.
- [x] Stage create/rename updates in hidden sibling directories with owner tokens and a journal. Publish by rename without overwriting an existing destination. Rollback restores old marker/name; an uncertain journal blocks launch until explicit recovery, never deletes user data.
- [x] Store launcher and child PIDs before releasing the mutation lock around startup. Refuse destruction if either is live, PID identity is ambiguous, hostname differs, or startup was interrupted before child PID recording. Never call a missing launcher PID sufficient evidence of inactivity.
- [x] Test concurrent create of the same slug, launch-vs-remove interleaving, live child after launcher loss, stale unknown-host lease, injected failure between staging and promotion, and symlinks inside a removed profile. Removal unlinks links and does not traverse their targets. POSIX assertions cover 0700 directories/0600 metadata; Windows path safety still runs.
- [x] Run all tests/typecheck and commit store/transaction/lease changes.

## Task 3: Atomic explicit import

**Files:** `src/import.ts`, `tests/import.test.ts`.

**Consumes:** Task 2 mutation transactions and Task 1 validators.
**Produces:** `inspectImport(source: string): Promise<{externalResources: string[]}>`, `importProfile(store: ProfileStore, name: string, source: string): Promise<Profile>`.

- [x] Write tests with synthetic `auth.json` bytes, settings, nested package files, an internal relative symlink, an escaping link, and an absolute link. Assert source bytes and timestamps are not modified. Set escaping target to an unrelated test-owned directory and verify it is never copied or removed.

```ts
const secretFixture = Buffer.from("opaque-auth-fixture-not-a-real-token");
await writeFile(join(source, "auth.json"), secretFixture);
const imported = await importProfile(store, "personal", source);
expect(await readFile(join(imported.root, "auth.json"))).toEqual(secretFixture);
expect(await readFile(join(source, "auth.json"))).toEqual(secretFixture);
```

- [x] Run tests to demonstrate missing import implementation.
- [x] Use lstat-based traversal, preserving files/directories and only contained relative symlinks. Reject special files, absolute/escaping/dangling links, source/destination overlap, and filesystem changes that invalidate inspection. Do not execute imported packages or secret-bearing configuration commands. Exclude manager markers, leases and journals.
- [x] Copy to owned hidden staging, fix restrictive storage permissions without removing executable bits needed by package programs, create fresh metadata, then publish under mutation lock. Revalidate destination absence immediately before publication.
- [x] Inspect settings only as JSON data, without executing commands. Report absolute and home-relative resource references and session storage outside the source as preserved external paths; do not reject explicit native Pi configuration. Caller displays the report before confirmation; noninteractive import requires an explicit `--yes`.
- [x] Inject mid-copy failure and verify no valid partial destination, original data intact, and no deletion outside owned staging. Test import from an already marked profile excludes leases and copies no stale manager metadata.
- [x] Run all checks and commit import support.

## Task 4: Verified launch isolation policy

**Files:** `src/environment.ts`, `src/launch-policy.ts`, `tests/environment.test.ts`, `tests/launch-policy.test.ts`, `tests/pi-compatibility.test.ts`.

**Consumes:** Validated `Profile` and the confirmed native Pi boundary.
**Produces:** `buildEnvironment(profile: Profile, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv`, `validateLaunch(request: LaunchRequest): Promise<void>`.

- [ ] Write failing table tests for the documented provider variable set, AWS and Google selectors, Windows case-insensitive collisions, reserved launcher variables, nested Pi session markers and inherited session-root overrides.

```ts
const env = buildEnvironment(work, { PATH: "/test/bin", OPENAI_API_KEY: "fixture", PI_CODING_AGENT_DIR: "/personal", PI_CODING_AGENT_SESSION_DIR: "/personal/sessions" });
expect(env.PATH).toBe("/test/bin");
expect(env.OPENAI_API_KEY).toBeUndefined();
expect(env.PI_CODING_AGENT_DIR).toBe(work.root);
expect(env.PI_CODING_AGENT_SESSION_DIR).toBe("/personal/sessions"); // intentional native override
```

- [ ] Implement filtering in one maintained map. Enumerate actual inherited keys for Windows matching; do not retain duplicate cased profile/auth routing entries. Only PI_CODING_AGENT_DIR and PI_PROFILE_NAME are unconditionally replaced. Preserve native session overrides and ordinary environment variables. Never log credential values.
- [ ] Test that no skill exclusion is generated and no native settings are overwritten merely to enforce policy. Use temporary fixtures for one ambient home skill, one profile skill and one trusted project skill; home skills remain discoverable by design.
- [ ] Preserve `--session-dir`, `--session`, `--fork`, settings.sessionDir and inherited PI_CODING_AGENT_SESSION_DIR unchanged. Without overrides, assert separate default profile session locations. Include prompt text after `--` to prevent accidental argument reinterpretation.
- [ ] Test that known AWS/Google credential selector variables are stripped unless allowlisted, but HOME and SDK default locations remain unchanged. Document ambient cloud-file fallback rather than claiming it is blocked.
- [ ] Run real Pi offline compatibility checks with fake credentials only. A mock executable is not evidence of Pi discovery semantics. Record tested Pi version and supported range in documentation.
- [ ] Run all checks and commit the native launch policy.

## Task 5: Cross-platform process launcher

**Files:** `src/process.ts`, `tests/process.test.ts`, `tests/fixtures/fake-pi.mjs`.

**Consumes:** Launch validation, environment builder, lease owner.
**Produces:** `runPi(request: LaunchRequest, executable: {command:string; prefixArgs:string[]}): Promise<{code:number|null; signal:NodeJS.Signals|null}>`, `resolvePi(): Promise<{command:string; prefixArgs:string[]}>`.

- [ ] Write child-process tests for argv/cwd/env, nonzero exit, spawn failure, signal forwarding, and stdin/stdout inheritance. Use a fake Node executable with synthetic values, not a shell script.

```js
// tests/fixtures/fake-pi.mjs
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), profile: process.env.PI_PROFILE_NAME, root: process.env.PI_CODING_AGENT_DIR }));
process.exit(Number(process.env.TEST_EXIT_CODE || 0));
```

- [ ] Run failing process tests.
- [ ] Resolve normal Pi on POSIX. On Windows resolve the installed Node CLI entry behind the npm shim and launch via Node; do not concatenate user argv into cmd.exe or use shell:true. Reject an unsupported wrapper with actionable instructions rather than executing ambiguously quoted input.
- [ ] Implement spawn with an argument array, validated cwd, filtered environment, inherited stdio and child PID lease publication. Inject the absolute extension before session arguments, never after `--`. Keep management invocations free of session-only flags. Parse only enough Pi grammar to classify subcommands; a word in an option value is not a command.
- [ ] On child error/exit perform idempotent cleanup. Do not remove live-child evidence when only the parent is shutting down. Handle platform-specific signal behavior without double-delivering Ctrl+C from a shared process group.
- [ ] Test metacharacters, spaces, Unicode paths, `--`, print/json/rpc, concurrent profiles and same-profile sessions. Verify stdout remains machine-clean for JSON/RPC.
- [ ] Run tests/typecheck and commit launcher support.

## Task 6: Complete command-line management and prompts

**Files:** `src/cli.ts`, `src/prompts.ts`, `tests/cli.test.ts`, `tests/prompts.test.ts`.

**Consumes:** Store, importer, environment/policy, process runner.
**Produces:** `main(argv: string[], deps: CliDependencies): Promise<number>`; dependency object provides store, `runPi`, `inspectImport`, `importProfile`, `select`, `confirm`, `input`, cwd/env and output writers. Define the interface in cli.ts and use it in tests; production adapters are instantiated in bin entry.

- [ ] Write table-driven tests for create/list/show/rename/remove/import/config, picker cancellation, missing args without a TTY and every documented scriptable flag. Confirm denied prompts invoke no mutation dependency.

```ts
expect(parseCli(["--cwd", "/repo", "work", "-p", "--", "- literal"])).toEqual({
  command: "launch", profile: "work", cwd: "/repo", piArgs: ["-p", "--", "- literal"]
});
```

- [ ] Define/export `parseCli(argv: string[]): CliCommand` in cli.ts; discriminated union includes launch and each management command, with exact command-specific fields. Flags before profile are launcher-only. Flags after profile in launch mode belong to Pi. Config subcommand flags are parsed only in management mode.
- [ ] Run failing CLI tests, then implement dispatch. Prompt only with a terminal; report a missing explicit profile for bare noninteractive invocation. Typed removal confirmation must equal the exact slug; --force bypasses the prompt but never active-lease/path checks. Import uses --yes, never --force implying overwrite.
- [ ] Configure default cwd as an absolute path; `--clear-default-cwd` resets null. Validate `--inherit` names, reject reserved routing variables, and persist metadata under store lock. `config --pi` invokes normal Pi config with selected environment/cwd; no parallel metadata edit while its lease is live.
- [ ] Show only name/root/defaultCwd/allowlist names/lease diagnostics. Keep auth opaque. Errors go to stderr with stable nonzero codes. No matching command silently creates a profile.
- [ ] Test actual built bin invocation against the fake Pi after compiling, not just dependency-injected dispatch. Run package checks and commit CLI.

## Task 7: Indicator and read-only profile command

**Files:** `src/extension.ts`, `tests/extension.test.ts`.

**Consumes:** `PI_PROFILE_NAME` and `PI_CODING_AGENT_DIR` provided by launcher, Pi public API.
**Produces:** Default extension factory with session_start handler and `/profile` command.

- [ ] Write a fake ExtensionAPI test harness recording registrations and UI calls; make transcript APIs throw if called. Test startup/reload/new/resume/fork and no-profile no-op.

```ts
expect(ui.setStatus).toHaveBeenCalledWith("pi-profile", "profile: work");
expect(ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("[work]"));
expect(commands.has("profile")).toBe(true);
expect(transcriptCalls).toEqual([]);
```

- [ ] Run failing extension tests.
- [ ] Implement with public Pi imports, setting a namespaced status rather than replacing the footer. Build title from sanitized slug and cwd basename. On session_start reapply the label. Guard TUI title updates with mode; do not open prompts during print/json/RPC startup.
- [ ] `/profile` displays only current profile/root and external switching instructions through supported transient UI. Reject switching arguments; it does not spawn Pi, end the session, inspect credentials or create model messages. Without a profile marker show unprofiled status only when explicitly invoked.
- [ ] Test coexistence with another status key, safe handling of absent/malformed markers, and package entry loading under native Pi. No timers, filesystem watchers, tool registration, or identity authentication.
- [ ] Run full verification and commit extension.

## Task 8: End-to-end verification, CI and operating guide

**Files:** `README.md`, `docs/manual-smoke.md`, `.github/workflows/verify.yml`, `tests/e2e.test.ts`, `tests/package.test.ts`.

**Consumes:** Built CLI and extension from Tasks 1–7.
**Produces:** A installable npm tarball, CI matrix and evidence-backed manual checklist.

- [ ] Write a failing end-to-end test that creates work/personal using the built executable, configures different synthetic settings, launches both fake Pi children, compares roots/argv, and verifies no mutation of an existing unprofiled fixture. Test real Pi offline resource/session selection separately, including intentionally shared ambient skills and explicit session overrides.
- [ ] Add Node/OS CI matrix with `npm ci` and `npm run verify` on macOS/Linux/Windows using the minimum supported Node. Add active LTS Linux. Include package install from the produced tarball in a temporary prefix; ensure both executable and extension resolve without development files.

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    node: ['22.19.0']
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node }}
      cache: npm
  - run: npm ci
  - run: npm run verify
```

- [ ] Document npm global installation, unchanged plain Pi, every CLI command, optional manual alias, supported Pi/Node versions, inherited-variable names, trusted-project exception, ambient/cloud limitations, import symlink failures, active-profile safeguards and explicit recovery. Do not claim OS isolation or protected host filesystem access.
- [ ] Provide manual steps for different provider logins, refresh persistence, concurrent TUI indicators, profile-specific config/skills/trust/sessions, stale leases and Windows Ctrl+C. Real credentials remain a user action, not an automated fixture.
- [ ] Run `npm run verify`, `npm pack --dry-run`, tarball smoke tests, and `git diff --check`. Save actual command/version/status evidence; mark other-platform and real-login checks unverified until run.
- [ ] Request independent read-only code review, fix confirmed findings serially with regression tests, rerun checks. Do not call a review process exiting zero an approval without reading its findings.
- [ ] Commit the final verified state on the feature branch. If no authorized remote exists, deliver local branch/commit and unresolved manual checks; do not push/create a repository/merge. If a remote is subsequently authorized, follow the reviewed-PR workflow in no-merge mode.

## Plan self-review

- Storage/CRUD/transactions: Tasks 1–2.
- Explicit opaque import and destructive safety: Tasks 2–3.
- Known credential environment filtering and native shared-resource/session semantics: Task 4.
- Pi CLI compatibility, concurrent supervision and Windows safety: Task 5.
- Picker, management, native settings and default cwd: Task 6.
- Indicators and previously omitted `/profile`: Task 7.
- Package, documentation, CI, real compatibility and review evidence: Task 8.
- All execution is serial. No worker should introduce the rejected strict global-skill/session/cloud restrictions.
- User clarification resolves the earlier boundary gate. Start implementation, keep native behavior, and record remaining platform/manual evidence honestly.
