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

## Final automated verification

- Versions: Node `v26.8.1`; npm `11.19.0`; Pi `0.85.1`.
- `npm run verify`: PASS — 15 test files, 184 tests; TypeScript no-emit check and compiled build passed.
- `npm pack --dry-run`: PASS — package contained only declared runtime/docs files.
- Real `npm pack` plus isolated `npm install --legacy-peer-deps --ignore-scripts <tarball>`: PASS; executable, CLI, extension, README, and license resolved, and installed CLI created a profile under a temporary HOME.
- Tarball exclusion check: PASS — no tests, `auth.json`, or `.worktrees` paths.
- `git diff --check`: PASS.

## Not verified in this environment

- Linux and Windows CI jobs, Node `22.19.0`, Windows npm-shim/Ctrl+C behavior, and Linux filesystem/signal behavior are defined in CI/manual checks but were not run locally.
- Real OAuth/API-key login, logout, refresh, provider account crossover, and cloud SDK default-file/metadata authentication were not tested. Those require user-controlled disposable accounts and may access networks.
- Interactive TUI footer/title appearance, concurrent human TUI sessions, and manual trust/model/session selectors were not visually verified; RPC and extension harness behavior passed.
- Destructive recovery from a real crash, PID reuse, unknown-host leases, and journal recovery were tested through synthetic interrupted state where automated, not through destructive host-level fault injection.
- Independent read-only review round 1 completed; orchestrator round 2 is pending. No nested reviewer was launched by this worker.
