# Pi Profile Design

**Date:** 2026-09-09
**Status:** Approved in conversation; awaiting written-spec review
**Target package:** `pi-profile`
**Target repository:** `/Users/bjunya/code/hbai/opensource/pi-customizations/pi-profile`

## Summary

`pi-profile` is a cross-platform Node.js package that launches fully isolated Pi experiences from one operating-system account. Each profile uses a separate Pi configuration directory, so work and personal credentials, OAuth tokens, settings, packages, extensions, skills, models, trust decisions, caches, and sessions do not cross profile boundaries.

The package exposes a `pi-profile` executable and a lightweight Pi extension. The executable selects and manages profiles, filters provider authentication variables, sets Pi's supported `PI_CODING_AGENT_DIR` override, and launches the normal Pi executable. The extension continuously displays the selected profile in Pi's footer and terminal title.

Profiles share only installed program code: the Pi executable and the `pi-profile` package. Mutable Pi data remains profile-specific. The existing `~/.pi/agent` installation is never modified automatically.

## Goals

- Launch a work or personal Pi instance without manually moving configuration or logging accounts in and out.
- Isolate all Pi-managed mutable data by profile.
- Prevent accidental fallback to provider credentials inherited from the parent shell.
- Preserve Pi's native extension, skill, package, authentication, trust, model, and session behavior inside each profile.
- Keep plain `pi` unchanged.
- Support an optional future shell alias without modifying shell configuration in version 1.
- Support macOS, Linux, and Windows from one Node.js package.
- Make the active profile continuously visible in interactive Pi sessions.
- Allow different profiles to run concurrently without global swaps or shared mutable active-profile state.

## Non-goals

Version 1 will not:

- provide operating-system sandboxing or multi-user access control;
- install a separate Pi binary per profile;
- switch profiles inside a running Pi process;
- synchronize or implicitly share resources between profiles;
- store, encrypt, display, or manage credentials outside Pi's own authentication system;
- modify the user's shell aliases or replace plain `pi`;
- export or back up profiles;
- disable Pi's normal trusted project-local resource behavior;
- hide ordinary development environment variables from Pi tools.

## Technical basis

Pi supports `PI_CODING_AGENT_DIR` as an override for its configuration directory. Pi resolves its global settings, credentials, model configuration, package installations, extension and skill locations, trust store, and default session storage relative to that directory. This creates the required isolation before extensions and resources are discovered.

An extension cannot reliably disable sibling extensions after they have loaded. Profile selection must therefore happen before Pi startup. `pi-profile` is primarily a launcher and profile manager; its Pi extension is intentionally limited to visible status.

Explicit `--extension` paths still load when Pi receives `--no-extensions`. The launcher can therefore inject its indicator extension without forcing discovery of the selected profile's other extensions.

## Storage model

Profiles live under the user's home directory:

```text
~/.pi/
├── agent/                         # existing Pi installation; untouched
└── profiles/
    ├── personal/
    │   ├── .pi-profile.json
    │   ├── auth.json
    │   ├── settings.json
    │   ├── models.json
    │   ├── models-store.json
    │   ├── trust.json
    │   ├── sessions/
    │   ├── extensions/
    │   ├── skills/
    │   ├── npm/
    │   └── git/
    └── work/
        └── ...
```

The exact Pi-owned files and directories may evolve with Pi. `pi-profile` treats the selected profile directory as an opaque Pi configuration root rather than assuming that the illustrated children always exist.

Each root contains one manager-owned `.pi-profile.json` marker:

```json
{
  "version": 1,
  "name": "work",
  "defaultCwd": null,
  "inheritEnvironment": [],
  "createdAt": "2026-09-09T00:00:00.000Z"
}
```

The marker contains no credentials. Metadata changes use atomic replacement. On POSIX systems, newly created profile directories use mode `0700` and manager-owned files use mode `0600`. Windows uses the current user's normal filesystem ownership and access-control behavior; unsupported POSIX mode guarantees are not claimed there.

There is no central active-profile file. The CLI discovers profiles by enumerating valid marked directories under `~/.pi/profiles`. This removes shared selection state and permits simultaneous launches.

## Profile names

Profile names are portable lowercase slugs made from letters, numbers, and single hyphens. They cannot begin or end with a hyphen, contain consecutive hyphens, equal `.` or `..`, or contain path separators. Names used by `pi-profile` management commands are reserved and cannot be profile names.

All resolved profile paths must remain direct children of the profiles directory after normalization. User input can never supply an arbitrary destination path for normal profile operations.

## CLI experience

The npm package exposes a `pi-profile` executable.

### Launching

```text
pi-profile
pi-profile work
pi-profile work -p "Review this repository"
pi-profile work --model anthropic/claude-sonnet-4-5
pi-profile --cwd ~/code/company work
```

