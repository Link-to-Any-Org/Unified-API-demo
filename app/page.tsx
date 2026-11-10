import Link from "next/link";
import { connectedAccountId, getSession } from "@/lib/session";
import { getSystemProfile, type SystemProfile } from "@/lib/system-profile";

function errorMessageFor(code: string | undefined, systemName: string): string | undefined {
  if (!code) return undefined;
  const messages: Record<string, string> = {
    connect_failed: `Could not connect to ${systemName}. Please try again.`,
    invalid_state: "The connection attempt expired or was invalid. Please try again.",
    stale_link: `That ${systemName} sign-in link was already used or was started somewhere else. Close any other ${systemName} sign-in tabs, click Connect, and finish signing in in the tab that opens.`,
    not_verified: `We couldn't verify the ${systemName} connection. Please try again.`,
    invalid_credentials: `${systemName} rejected those credentials. Check them and try again.`,
    missing_fields: "Fill in every field to connect.",
    rate_limited: "Too many connection attempts. Wait a minute and try again.",
  };
  return messages[code] ?? `Something went wrong connecting to ${systemName}.`;
}

const PRIMARY_BUTTON =
  "flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-foreground-hover";
const SECONDARY_BUTTON =
  "h-11 w-full rounded-full border border-black/10 px-5 font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]";
const SECONDARY_LINK = `${SECONDARY_BUTTON} flex items-center justify-center`;

function ConnectPanel({ profile }: { profile: SystemProfile }) {
  const { connect, name } = profile;

  if (connect.mode === "unavailable") {
    return (
      <p
        role="status"
        className="w-full rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-left text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
      >
        {connect.reason}
      </p>
    );
  }

  if (connect.mode === "form") {
    return (
      <form action="/api/connect/credentials" method="POST" className="flex w-full flex-col gap-4 text-left">
        {connect.fields.map((field) => (
          <label key={field.sourceField} className="flex flex-col gap-1 text-sm text-zinc-700 dark:text-zinc-300">
            {field.label}
            <input
              name={field.sourceField}
              type={field.secret ? "password" : "text"}
              placeholder={field.placeholder}
              required
              maxLength={1024}
              autoComplete="off"
              spellCheck={false}
              className="h-10 rounded-md border border-black/15 bg-white px-3 text-black dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-50"
            />
            {field.description && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{field.description}</span>
            )}
          </label>
        ))}
        <button type="submit" className={PRIMARY_BUTTON}>
          Connect to {name}
        </button>
      </form>
    );
  }

  return (
    <form action="/api/connect/authorize" method="POST" className="w-full">
      <button type="submit" className={PRIMARY_BUTTON}>
        Connect to {name}
      </button>
    </form>
  );
}

function describeEntity(entity: SystemProfile["entities"][number]): string {
  const modes = [entity.read && "read", entity.write && "write"].filter(Boolean).join(", ");
  return `${entity.entityType} (${modes})`;
}

// Reads cookies/searchParams on every request - not a good candidate for a
// prerendered static shell, so it stays a plain blocking route rather than
// being restructured around Suspense boundaries for Cache Components.
export const instant = false;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [session, profile, { error }] = await Promise.all([
    getSession(),
    getSystemProfile(),
    searchParams,
  ]);
  const connected = Boolean(connectedAccountId(session));
  // Once connected there's no Connect button to have failed, so an `?error=`
  // here is a stale URL (back/forward history) - don't show it.
  const message = connected ? undefined : errorMessageFor(error, profile.name);
  const { capabilities } = profile;

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
      <main className="flex w-full max-w-md flex-col items-center gap-6 rounded-xl border border-black/10 bg-white p-10 text-center shadow-sm dark:border-white/10 dark:bg-zinc-900">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          {profile.name} demo
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          {capabilities.pos
            ? `Connect your ${profile.name} account through the LinkToAny Unified API to browse its catalog and take demo orders.`
            : `Connect your ${profile.name} account through the LinkToAny Unified API.`}
        </p>

        {message && (
          <p
            role="alert"
            className="w-full rounded-md bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {message}
          </p>
        )}

        {connected ? (
          <div className="flex w-full flex-col gap-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Connected{session.merchantName ? ` as ${session.merchantName}` : ""}
            </p>
            {capabilities.pos && (
              <Link href="/items" className={PRIMARY_BUTTON}>
                Open point of sale
              </Link>
            )}
            {capabilities.listOrders && (
              <Link href="/orders" className={capabilities.pos ? SECONDARY_LINK : PRIMARY_BUTTON}>
                View orders
              </Link>
            )}
            {!capabilities.pos && (
              <p className="text-left text-sm text-zinc-600 dark:text-zinc-400">
                This demo&apos;s point-of-sale screens need a catalog (<code>item</code>) to read
                and orders to create, which {profile.name} doesn&apos;t expose through the Unified
                API yet.
                {profile.entities.length > 0
                  ? ` What it does expose: ${profile.entities.map(describeEntity).join(", ")}.`
                  : " It has no unified entities yet."}
              </p>
            )}
            <form action="/api/connect/disconnect" method="POST">
              <button type="submit" className={SECONDARY_BUTTON}>
                Disconnect
              </button>
            </form>
          </div>
        ) : (
          <ConnectPanel profile={profile} />
        )}
      </main>
    </div>
  );
}
