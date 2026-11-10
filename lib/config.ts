import type { LinkToAnyEnvironment } from "@linktoany/sdk";

export interface AppConfig {
  linkToAnyApiKey: string;
  linkToAnyOrganisationId?: string;
  linkToAnyEnvironment: LinkToAnyEnvironment;
  // The integration (LinkToAny "system") this deployment connects to. Changing
  // it is all it takes to point the app at a different system - everything
  // else (name, how to connect, which screens apply) is discovered from it.
  linkToAnySystemId: string;
  // Name of the credential set (LinkToAny "application") to connect through.
  // Without it LinkToAny picks one for the API key itself, which with several
  // sets registered for the system may not be the one you configured.
  linkToAnyApplication?: string;
  linkToAnyReturnUrl: string;
  sessionSecret: string;
  devTunnelOrigin?: string;
  // Hard gate on the payment write. Off unless ENABLE_PAYMENT_WRITES is
  // exactly "true": with it off, placing an order creates the order only and
  // never writes a payment record. This app can't tell a sandbox merchant
  // from a production one, so the operator has to opt in explicitly rather
  // than the app guessing from the LinkToAny environment.
  paymentWritesEnabled: boolean;
}

const ENVIRONMENTS: LinkToAnyEnvironment[] = ["dev", "prod"];

let config: AppConfig | undefined;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

// The system/application variables used to be Square-specific. The old names
// still work so an existing .env.local keeps running; the new name wins when
// both are set.
function readEnvWithLegacy(name: string, legacyName: string): string | undefined {
  return readEnv(name) ?? readEnv(legacyName);
}

export function loadConfig(): AppConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  function required(name: string): string {
    const value = readEnv(name);
    if (!value) missing.push(name);
    return value ?? "";
  }

  const linkToAnyApiKey = required("LINKTOANY_API_KEY");
  const linkToAnySystemId = readEnvWithLegacy("LINKTOANY_SYSTEM_ID", "LINKTOANY_SQUARE_SYSTEM_ID");
  if (!linkToAnySystemId) missing.push("LINKTOANY_SYSTEM_ID");
  const linkToAnyReturnUrl = required("LINKTOANY_RETURN_URL");
  const sessionSecret = required("SESSION_SECRET");

  const rawEnvironment = readEnv("LINKTOANY_ENVIRONMENT") ?? "dev";
  if (!ENVIRONMENTS.includes(rawEnvironment as LinkToAnyEnvironment)) {
    invalid.push(
      `LINKTOANY_ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}, got "${rawEnvironment}"`
    );
  }

  if (sessionSecret && sessionSecret.length < 32) {
    invalid.push("SESSION_SECRET must be at least 32 characters");
  }

  if (linkToAnyReturnUrl) {
    try {
      new URL(linkToAnyReturnUrl);
    } catch {
      invalid.push(`LINKTOANY_RETURN_URL must be an absolute URL, got "${linkToAnyReturnUrl}"`);
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
    linkToAnyApiKey,
    linkToAnyOrganisationId: readEnv("LINKTOANY_ORGANISATION_ID"),
    linkToAnyEnvironment: rawEnvironment as LinkToAnyEnvironment,
    linkToAnySystemId: linkToAnySystemId ?? "",
    linkToAnyApplication: readEnvWithLegacy("LINKTOANY_APPLICATION", "LINKTOANY_SQUARE_APPLICATION"),
    linkToAnyReturnUrl,
    sessionSecret,
    devTunnelOrigin: readEnv("DEV_TUNNEL_ORIGIN"),
    paymentWritesEnabled: readEnv("ENABLE_PAYMENT_WRITES") === "true",
  };
}

export function getConfig(): AppConfig {
  if (!config) {
    config = loadConfig();
  }
  return config;
}
