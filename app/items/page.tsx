import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listCategories, listCatalogItems, resolveItemCategory, type CatalogItem } from "@/lib/linktoany";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import { getRequestLocale } from "@/lib/request-locale";
import { getConfig } from "@/lib/config";
import PosView from "./pos-view";

// Reads the session cookie and the account's live catalog on every request -
// not a good candidate for a prerendered static shell, so it stays a plain
// blocking route rather than being restructured around Suspense boundaries
// for Cache Components.
export const instant = false;

export default async function ItemsPage() {
  const session = await getSession();
  if (!session.linkToAnyAccountId) {
    redirect("/");
  }

  const { paymentWritesEnabled } = getConfig();
  const [rawItems, categories, locale] = await Promise.all([
    listCatalogItems(session.linkToAnyAccountId),
    listCategories(session.linkToAnyAccountId),
    getRequestLocale(),
  ]);

  const items: Array<CatalogItem & { category?: string }> = rawItems.map((item) => {
    // POS grouping/reporting should follow Square's REGULAR category, not
    // whichever category (possibly a MENU/online-ordering one) happened to
    // be mapped first - see docs/square-integration-notes.md.
    const categoryId = resolveItemCategory(item.categoryExternalIds, categories, "REGULAR");
    return {
      ...item,
      category: categoryId ? (categories.get(categoryId)?.name ?? categoryId) : undefined,
    };
  });

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-8 dark:bg-black">
      <div className="flex w-full max-w-6xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
              Point of sale
            </h1>
            {session.merchantName && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {session.merchantName}
              </p>
            )}
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/orders"
              className="text-sm font-medium text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              Orders
            </Link>
            <Link
              href="/"
              className="text-sm font-medium text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              Back
            </Link>
          </div>
        </div>

        <p
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {paymentWritesEnabled ? (
            <>
              Payment writes are <strong>on</strong>: placing an order writes a
              real, immediately captured (simulated cash) payment against the
              connected Square account. No card is charged, but the capture
              can&apos;t be refunded from this app - only use a disposable
              Square account.
            </>
          ) : (
            <>
              Payment writes are <strong>off</strong>: placing an order creates
              the Square order only, with no payment recorded. Set{" "}
              <code>ENABLE_PAYMENT_WRITES=true</code> to also write payments.
            </>
          )}
        </p>

        {items.length === 0 ? (
          <p className="text-zinc-600 dark:text-zinc-400">
            No items found for this connected account.
          </p>
        ) : (
          <PosView
            items={items}
            currencyCode={session.currencyCode ?? DEFAULT_CURRENCY}
            locale={locale}
            paymentWritesEnabled={paymentWritesEnabled}
          />
        )}
      </div>
    </div>
  );
}