A bare invocation opens an interactive profile picker. Supplying a profile name launches it directly. Launcher options, including `--cwd`, appear before the profile name. Every argument after the profile name is forwarded to Pi in its original order and without semantic rewriting.

Unknown profile names fail with a concise error and a suggested `pi-profile create <name>` command. They are never created implicitly.

The launcher uses `--cwd` when supplied, otherwise the profile's configured default directory, otherwise the caller's current directory. A selected directory that does not exist is an error rather than a silent fallback.

### Management commands

Version 1 provides:

```text
pi-profile create [name]
pi-profile list
pi-profile show <name>
pi-profile rename <old> <new>
pi-profile remove <name>
pi-profile import <name> <source-directory>
pi-profile config <name>
```

Missing values can be collected interactively when a terminal is available. Non-interactive use requires explicit arguments and fails rather than hanging for input.

`list` and `show` display metadata and paths but never inspect or print `auth.json`. Output intended for automation must not include secret-bearing file contents.

`config` offers these operations:

- run Pi's native `pi config` under the selected profile;
- set or clear the profile's default working directory;
- add or remove inherited environment-variable names.

Scriptable forms are:

```text
pi-profile config work --pi
pi-profile config work --default-cwd ~/code/company
pi-profile config work --clear-default-cwd
pi-profile config work --inherit AWS_PROFILE
pi-profile config work --no-inherit AWS_PROFILE
```

Pi resource enablement remains represented exclusively by Pi's native settings; `pi-profile` does not create a second extension or skill enablement format.

Pi management commands that are intentionally forwarded through a selected profile run under that profile's configuration root. Session-only profile indicators are not required for non-session management processes.

## Profile creation

Creating a profile:

1. validates the name and destination;
2. creates the profile root with restrictive permissions where supported;
3. writes the versioned marker atomically;
4. records an optional default working directory and environment allowlist;
5. leaves Pi-owned configuration files absent until Pi creates them.

Creation fails without altering an existing profile or partially replacing another profile. If an error occurs after creating a new destination, the CLI removes only artifacts created by that failed operation when it can prove ownership of them.

## Import behavior

`pi-profile import personal ~/.pi/agent` copies an existing Pi configuration root into a new profile. It does not make the original directory the live backing store.

The import flow:

1. validates the source directory and new profile name;
2. verifies that the destination does not exist;
3. summarizes that credentials, sessions, and installed code may be included;
4. requires explicit confirmation;
5. copies into a temporary sibling directory while excluding source `.pi-profile.json` and `.pi-profile-leases/` manager metadata;
6. preserves internal relative symlinks;
7. rejects absolute symlinks and symlinks whose resolved targets escape the source tree;
8. reports configured absolute resource paths that still refer outside the imported root;
9. writes a new profile marker for the destination;
10. atomically promotes the completed temporary directory to the final profile path.

The source is never modified or removed. A failed import removes its owned temporary destination and leaves no valid partial profile.

External resource paths are reported because they refer to shared code locations. They do not merge Pi-managed credentials or mutable configuration roots, but the user must be aware that editing shared extension or skill source can affect every profile that explicitly references it.

## Rename and removal

Rename validates both names and refuses collisions. It moves the old directory to a unique temporary sibling, atomically updates the marker there, and then renames the temporary directory to the final name. Any failure before the final rename rolls the directory and marker back to the old name; an unrecoverable rollback failure stops with both exact paths reported and never deletes either directory. Cross-device moves are unnecessary because every stage lives under one profile parent.

Removal displays the profile path and warns that credentials and sessions will be permanently deleted. Interactive removal requires entering the exact profile name. Automation requires `--force`.

Launchers create per-process runtime leases inside a manager-owned `.pi-profile-leases/` directory. A lease records a random id, launcher PID, hostname, and creation time but no credentials or arguments. Rename and removal refuse to operate while a lease's PID is live or cannot be checked safely. A same-host lease whose PID no longer exists is reported as stale; interactive rename/removal requires confirmation to clear it, while automation requires `--clear-stale-leases`. Leases from another hostname are treated as unverifiably live and are never cleared automatically.

Multiple concurrent launches of the same profile are allowed. Each launch owns a distinct lease and removes only that lease during normal shutdown.

## Launch data flow

A normal `pi-profile <name> ...` invocation performs these steps:

1. Parse the profile name and forwarded Pi arguments.
2. Resolve the selected direct-child profile path.
3. Validate the marker version and name/path consistency.
4. Validate the selected working directory.
5. Create a unique runtime lease.
6. Build the filtered child environment.
7. Override `PI_CODING_AGENT_DIR` with the absolute profile root.
8. Override `PI_PROFILE_NAME` with the validated profile name.
9. Add an explicit `--extension <indicator-entrypoint>` argument for session-producing Pi invocations.
10. Spawn the normal `pi` executable with inherited standard input, output, and error streams.
11. Forward termination signals where required by the platform.
12. Remove the launcher's own lease and exit with Pi's exit status.

