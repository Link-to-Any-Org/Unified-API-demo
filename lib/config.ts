import type { LinkToAnyEnvironment } from "@linktoany/sdk";

export interface AppConfig {
  uniflowApiKey: string;
  uniflowOrganisationId?: string;
  uniflowEnvironment: LinkToAnyEnvironment;
  uniflowSquareSystemId: string;
  uniflowReturnUrl: string;
  sessionSecret: string;
  devTunnelOrigin?: string;
  // LinkToAny's own API tier. The sandbox gate on the payment flow keys off
  // this, since it is the only environment signal this app has - it says
  // nothing about whether the connected Square account itself is a Square
  // sandbox or production merchant.
  isSandbox: boolean;
}

const ENVIRONMENTS: LinkToAnyEnvironment[] = ["dev", "prod"];

let config: AppConfig | undefined;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

export function loadConfig(): AppConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  function required(name: string): string {
    const value = readEnv(name);
    if (!value) missing.push(name);
    return value ?? "";
  }

  const uniflowApiKey = required("UNIFLOW_API_KEY");
  const uniflowSquareSystemId = required("UNIFLOW_SQUARE_SYSTEM_ID");
  const uniflowReturnUrl = required("UNIFLOW_RETURN_URL");
  const sessionSecret = required("SESSION_SECRET");

  const rawEnvironment = readEnv("UNIFLOW_ENVIRONMENT") ?? "dev";
  if (!ENVIRONMENTS.includes(rawEnvironment as LinkToAnyEnvironment)) {
    invalid.push(
      `UNIFLOW_ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}, got "${rawEnvironment}"`
    );
  }

  if (sessionSecret && sessionSecret.length < 32) {
    invalid.push("SESSION_SECRET must be at least 32 characters");
  }

  if (uniflowReturnUrl) {
    try {
      new URL(uniflowReturnUrl);
    } catch {
      invalid.push(`UNIFLOW_RETURN_URL must be an absolute URL, got "${uniflowReturnUrl}"`);
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    const problems = [
      ...missing.map((name) => `missing required env var: ${name}`),
      ...invalid,
    ];
    throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  }

  return {
    uniflowApiKey,
    uniflowOrganisationId: readEnv("UNIFLOW_ORGANISATION_ID"),
    uniflowEnvironment: rawEnvironment as LinkToAnyEnvironment,
    uniflowSquareSystemId,
    uniflowReturnUrl,
    sessionSecret,
    devTunnelOrigin: readEnv("DEV_TUNNEL_ORIGIN"),
    isSandbox: rawEnvironment !== "prod",
  };
}

export function getConfig(): AppConfig {
  if (!config) {
    config = loadConfig();
  }
  return config;
}
