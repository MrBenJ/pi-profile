# pi-profile

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
- `HOME`, `USERPROFILE`, cloud configuration directories, and ordinary development variables.

Consequently, explicit native paths can cross profile roots. Cloud SDKs may also authenticate through default files, metadata services, helpers, or other mechanisms even when known credential environment variables are removed. `pi-profile` does not redirect or disable those chains.

## Provider environment filtering

Known provider authentication variables are removed unless their exact name is listed with `config --inherit`. Only names are stored; values continue to come from the parent process.

Effective denylist in 0.1.0:

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

## Import and lifecycle safety

Import is copy-based: the source is never the live profile and is never deleted. Files are copied as opaque bytes through hidden staging. Internal relative symlinks are preserved; absolute, escaping, dangling, and special filesystem entries are rejected. Manager markers, journals, and leases are excluded. Absolute or home-relative external resource/session paths in settings are reported and preserved.

Rename, removal, and metadata updates refuse live or unverifiable leases. A same-host exited lease is stale and requires explicit cleanup confirmation or `--clear-stale-leases` for destructive operations. Another-host and interrupted-start leases are never cleared automatically. If a journal is reported, stop all profile operations and inspect the exact reported paths before manually recovering; never delete a staged directory unless ownership and the retained final/source directory are certain.

## Indicator extension

Profiled sessions load the packaged extension explicitly. It contributes `profile: <name>` to the footer, sets a TUI title, and restores both after session replacement/reload. `/profile` displays only the active name/root and external switching instructions. It does not switch identity, read credentials, write transcripts, or alter model context.

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```

See [docs/manual-smoke.md](docs/manual-smoke.md) for credential and cross-platform checks. Tests always use temporary synthetic fixtures.
