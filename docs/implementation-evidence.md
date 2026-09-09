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
- Pi `auth` and `uninstall` join every documented native management command, with exact-argv fake-process coverage; the original native help test was later found weak and is explicitly retracted below;
- `--help`, `-h`, `help`, `--version`, and `-v` provide local CLI output;
- profile metadata updates use a locked read-transform-write operation, and concurrent inherited-name updates retain both names;
- the former compatibility fixture is now an honest policy-contract test; real offline Pi coverage lives in `tests/native-pi.test.ts`;
- picker, import, config, and removal cancellations emit explicit messages.

**Retracted historical evidence:** `pi-profile work --offline auth --help` and `uninstall --help` prepended `--offline`, so Pi did not dispatch those argv-zero subcommands; general `--help` made the assertions pass. This is not native command evidence. Replacement evidence is recorded under “Post-review acceptance corrections.”

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
- **Retracted NIT claim:** the help-based check did not prove `--export=<file>` support. Direct Pi 0.85.1 `parseArgs` inspection later confirmed this form lands in `unknownFlags` and does not set `export`; the acceptance correction removes the special classification.

The latest independent review verdict contains the findings above and predates these fixes. Per the requested cap, no fourth reviewer was launched, so there is **no post-fix clean independent verdict**.

## Post-review acceptance corrections

User-authorized final acceptance work corrected the remaining review defects without another delegated reviewer:

- invocation classification now follows Pi 0.85.1’s actual dispatch boundary: management subcommands only at `argv[0]`; later `auth`/`list` words remain session input and retain indicator injection;
- direct native `parseArgs` assertions prove `--export <file>` is supported while `--export=<file>` is an unknown extension flag; argv remains unchanged;
- built `pi-profile` tests invoke `work auth --help` and `work uninstall --help` with offline mode in the environment, assert subcommand-unique output, and run non-help `auth check --provider openai --json --no-refresh` against a temporary credential-free profile;
- lease-publication failure removes its exact unchanged lease only after a child `exit` event; timeout/error retains the exact evidence path and child PID for supported manual inspection;
- Windows npm resolution reads a contained `bin.pi` from package metadata in both known roots instead of hard-coding Pi internals (platform-injected tests only; Windows is not a macOS release blocker);
- post-promotion rename cleanup errors report committed destination state plus source/staging/destination candidates, retain the journal, and recover without data loss;
- empty `list` parent initialization is documented as benign locking setup, and interrupted `/.pack-fixture-*/` directories are ignored.

User-reported acceptance checks 1–5 passed on macOS, including isolated real OAuth refresh and live-child cancellation/recovery. This implementation worker did not repeat or access those credentials. User-reported Linux Docker verification on Node `22.19.0` passed 208 tests; it is recorded as external evidence only. The authorized release target is macOS, so Windows/Linux manual execution is not a release blocker.

## Final automated verification

- Versions: Node `v26.8.1`; npm `11.19.0`; Pi `0.85.1`.
- `npm run verify`: PASS — 15 test files, 217 tests; TypeScript no-emit check and compiled build passed.
- `npm pack --dry-run`: PASS — package contained only declared runtime/docs files.
- Real `npm pack` plus isolated `npm install --legacy-peer-deps --ignore-scripts <tarball>`: PASS; executable, CLI, extension, README, and license resolved, and installed CLI created a profile under a temporary HOME.
- Tarball exclusion check: PASS — no tests, `auth.json`, or `.worktrees` paths.
- Round-two final smoke: PASS — fresh `npm pack --dry-run`; native Pi offline `auth`/`uninstall` help through the built launcher; tarball exclusion scan; isolated tarball install; packed CLI help/version/profile creation; and `git diff --check`.
- **Partially retracted round-three smoke:** package/tarball/install/diff checks passed, but `--export=<file>` and prepended-`--offline` help checks did not establish the claimed parser/dispatch behavior. Replacement native parser, argv-zero subcommand, and non-help checks are recorded above.
- Post-acceptance final smoke: PASS — built-launcher argv-zero auth/uninstall help with subcommand-unique assertions; offline credential-free auth non-help JSON; direct native `parseArgs` supported/equals export semantics; fresh pack; tarball exclusion scan; isolated install/profile creation; and clean diff/status.
- `git diff --check`: PASS.

## Not verified in this environment

- Windows runtime npm-shim/Ctrl+C and Linux filesystem/signal behavior were not run by this worker; platform-injected Windows tests pass. They are not blockers for the authorized macOS release target.
- This worker did not repeat real OAuth/API-key login, logout, refresh, provider account crossover, or cloud SDK default-file/metadata authentication. User-reported macOS acceptance included successful isolated real OAuth refresh; all other credential-dependent checks remain user-controlled.
- Interactive TUI footer/title appearance, concurrent human TUI sessions, and manual trust/model/session selectors were not visually verified; RPC and extension harness behavior passed.
- Destructive recovery from a real crash, PID reuse, unknown-host leases, and journal recovery were tested through synthetic interrupted state where automated, not through destructive host-level fault injection.
- Independent read-only review rounds 1–3 completed. These acceptance corrections have no subsequent clean independent verdict; a fresh orchestrator-owned full-branch review is pending. No reviewer was launched by this worker.
