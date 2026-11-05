import Link from "next/link";
import { headers } from "next/headers";
import { getSession } from "@/lib/session";
import { getReturnUrl } from "@/lib/linktoany";

const ERROR_MESSAGES: Record<string, string> = {
  connect_failed: "Could not connect to Square. Please try again.",
  invalid_state: "The connection attempt expired or was invalid. Please try again.",
  stale_link:
    "That Square sign-in link was already used or was started somewhere else. Close any other Square sign-in tabs, click Connect to Square, and finish signing in in the tab that opens.",
  not_verified: "We couldn't verify the Square connection. Please try again.",
};

function errorMessageFor(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return ERROR_MESSAGES[code] ?? "Something went wrong connecting to Square.";
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
  const session = await getSession();
  const { error } = await searchParams;
  const message = errorMessageFor(error);
  const connected = Boolean(session.linkToAnyAccountId);

  const appOrigin = new URL(getReturnUrl()).origin;
  const requestHeaders = await headers();
  const requestHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const onAppOrigin = !requestHost || requestHost === new URL(appOrigin).host;

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
      <main className="flex w-full max-w-md flex-col items-center gap-6 rounded-xl border border-black/10 bg-white p-10 text-center shadow-sm dark:border-white/10 dark:bg-zinc-900">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Square POS Demo
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Connect your Square account to browse your item catalog and take demo orders.
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
            <Link
              href="/items"
              className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-foreground-hover"
            >
              View catalog items
            </Link>
            <form action="/api/square/disconnect" method="POST">
              <button
                type="submit"
                className="h-11 w-full rounded-full border border-black/10 px-5 font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]"
              >
                Disconnect
              </button>
            </form>
          </div>
        ) : onAppOrigin ? (
          <form action="/api/square/authorize" method="POST" className="w-full">
            <button
              type="submit"
              className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-foreground-hover"
            >
              Connect to Square
            </button>
          </form>
        ) : (
          // The OAuth state cookie is per-host and the callback always returns
          // to LINKTOANY_RETURN_URL's host, so connecting from any other host
          // (e.g. localhost behind a tunnel) can never pass the state check.
          <div className="flex w-full flex-col gap-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Connecting only works from the app&apos;s registered address.
            </p>
            <a
              href={appOrigin}
              className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-foreground-hover"
            >
              Open {new URL(appOrigin).host}
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
