import Link from "next/link";
import { getSession } from "@/lib/session";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  const { error } = await searchParams;
  const connected = Boolean(session.uniflowAccountId);

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
      <main className="flex w-full max-w-md flex-col items-center gap-6 rounded-xl border border-black/10 bg-white p-10 text-center shadow-sm dark:border-white/10 dark:bg-zinc-900">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Square Catalog Viewer
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Connect your Square account to browse your item catalog.
        </p>

        {error && (
          <p className="w-full rounded-md bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {connected ? (
          <div className="flex w-full flex-col gap-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Connected{session.merchantName ? ` as ${session.merchantName}` : ""}
            </p>
            <Link
              href="/items"
              className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
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
        ) : (
          <a
            href="/api/square/authorize"
            className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            Connect to Square
          </a>
        )}
      </main>
    </div>
  );
}
