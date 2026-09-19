# Pi Profile - A profile switcher for your pi harness

Installing an extension in your pi coding harness can alter its behavior. Plus, sometimes I want different harnesses for different use cases. This is a little extension I built so that I can have as many different customizable profiles with individual AI subscriptions per profile. 

I run `pi-profile personal` for personal projects for a pi harness with my personal AI subs/API keys, extensions, and tools fit for my personal projects

I run `pi-profile work` for my work account connected to work resources and work AI subs/API keys
 
This way, I can keep my profiles separate and organized. Yay organization.

`pi-profile` launches Pi with independent configuration roots for work, personal, or client contexts. It keeps Pi-managed credentials, settings, packages, extensions, skills, models, trust decisions, caches, and default sessions under `~/.pi/profiles/<name>` while leaving plain `pi` and `~/.pi/agent` unchanged.

> This is configuration separation, not an operating-system sandbox. Pi and its tools retain normal access to the host filesystem, process environment, trusted project resources, explicit resource/session paths, and shared `~/.agents/skills`.

## Requirements and installation

- Node.js 22.19.0 or newer
- Pi 0.85.1 is directly verified; later versions must retain the documented CLI and extension APIs

```bash
npm install --global pi-profile @earendil-works/pi-coding-agent
```

The package declares Pi as a peer dependency and does not install another private Pi binary.

## Usage

```bash
pi-profile                         # interactive picker
pi-profile work                    # launch normally
pi-profile --cwd ~/code/work work  # launcher option before profile
pi-profile work -p "Review this"  # all arguments after profile go to Pi unchanged

pi-profile create [name]
pi-profile list
pi-profile show <name>
pi-profile recover                    # explicit interrupted-operation recovery
pi-profile rename <old> <new> [--clear-stale-leases]
pi-profile remove <name> [--force] [--clear-stale-leases]
pi-profile import <name> <source-directory> [--yes]
pi-profile config <name> --pi
pi-profile config <name> --default-cwd <directory>
pi-profile config <name> --clear-default-cwd
pi-profile config <name> --inherit <VARIABLE>
pi-profile config <name> --no-inherit <VARIABLE>
```

Missing values are prompted only in a terminal. Scripts must provide required values, `--yes` for import, and `--force` for removal. Removal still refuses active or ambiguous leases. Interactive removal requires typing the exact profile name.

`config <name> --default-cwd <directory>` intentionally stores the path without requiring it to exist immediately, so removable volumes, network mounts, and directories created later remain usable. Every launch validates the selected effective directory and fails clearly if it is then missing or not a directory.

On a completely new installation, `pi-profile list` initializes the private `~/.pi/profiles` parent (mode `0700` on POSIX) so reads can participate in the same mutation lock protocol. It creates no profile or credential files; subsequent empty lists are read-only.

Optional shell alias (not installed automatically):

```bash
alias pp='pi-profile'
```

## What is isolated

Each launch overwrites `PI_CODING_AGENT_DIR` with the selected direct-child profile root and sets `PI_PROFILE_NAME`. Pi then owns authentication and configuration normally inside that root. Multiple launches use distinct runtime leases, including multiple sessions of one profile.

The launcher preserves:

- every Pi argument after the profile, including `--session-dir`, `--session`, `--fork`, `--`, print, JSON, and RPC modes;
- inherited `PI_CODING_AGENT_SESSION_DIR`;
- Pi's `settings.sessionDir` precedence;
- trusted `.pi` and `.agents` project resources;
- intentionally shared `~/.agents/skills`;
- `HOME`, `USERPROFILE`, cloud configuration directories, and ordinary development variables;
- `PI_PACKAGE_DIR`, which Pi 0.85.1 uses for its own executable package root (metadata, bundled themes/assets, and package-manager behavior for Nix/Guix), not for user-installed resources under `PI_CODING_AGENT_DIR`.