The implementation must use argument-vector process spawning rather than shell command construction. Profile names, paths, and forwarded arguments are never interpolated into a shell string.

The launcher resolves the Pi executable using normal cross-platform executable lookup. A missing or unexecutable Pi installation produces a specific setup error.

## Authentication isolation

Pi remains the sole owner of provider credentials. With the selected profile as `PI_CODING_AGENT_DIR`:

- `/login` reads and writes that profile's `auth.json`;
- `/logout` affects only that profile;
- OAuth token refresh persists only in that profile;
- provider-scoped credential environment stored by Pi remains in that profile;
- model availability is resolved against that profile's credentials.

`pi-profile` never parses, displays, logs, transforms, or independently encrypts credentials. Import and deletion treat credential files as opaque filesystem entries.

## Environment policy

Pi's credential resolution falls back from `auth.json` to process environment variables. The launcher prevents accidental account crossover by starting from a copy of the parent environment and deleting a maintained set of Pi-supported provider authentication variables and cloud credential selectors.

The filtered set includes:

- provider API-key, OAuth-token, bearer-token, and subscription-token variables documented by Pi;
- AWS access keys, session tokens, bearer tokens, web-identity selectors, and profile selectors used by Bedrock;
- Google application-credential selectors used by Vertex;
- Azure authentication selectors used by Azure OpenAI;
- other provider-specific authentication variables added to Pi's documented provider map.

A filtered variable survives only when its exact name appears in the selected profile's `inheritEnvironment` allowlist. The allowlist stores names, never values. Values continue to come from the launcher's parent environment.

The launcher unconditionally replaces inherited `PI_CODING_AGENT_DIR` and `PI_PROFILE_NAME`. A nested profiled shell therefore cannot redirect a newly requested profile back to the parent profile.

One centralized, tested module defines the deny set and is updated when supported Pi providers change. User-facing documentation lists the effective set for the installed package version.

This policy prevents known Pi provider authentication fallback. It does not scrub every arbitrary environment variable, prevent tools from reading the process environment, or provide an OS sandbox.

## Project-local resources

Profiled launches preserve Pi's normal project trust behavior. A repository's `.pi/settings.json`, `.pi/extensions/`, `.pi/skills/`, or `.agents/skills/` can load after Pi trusts that project.

Trust remains isolated because each profile has its own `trust.json`. Trusting a repository in `personal` does not trust it in `work`. Explicit Pi trust flags retain their normal per-run meaning.

## Indicator extension

The package declares a lightweight Pi extension that the launcher loads explicitly for interactive, session-producing launches.

On `session_start`, including startup, reload, new session, resume, and fork, it reads the validated `PI_PROFILE_NAME` value and sets:

- footer status: `profile: work`;
- terminal title containing the profile name and current project context.

It uses a namespaced status key and does not replace Pi's complete footer. It does not send messages, append session entries, alter model context, register tools, or manage authentication.

In print and JSON modes, UI behavior is a safe no-op. RPC behavior uses only UI methods supported by that mode. The profile environment marker remains available to the Pi process regardless of UI mode.

A missing profile marker is handled quietly when the extension is loaded outside `pi-profile`; the extension does not pretend that an unprofiled Pi process is isolated. Isolation validation and launch failures belong to the launcher.

## Failure handling

The CLI fails closed for:

- malformed, unsupported, or inconsistent profile metadata;
- profile paths that escape the profile parent;
- missing profiles or duplicate destinations;
- missing configured working directories;
- unsafe import symlinks;
- active-profile rename or removal;
- failure to create restrictive profile storage where a platform claims support;
- missing Pi executable;
- child-process spawn failure.

Errors identify the failed operation and safe recovery step without printing environment values or credential contents.

Signals and exit codes preserve normal CLI composition. Normal Pi exits return Pi's exit code. Signal termination is represented using the platform's conventional behavior. Cleanup handles normal exit, spawn failure, and supported termination signals without deleting another launcher's lease.

## Package and repository

Implementation creates a new sibling repository at:

```text
/Users/bjunya/code/hbai/opensource/pi-customizations/pi-profile
```

Planned package structure:

```text
pi-profile/
├── .github/workflows/verify.yml
├── bin/
│   └── pi-profile.js
├── src/
│   ├── cli.ts
│   ├── commands/
│   │   ├── config.ts
│   │   ├── create.ts
│   │   ├── import.ts
│   │   ├── launch.ts
│   │   ├── list.ts
│   │   ├── remove.ts
│   │   ├── rename.ts
│   │   └── show.ts
│   ├── environment.ts
│   ├── extension.ts
│   ├── lease.ts
│   ├── metadata.ts
│   ├── paths.ts
│   ├── process.ts
│   └── profile-store.ts
├── tests/
├── docs/
│   ├── manual-smoke.md
│   └── superpowers/specs/
├── LICENSE
├── README.md
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

Public behavior and security boundaries in this design are authoritative; implementation planning may split a listed module into smaller private modules without changing those contracts.

The package requires Node.js 22.19.0 or newer and uses TypeScript and Vitest. Pi libraries are peer dependencies where imported at runtime and pinned development dependencies for verification. The package exposes the `pi-profile` executable through `package.json`'s `bin` field and declares the indicator through `pi.extensions`.

## Testing strategy

### Profile-store tests

- create, enumerate, inspect, rename, and remove profiles;
- reject invalid, reserved, colliding, and traversal names;
- keep every resolved path under the profile parent;
- write metadata atomically and validate schema versions;
- retain restrictive POSIX modes;
- block rename/removal when live leases exist;
- clean only operation-owned temporary artifacts after failure.

### Import tests

- copy a representative Pi configuration root without altering the source;
- include opaque credentials, sessions, packages, and resource directories;
- preserve safe internal relative symlinks;
- reject absolute and escaping symlinks;
- report configured external resource paths;
- leave no valid partial profile after interruption or copy failure;
- refuse an existing destination.

### Environment-isolation tests

- assign distinct `PI_CODING_AGENT_DIR` values to two profile launches;
- replace inherited `PI_CODING_AGENT_DIR` and `PI_PROFILE_NAME` values;
- remove every maintained provider credential variable by default;
- retain an exact allowlisted variable while keeping its value out of metadata and logs;
- preserve ordinary development variables;
- verify profile A's settings, auth fixtures, sessions, trust, and package paths are never used by profile B.

### CLI and process tests

- select a profile interactively and explicitly;
- reject unknown profiles without creating them;
- forward Pi arguments as an unchanged argument vector;
- honor `--cwd`, profile-default, and caller-current-directory precedence;
- invoke native `pi config` under the selected profile;
- produce deterministic non-interactive errors instead of prompting;
- propagate normal exit codes and signal exits;
- clean only the current process's lease;
- support concurrent same-profile and different-profile launches;
- produce a useful error when Pi cannot be found.

Tests use a fake Pi executable that records argv, environment, current directory, signals, and exit behavior. They do not require real provider credentials.

### Extension tests

- register the indicator extension through package metadata;
- set namespaced footer status in interactive mode;
- set a terminal title containing the profile name;
- restore indicators after session start and runtime replacement events;
- avoid transcript-writing and model-context APIs;
- behave safely without UI or without `PI_PROFILE_NAME`.

### Cross-platform CI

The full automated suite runs on Node.js 22.19.0 or newer across macOS, Linux, and Windows. CI covers the minimum supported Node.js version on all three operating systems and the latest active LTS release on Linux. Platform-specific permission assertions run only where those semantics exist; skipping an inapplicable POSIX mode assertion does not skip path, process, or isolation tests.

### Manual smoke test

1. Install the package and confirm plain `pi` still uses the existing `~/.pi/agent` installation.
2. Import `~/.pi/agent` as `personal` and verify the source remains unchanged.
3. Create a fresh `work` profile.
4. Launch each profile and use `/login` with different provider accounts.
5. Install a test extension and skill only in `work`.
6. Configure different model defaults and trust decisions.
7. Launch both profiles concurrently.
8. Confirm different footer/title indicators, provider authentication, package lists, model defaults, session lists, and trust decisions.
9. Export known provider credential variables in the parent shell and confirm neither profile inherits them by default.
10. Allowlist one test credential variable for `work` and confirm only `work` receives it.
11. Restart both profiles and confirm all isolation persists.
12. Attempt rename and removal during an active launch and confirm both are blocked.

## Acceptance criteria

The package is complete when:

- `pi-profile` offers an interactive picker and `pi-profile <name>` launches directly;
- all agreed management commands work interactively and non-interactively;
- each launch sets a unique, validated Pi configuration root before resource discovery;
- credentials, settings, packages, resources, models, trust, caches, and sessions remain profile-specific;
- known provider credential variables are denied unless explicitly allowlisted by name;
- plain `pi` and `~/.pi/agent` remain unchanged;
- project-local resources retain Pi's native, profile-specific trust behavior;
- active profile indicators appear in Pi's footer and terminal title without entering the transcript;
- same-profile and different-profile concurrent launches are safe;
- destructive management operations refuse active profiles and require explicit confirmation;
- imports are copy-based, atomic, and reject escaping symlinks;
- automated tests pass on macOS, Linux, and Windows;
- the manual smoke procedure demonstrates distinct personal and work accounts without crossover;
- documentation clearly states that profile isolation is not an operating-system sandbox.
