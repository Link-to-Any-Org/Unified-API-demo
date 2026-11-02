import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listCategories, listCatalogItems, resolveItemCategory, type CatalogItem } from "@/lib/uniflow";
import PosView from "./pos-view";

export default async function ItemsPage() {
  const session = await getSession();
  if (!session.uniflowAccountId) {
    redirect("/");
  }

  let items: Array<CatalogItem & { category?: string }> = [];
  let errorMessage: string | null = null;
  try {
    const [rawItems, categories] = await Promise.all([
      listCatalogItems(session.uniflowAccountId),
      listCategories(session.uniflowAccountId),
    ]);
    items = rawItems.map((item) => {
      // POS grouping/reporting should follow Square's REGULAR category, not
      // whichever category (possibly a MENU/online-ordering one) happened to
      // be mapped first - see resolveItemCategory() for why.
      const categoryId = resolveItemCategory(item.categoryExternalIds, categories, "REGULAR");
      return {
        ...item,
        category: categoryId ? (categories.get(categoryId)?.name ?? categoryId) : undefined,
      };
    });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Failed to load items";
  }

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

        {errorMessage && (
          <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {errorMessage}
          </p>
        )}

        {!errorMessage && items.length === 0 && (
          <p className="text-zinc-600 dark:text-zinc-400">
            No items found for this connected account.
          </p>
        )}

        {!errorMessage && items.length > 0 && <PosView items={items} />}
      </div>
    </div>
  );
}