Consequently, explicit native paths can cross profile roots. Cloud SDKs may also authenticate through default files, metadata services, helpers, or other mechanisms even when known credential environment variables are removed. `pi-profile` does not redirect or disable those chains.

## Provider environment filtering

Known provider authentication variables are removed unless their exact name is listed with `config --inherit`. Only names are stored; values continue to come from the parent process.

Effective denylist in 1.0.0:

```text
AI_GATEWAY_API_KEY
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_OAUTH_TOKEN
ANT_LING_API_KEY
AZURE_CLIENT_CERTIFICATE_PATH
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
AZURE_FEDERATED_TOKEN_FILE
AZURE_OPENAI_API_KEY
AZURE_TENANT_ID
AWS_ACCESS_KEY_ID
AWS_BEARER_TOKEN_BEDROCK
AWS_CONTAINER_AUTHORIZATION_TOKEN
AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
AWS_CONTAINER_CREDENTIALS_FULL_URI
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
AWS_DEFAULT_PROFILE
AWS_PROFILE
AWS_ROLE_ARN
AWS_ROLE_SESSION_NAME
AWS_SECRET_ACCESS_KEY
AWS_SECURITY_TOKEN
AWS_SESSION_TOKEN
AWS_SHARED_CREDENTIALS_FILE
AWS_WEB_IDENTITY_TOKEN_FILE
BASETEN_API_KEY
CEREBRAS_API_KEY
CLOUDFLARE_API_KEY
COPILOT_GITHUB_TOKEN
DEEPSEEK_API_KEY
FIREWORKS_API_KEY
GEMINI_API_KEY
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_CLOUD_API_KEY
GROQ_API_KEY
HF_TOKEN
KIMI_API_KEY
MINIMAX_API_KEY
MINIMAX_CN_API_KEY
MISTRAL_API_KEY
MOONSHOT_API_KEY
NVIDIA_API_KEY
OPENCODE_API_KEY
OPENAI_API_KEY
OPENROUTER_API_KEY
QWEN_TOKEN_PLAN_API_KEY
QWEN_TOKEN_PLAN_CN_API_KEY
RADIUS_API_KEY
TOGETHER_API_KEY
XAI_API_KEY
XIAOMI_API_KEY
XIAOMI_TOKEN_PLAN_AMS_API_KEY
XIAOMI_TOKEN_PLAN_CN_API_KEY
XIAOMI_TOKEN_PLAN_SGP_API_KEY
ZAI_API_KEY
ZAI_CODING_CN_API_KEY
```

`PI_CODING_AGENT_DIR` and `PI_PROFILE_NAME` are always replaced and cannot be allowlisted.

## Profile-local environment file

Each profile may carry an optional `~/.pi/profiles/<name>/.env`. When present, `pi-profile` loads it after the parent environment is filtered and before Pi is spawned, so Pi, extensions, MCP servers, shell tools, and child processes all receive the variables from startup — no wrapper script required.

```bash
umask 077
cat > ~/.pi/profiles/dj-league/.env <<'EOF'
DISCORD_STATUS_WEBHOOK_URL=replace-locally
EOF
chmod 600 ~/.pi/profiles/dj-league/.env

pi-profile dj-league
```

