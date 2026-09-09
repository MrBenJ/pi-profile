import { basename, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateName } from "./metadata.js";

interface ActiveProfile {
  name: string;
  root: string;
}

function activeProfile(): ActiveProfile | undefined {
  const name = process.env.PI_PROFILE_NAME;
  const root = process.env.PI_CODING_AGENT_DIR;
  if (!name || !root || !isAbsolute(root)) return undefined;
  try {
    validateName(name);
  } catch {
    return undefined;
  }
  if (basename(root) !== name) return undefined;
  return { name, root };
}

function applyIndicator(ctx: ExtensionContext): void {
  const profile = activeProfile();
  if (!profile || !ctx.hasUI) return;
  ctx.ui.setStatus("pi-profile", `profile: ${profile.name}`);
  if (ctx.mode === "tui") {
    ctx.ui.setTitle(`[${profile.name}] pi - ${basename(ctx.cwd) || ctx.cwd}`);
  }
}

export default function piProfileExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applyIndicator(ctx);
  });

  pi.registerCommand("profile", {
    description: "Show the active external Pi profile",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim()) {
        ctx.ui.notify("/profile is read-only and cannot switch profiles. Exit Pi and run: pi-profile <name>", "warning");
        return;
      }
      const profile = activeProfile();
      if (!profile) {
        ctx.ui.notify("This Pi session is not running under a validated pi-profile launcher.", "info");
        return;
      }
      ctx.ui.notify(`Active profile: ${profile.name}\nRoot: ${profile.root}\nTo switch, exit Pi and run: pi-profile <name>`, "info");
    },
  });
}
