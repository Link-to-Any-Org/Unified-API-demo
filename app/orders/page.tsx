import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listRecentOrders } from "@/lib/uniflow";

function formatPrice(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

export default async function OrdersPage() {
  const session = await getSession();
  if (!session.uniflowAccountId) {
    redirect("/");
  }

  let orders: Awaited<ReturnType<typeof listRecentOrders>> = [];
  let errorMessage: string | null = null;
  try {
    orders = await listRecentOrders(session.uniflowAccountId);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Failed to load orders";
  }

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-8 dark:bg-black">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
              Orders
            </h1>
            {session.merchantName && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {session.merchantName}
              </p>
            )}
          </div>
          <Link
            href="/items"
            className="text-sm font-medium text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Back to POS
          </Link>
        </div>

        {errorMessage && (
          <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {errorMessage}
          </p>
        )}

        {!errorMessage && orders.length === 0 && (
          <p className="text-zinc-600 dark:text-zinc-400">
            No orders yet. Place one from the POS screen.
          </p>
        )}

        {!errorMessage && orders.length > 0 && (
          <ul className="flex flex-col gap-3">
            {orders.map((order) => (
              <li
                key={order.id}
                className="rounded-lg border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {order.id}
                    </p>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {formatDate(order.createdAt)}
                      {order.status ? ` · ${order.status}` : ""}
                    </p>
                    <ul className="mt-2 text-sm text-black dark:text-zinc-50">
                      {order.lineItems.map((item, index) => (
                        <li key={index}>
                          {item.quantity}× {item.name ?? "Item"}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="shrink-0 text-right text-sm font-medium text-black dark:text-zinc-50">
                    {typeof order.total === "number" &&
                      formatPrice(order.total, order.currencyCode)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
