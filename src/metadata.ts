import { isAbsolute } from "node:path";
import { ProfileError, type ProfileMetadata } from "./contracts.js";

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved = new Set([
  "create",
  "list",
  "show",
  "rename",
  "remove",
  "import",
  "config",
  "recover",
  "help",
  "version",
]);
const metadataKeys = [
  "version",
  "name",
  "defaultCwd",
  "inheritEnvironment",
  "createdAt",
].sort();

export function validateName(input: string): string {
  if (!slug.test(input) || device.test(input) || reserved.has(input)) {
    throw new ProfileError("INVALID_NAME", `Invalid profile name: ${input}`);
  }
  return input;
}

export function validateEnvironmentName(input: string): string {
  if (!environmentName.test(input)) {
    throw new ProfileError("INVALID_ENVIRONMENT_NAME", `Invalid environment variable name: ${input}`);
  }
  return input;
}

export function parseMetadata(input: unknown): ProfileMetadata {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProfileError("INVALID_METADATA", "Profile metadata must be an object");
  }
  const value = input as Record<string, unknown>;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(metadataKeys)) {
    throw new ProfileError("INVALID_METADATA", "Profile metadata has missing or unknown keys");
  }
  if (value.version !== 1) {
    throw new ProfileError("UNSUPPORTED_VERSION", `Unsupported profile metadata version: ${String(value.version)}`);
  }
  const name = validateName(typeof value.name === "string" ? value.name : "");
  if (value.defaultCwd !== null && (typeof value.defaultCwd !== "string" || !isAbsolute(value.defaultCwd))) {
    throw new ProfileError("INVALID_METADATA", "defaultCwd must be an absolute path or null");
  }
  if (!Array.isArray(value.inheritEnvironment) || !value.inheritEnvironment.every((item) => typeof item === "string")) {
    throw new ProfileError("INVALID_METADATA", "inheritEnvironment must contain environment variable names");
  }
  const inheritEnvironment = value.inheritEnvironment.map(validateEnvironmentName);
  if (new Set(inheritEnvironment).size !== inheritEnvironment.length) {
    throw new ProfileError("INVALID_METADATA", "inheritEnvironment entries must be unique");
  }
  if (typeof value.createdAt !== "string") {
    throw new ProfileError("INVALID_METADATA", "createdAt must be an ISO timestamp");
  }
  const timestamp = new Date(value.createdAt);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== value.createdAt) {
    throw new ProfileError("INVALID_METADATA", "createdAt must be a canonical ISO timestamp");
  }
  return {
    version: 1,
    name,
    defaultCwd: value.defaultCwd,
    inheritEnvironment,
    createdAt: value.createdAt,
  };
}
