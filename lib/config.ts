import type { LinkToAnyEnvironment } from "@linktoany/sdk";

export interface AppConfig {
  linkToAnyApiKey: string;
  linkToAnyOrganisationId?: string;
  linkToAnyEnvironment: LinkToAnyEnvironment;
  linkToAnySquareSystemId: string;
  // Name of the Square credential set (LinkToAny "application") to connect
  // through. Without it LinkToAny picks one for the API key itself, which
  // with several sets on the organisation may not be the one you configured.
  linkToAnySquareApplication?: string;
  linkToAnyReturnUrl: string;
  sessionSecret: string;
  // Hard gate on the payment write. Off unless ENABLE_PAYMENT_WRITES is
  // exactly "true": with it off, placing an order creates the Square order
  // only and never writes a payment record. This app can't tell a Square
  // sandbox merchant from a production one, so the operator has to opt in
  // explicitly rather than the app guessing from the LinkToAny environment.
  paymentWritesEnabled: boolean;
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

  const linkToAnyApiKey = required("LINKTOANY_API_KEY");
  const linkToAnySquareSystemId = required("LINKTOANY_SQUARE_SYSTEM_ID");
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
    linkToAnySquareSystemId,
    linkToAnySquareApplication: readEnv("LINKTOANY_SQUARE_APPLICATION"),
    linkToAnyReturnUrl,
    sessionSecret,
    paymentWritesEnabled: readEnv("ENABLE_PAYMENT_WRITES") === "true",
  };
}

export function getConfig(): AppConfig {
  if (!config) {
    config = loadConfig();
  }
  return config;
}
