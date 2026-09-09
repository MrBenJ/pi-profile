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

## Final automated verification

- Versions: Node `v26.8.1`; npm `11.19.0`; Pi `0.85.1`.
- `npm run verify`: PASS — 14 test files, 158 tests; TypeScript no-emit check and compiled build passed.
- `npm pack --dry-run`: PASS — package contained only declared runtime/docs files.
- Real `npm pack` plus isolated `npm install --legacy-peer-deps --ignore-scripts <tarball>`: PASS; executable, CLI, extension, README, and license resolved, and installed CLI created a profile under a temporary HOME.
- Tarball exclusion check: PASS — no tests, `auth.json`, or `.worktrees` paths.
- `git diff --check`: PASS.

## Not verified in this environment

- Linux and Windows CI jobs, Node `22.19.0`, Windows npm-shim/Ctrl+C behavior, and Linux filesystem/signal behavior are defined in CI/manual checks but were not run locally.
- Real OAuth/API-key login, logout, refresh, provider account crossover, and cloud SDK default-file/metadata authentication were not tested. Those require user-controlled disposable accounts and may access networks.
- Interactive TUI footer/title appearance, concurrent human TUI sessions, and manual trust/model/session selectors were not visually verified; RPC and extension harness behavior passed.
- Destructive recovery from a real crash, PID reuse, unknown-host leases, and manual journal recovery were tested through synthetic state where automated, not through destructive host-level fault injection.
- Independent read-only review is pending from the orchestrator, as required by the execution boundary; no nested reviewer was launched by this worker.
