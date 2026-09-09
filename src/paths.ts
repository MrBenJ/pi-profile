import { dirname, join, resolve } from "node:path";
import { ProfileError } from "./contracts.js";
import { validateName } from "./metadata.js";

export function profilePath(parent: string, name: string): string {
  const validated = validateName(name);
  const root = resolve(parent);
  const candidate = resolve(join(root, validated));
  if (dirname(candidate) !== root) {
    throw new ProfileError("PATH_ESCAPE", "Profile path must be a direct child of the profiles directory");
  }
  return candidate;
}
