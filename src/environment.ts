import type { Profile } from "./contracts.js";

export const AUTH_ENVIRONMENT_VARIABLES = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "AZURE_TENANT_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_DEFAULT_PROFILE",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "NVIDIA_API_KEY",
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
] as const;

export const LAUNCHER_ROUTING_VARIABLES = ["PI_CODING_AGENT_DIR", "PI_PROFILE_NAME"] as const;

export function buildEnvironment(
  profile: Profile,
  parent: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const normalize = (name: string) => platform === "win32" ? name.toUpperCase() : name;
  const denied = new Set<string>(AUTH_ENVIRONMENT_VARIABLES.map(normalize));
  const allowed = new Set<string>(profile.metadata.inheritEnvironment.map(normalize));
  const routing = new Set<string>(LAUNCHER_ROUTING_VARIABLES.map(normalize));
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    const normalized = normalize(name);
    if (routing.has(normalized)) continue;
    if (denied.has(normalized) && !allowed.has(normalized)) continue;
    if (platform === "win32") {
      const duplicate = Object.keys(result).find((existing) => normalize(existing) === normalized);
      if (duplicate) delete result[duplicate];
    }
    result[name] = value;
  }
  result.PI_CODING_AGENT_DIR = profile.root;
  result.PI_PROFILE_NAME = profile.metadata.name;
  return result;
}

export function isReservedEnvironmentName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalized = platform === "win32" ? name.toUpperCase() : name;
  return LAUNCHER_ROUTING_VARIABLES.some((entry) => (platform === "win32" ? entry.toUpperCase() : entry) === normalized);
}
