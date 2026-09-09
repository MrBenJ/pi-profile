# Manual smoke checklist

Use only disposable test accounts and profiles. Automated tests must never perform these credential steps.

## Installation and unchanged plain Pi

- [ ] Record `node --version`, `npm --version`, `pi --version`, OS, terminal, and `pi-profile` package version.
- [ ] Install the packed package or published package globally.
- [ ] Run plain `pi`; confirm it still uses the existing `~/.pi/agent` settings and has no profile indicator.
- [ ] Confirm no shell alias or shell configuration was changed automatically.

## Import and independent configuration

- [ ] Snapshot file names, sizes, and timestamps in a disposable source Pi root.
- [ ] Run `pi-profile import personal <source>` and review the credential/session/code warning plus external paths.
- [ ] Confirm source bytes and timestamps are unchanged.
- [ ] Confirm absolute, escaping, and dangling symlink fixtures are rejected without changing their targets.
- [ ] On Windows with Developer Mode, import a relative directory symlink, rename the profile, and confirm the link remains relative and usable; with symlink privilege disabled, confirm import reports the required permission instead of creating a junction.
- [ ] Run `pi-profile create work`.
- [ ] Set different default directories and run `pi-profile config <name> --pi` for both profiles.

## Real provider accounts (user-only)

- [ ] Launch `personal`, use `/login`, and authenticate a disposable personal provider account.
- [ ] Launch `work`, use `/login`, and authenticate a different disposable work provider account.
- [ ] Restart both and confirm token refresh/login persistence remains distinct.
- [ ] Use `/logout` in one profile and confirm the other remains logged in.

## Resources, trust, models, and sessions

- [ ] Install one test Pi package/extension/skill only in `work` and confirm it is absent from profile-managed `personal` resources.
- [ ] Confirm a skill under `~/.agents/skills` remains visible in both profiles by design.
- [ ] In a disposable project, make different trust decisions and confirm each profile's decision persists independently.
- [ ] Set different default models and confirm each profile restores its own model.
- [ ] Create sessions in each profile and confirm default session lists are distinct.
- [ ] Pass `--session-dir`, `--session`, and `--fork` paths and confirm Pi retains its native explicit cross-profile behavior.
- [ ] Set `PI_CODING_AGENT_SESSION_DIR` and `settings.sessionDir`; confirm native precedence is `--session-dir`, environment, then settings.

## Environment boundary

- [ ] Export synthetic values for every denylisted variable; launch both profiles and verify they are absent from Pi child tools by default.
- [ ] Allowlist one synthetic variable only in `work`; confirm only `work` receives the parent value.
- [ ] Confirm `HOME`, ordinary development variables, and cloud config directory variables remain unchanged.
- [ ] Separately assess cloud SDK default-file/metadata authentication; do not interpret environment stripping as disabling those mechanisms.

## Concurrent lifecycle and UI

- [ ] Launch `work` and `personal` concurrently; confirm distinct footer labels and terminal titles.
- [ ] Launch two `work` sessions concurrently; confirm both run and rename/removal remain blocked until both exit.
- [ ] Terminate a launcher while its child remains alive; confirm rename/removal remain blocked.
- [ ] Create a same-host stale lease fixture; confirm interactive cleanup asks and scripted cleanup requires `--clear-stale-leases`.
- [ ] Create an unknown-host lease fixture; confirm it is never cleared automatically.
- [ ] Interrupt a disposable import process, verify ordinary commands report the lock owner, then run `pi-profile recover`; confirm only same-host/provably-dead owner artifacts are removed.
- [ ] Interrupt rename before moving the source, while staged, and after destination promotion; confirm recovery respectively restores source metadata, moves staging back to source, or verifies the committed destination. Add a collision and confirm recovery changes nothing.
- [ ] Attempt recovery with a live PID, inaccessible PID state, malformed owner, and another hostname; confirm every case remains blocked and unchanged.
- [ ] Run `/profile`; confirm it displays only name/root and cannot switch profiles.

## Windows-specific

- [ ] Verify npm's `pi.cmd` resolves to the installed Node CLI without `shell:true`.
- [ ] Test spaces, metacharacters, and Unicode in profile cwd and Pi arguments.
- [ ] Test Ctrl+C from Windows Terminal and confirm Pi receives one terminal interrupt, the launcher waits for it to exit, and the lease is removed; retain conservative evidence if the child survives.
- [ ] Confirm path/device-name validation and normal current-user ACL behavior.

## Linux-specific

- [ ] Verify directory mode `0700` and manager file mode `0600` on the target filesystem.
- [ ] Test SIGTERM/SIGHUP forwarding and lease cleanup.

Record unverified items honestly in `docs/implementation-evidence.md`.
