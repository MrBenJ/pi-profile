# Implementation Evidence

Evidence is recorded from temporary fixtures only. No real Pi credentials or `~/.pi` profile data are used or modified.

## Task 4 native compatibility

- Date: 2026-09-09
- Platform: macOS (`darwin`)
- Node: `v26.8.1`
- npm: `11.19.0`
- Pi: `0.85.1`
- Command shape: temporary `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE=1`, synthetic OpenAI auth key, `pi --offline --list-models`
- Result: PASS; Pi reported version `0.85.1` and listed 40 offline catalog rows.
- Supported baseline: Pi `0.85.1` is verified. Compatibility with later Pi versions is expected through documented public CLI/extension APIs but remains subject to their compatibility.

## Task 6 built launcher smoke

- Built the CLI, created `work` under a temporary HOME, resolved a temporary executable fake Pi from PATH, and launched `work --mode json -- synthetic-prompt`.
- Result: PASS; captured exact profile root/name, indicator injection, and trailing prompt argument.

## Task 7 native extension smoke

- Ran Pi `0.85.1` offline in RPC/no-session mode with a temporary agent root, synthetic fake auth, and the built extension.
- Result: PASS; `get_commands` included `/profile` and RPC emitted namespaced `setStatus` with `profile: agent`.

## Task 8 native resource and session smoke

- Platform: macOS (`darwin`), Pi `0.85.1`, offline RPC mode, synthetic fake auth only.
- Temporary fixtures: ambient `$HOME/.agents/skills`, selected-profile `skills`, trusted project `.pi/skills`, and `PI_CODING_AGENT_SESSION_DIR`.
- Result: PASS; `get_commands` reported all three synthetic skills and `/profile`, and `get_state.sessionFile` was under the explicit temporary session root.

## Independent review round 1 fixes

Result accounting: **8 findings fixed, 0 deferred**.

Claude Opus reviewed the branch read-only. The implementation worker did not spawn a reviewer. All eight reported items received regressions and fixes:

- stale mutation locks now carry owner id/hostname/PID/time, normal release verifies ownership, and explicit `pi-profile recover` refuses live, unknown, remote, malformed, or path-ambiguous state;
- interrupted imports and orphan import stages have conservative same-host/dead-owner recovery tests;
- import copying occurs outside the parent mutation lock, with destination/journal revalidation during brief publication;
- reads coordinate on the parent lock and no longer misreport a healthy journal as abandoned;
- Pi `auth` and `uninstall` join every documented native management command, with exact-argv and real Pi offline parser tests;
- `--help`, `-h`, `help`, `--version`, and `-v` provide local CLI output;
- profile metadata updates use a locked read-transform-write operation, and concurrent inherited-name updates retain both names;
- the former compatibility fixture is now an honest policy-contract test; real offline Pi coverage lives in `tests/native-pi.test.ts`;
- picker, import, config, and removal cancellations emit explicit messages.

Native built-CLI checks: PASS — `pi-profile work --offline auth --help` and `uninstall --help` produced Pi's native command help without indicator injection.

## Independent review round 2 fixes

Result accounting: **8 findings fixed, 0 deferred**.

Claude Opus performed a second full-feature read-only review. No further reviewer was delegated. Every reported item received a regression and fix:

- rename journals now validate stale ownership, journal filename, metadata, exact source/staging/destination paths, and names before mutation; sole-source, sole-staging, and sole-committed-destination crash windows recover deterministically, while collisions and unsafe paths remain untouched;
- orphan import staging without a valid owner marker now raises an actionable `RECOVERY_REQUIRED` error;
- Windows imports preserve relative directory symlinks with type `dir`, never absolute staging junctions, and return `SYMLINK_PERMISSION` for missing Windows privilege; promotion and subsequent rename are covered;
- `prepack` builds TypeScript, with a real `npm pack --json` regression starting from a copied checkout containing no `dist` directory;
- a primary mutation failure remains the `AggregateError.cause` when owner-verified lock cleanup also fails, while cleanup context is retained;
- SIGINT handling waits for/reaps the child and releases its lease, forwarding only for non-terminal single-process signals to avoid duplicate terminal delivery;
- `--cwd` before a manager command reports targeted usage, and normal launch plus `config --pi` share signal exit mapping.

