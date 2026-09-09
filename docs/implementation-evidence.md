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

Additional final verification and unverified manual/platform checks are recorded after Task 8.