- The file is **optional**; when it is absent the launch behaves exactly as before.
- It is **profile-scoped**: only the selected profile's `.env` is read, resolved solely as `<profile root>/.env`. Arbitrary environment-file paths are not accepted.
- Profile values **override inherited values** of the same name.
- It is **parsed, never sourced** (via Node's `util.parseEnv`). It is not shell: `$(...)` command substitution, `${...}` expansion, and secret-manager commands are not executed — such text is passed through verbatim as an inert literal.
- **Provider variables placed here do not require `config --inherit`.** The denylist above protects credentials inherited from the parent process; a profile-owned `.env` is an explicit, profile-level credential assignment. `PI_CODING_AGENT_DIR` and `PI_PROFILE_NAME` remain launcher-controlled and are rejected if the file declares them.
- Insecure or malformed files **fail closed** — the launch stops with a clear error instead of continuing without the expected variables. The file is rejected when it is a symlink, is not a regular file, is not owned by the current user (where ownership can be checked), is group- or world-accessible (`mode & 0o077`), exceeds 64 KiB, cannot be parsed, or declares a launcher routing variable. Secure modes such as `0600` or `0400` are accepted; error messages name the path and reason but never the file's contents or variable values.

Because it holds credentials, treat `.env` as sensitive profile data: **do not commit or share it.** Profile import/copy operations carry it as credential-bearing profile data (copied verbatim with private `0600` permissions), so an imported profile keeps its `.env`.

## Import and lifecycle safety

Import is copy-based: the source is never the live profile and is never deleted. Files are copied as opaque bytes through hidden staging. Internal relative file and directory symlinks are preserved through publication and later rename; Windows uses true relative directory symlinks rather than staging-bound junctions and reports when Developer Mode or symlink privilege is required. Absolute, escaping, dangling, and special filesystem entries are rejected. Manager markers, journals, and leases are excluded. Absolute or home-relative external resource/session paths in settings are reported and preserved.

Rename, removal, and metadata updates refuse live or unverifiable leases. A same-host exited lease is stale and requires explicit cleanup confirmation or `--clear-stale-leases` for destructive operations. Another-host and interrupted-start leases are never cleared automatically.

Profile discovery reports invalid visible roots (missing, malformed, unreadable, mismatched, or future-version markers) and continues listing healthy profiles. Direct get, rename, and removal remain fail-closed. This also covers a root left incomplete by interrupted recursive removal: inspect the exact reported direct-child path manually and remove it only after confirming it contains no profile data that must be retained; `pi-profile` never deletes an invalid root automatically.

Mutation locks record a random owner id, hostname, PID, and creation time. Normal release verifies that exact owner before unlinking. A crash can leave a lock, journal, or import staging directory; the manager never silently steals it. After confirming the reported process exited, run `pi-profile recover`. Recovery clears only a same-host lock whose PID is provably absent and only transaction/staging paths whose owner metadata agrees. For rename journals, it deterministically restores a sole source or staging directory to the original profile, or verifies a sole committed destination before clearing the journal. Collisions, missing ownership markers, live PIDs, inaccessible PID state, other-host owners, malformed metadata, and paths outside the profile parent remain blocked and unchanged for manual inspection. Lock wait failures report the observed owner after a bounded five-second wait. A crash can also leave harmless `.pi-profile.lock.release-*` or atomic-write `.*.tmp` files. Recovery intentionally does not delete these owner-ambiguous artifacts; inspect and remove them manually only when provenance is certain. They do not block ordinary profile operations.

Manager JSON writes use an owned temporary file plus atomic rename, which protects against ordinary process interruption. Version 1.0.0 does not fsync the file and parent directory and therefore does **not** promise recovery across sudden power loss, kernel failure, or storage-controller failure.

The launcher handles Ctrl+C until Pi exits, then removes the session lease. In an interactive terminal it relies on the terminal's process-group SIGINT delivery instead of signaling Pi a second time. If publishing the child PID fails, a proven child exit allows the launcher to remove only its exact unchanged lease. If exit cannot be proven, the error names the retained lease file and child PID; verify that PID is gone before manually removing that exact file. Changed or potentially live lease evidence is never erased.

## Indicator extension

Profiled sessions load the packaged extension explicitly. It contributes `profile: <name>` to the footer, sets a TUI title, and restores both after session replacement/reload. `/profile` displays only the active name/root and external switching instructions. It does not switch identity, read credentials, write transcripts, or alter model context.

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```

See [docs/manual-smoke.md](docs/manual-smoke.md) for credential and cross-platform checks. Tests always use temporary synthetic fixtures. The authorized 1.0.0 release target is macOS; Windows/Linux checks are advisory rather than release gates.

## License

[MIT](LICENSE) © Ben Junya