## Independent review round 3 fixes

Result accounting: **1 major fixed, 5 minor addressed (3 code fixes, 1 documented behavior, 1 cleanup implementation deferred with safety rationale), and 2 nits fixed**. The three-round cap is reached.

- **MAJOR fixed:** Windows `resolvePi()` now probes both the global npm layout (`<PATH>/node_modules/@earendil-works/.../cli.js`) and local project layout (`node_modules/.bin/../@earendil-works/.../cli.js`), returning `process.execPath` plus the bundle argument with `shell: false`. Platform-injected tests cover both layouts.
- **MINOR fixed:** lease parsing requires positive safe-integer launcher and child PIDs.
- **MINOR fixed:** child outcome rejection handling is attached immediately; lease-publication failure sends termination, drains/reaps the child, and retains the conservative lease evidence.
- **MINOR fixed:** create failures after destination promotion now return `CREATE_COMMITTED_CLEANUP_PENDING`, preserve the journal, and direct the next invocation to recovery instead of implying creation failed.
- **MINOR documented behavior:** `defaultCwd` deliberately permits currently nonexistent removable/network/future paths; the effective directory is validated immediately before every launch, matching the approved specification.
- **MINOR deferred cleanup:** crash-left `.pi-profile.lock.release-*` and atomic `.*.tmp` artifacts are harmless and nonblocking. Automatic deletion is deferred because provenance cannot always be proven and broad cleanup could remove another owner's evidence. README/manual recovery guidance now states this limitation.
- **NIT fixed:** help lists `--clear-stale-leases` for rename and removal.
- **NIT fixed after native verification:** Pi 0.85.1 accepts `--export=<file>` (offline `--help` exited 0); classification recognizes that exact form without rewriting argv.

The latest independent review verdict contains the findings above and predates these fixes. Per the requested cap, no fourth reviewer was launched, so there is **no post-fix clean independent verdict**.

## Final automated verification

- Versions: Node `v26.8.1`; npm `11.19.0`; Pi `0.85.1`.
- `npm run verify`: PASS — 15 test files, 208 tests; TypeScript no-emit check and compiled build passed.
- `npm pack --dry-run`: PASS — package contained only declared runtime/docs files.
- Real `npm pack` plus isolated `npm install --legacy-peer-deps --ignore-scripts <tarball>`: PASS; executable, CLI, extension, README, and license resolved, and installed CLI created a profile under a temporary HOME.
- Tarball exclusion check: PASS — no tests, `auth.json`, or `.worktrees` paths.
- Round-two final smoke: PASS — fresh `npm pack --dry-run`; native Pi offline `auth`/`uninstall` help through the built launcher; tarball exclusion scan; isolated tarball install; packed CLI help/version/profile creation; and `git diff --check`.
- `git diff --check`: PASS.

## Not verified in this environment

- Linux and Windows CI jobs, Node `22.19.0`, Windows npm-shim/Ctrl+C behavior, and Linux filesystem/signal behavior are defined in CI/manual checks but were not run locally.
- Real OAuth/API-key login, logout, refresh, provider account crossover, and cloud SDK default-file/metadata authentication were not tested. Those require user-controlled disposable accounts and may access networks.
- Interactive TUI footer/title appearance, concurrent human TUI sessions, and manual trust/model/session selectors were not visually verified; RPC and extension harness behavior passed.
- Destructive recovery from a real crash, PID reuse, unknown-host leases, and journal recovery were tested through synthetic interrupted state where automated, not through destructive host-level fault injection.
- Independent read-only review rounds 1–3 completed and the review cap was reached. Round-three fixes have no subsequent clean independent verdict. No nested reviewer was launched by this worker.
