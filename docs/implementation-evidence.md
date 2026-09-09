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

Additional final verification and unverified manual/platform checks are recorded after Task 8.
