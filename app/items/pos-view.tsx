"use client";

import { useMemo, useRef, useState } from "react";
import type { CatalogItem, CatalogItemVariation } from "@/lib/linktoany";
import { formatPrice } from "@/lib/currency";

interface PosViewProps {
  items: Array<CatalogItem & { category?: string }>;
  currencyCode: string;
  locale: string;
  paymentWritesEnabled: boolean;
}

interface CartLine {
  cartKey: string;
  variationId: string;
  itemId: string;
  itemName: string;
  variationName?: string;
  unitPrice: number;
  quantity: number;
}

type OrderResult =
  | { type: "success"; orderId: string; total: string; paymentRecorded: boolean }
  | { type: "partial"; orderId: string; total: string; message: string; retryable: boolean }
  | { type: "error"; message: string };

const ACCENT_COLORS = [
  "bg-amber-400",
  "bg-emerald-400",
  "bg-sky-400",
  "bg-rose-400",
  "bg-violet-400",
  "bg-teal-400",
  "bg-orange-400",
];

function accentColorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return ACCENT_COLORS[hash % ACCENT_COLORS.length];
}

function cartKeyFor(itemId: string, variationId: string): string {
  return `${itemId}:${variationId}`;
}

// `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost);
// `getRandomValues` is available everywhere, so plain-HTTP dev on a LAN
// address still gets a usable key.
function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Unexpected response (status ${response.status})`);
  }
  return response.json();
}

export default function PosView({ items, currencyCode, locale, paymentWritesEnabled }: PosViewProps) {
  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.category) seen.add(item.category);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const [activeCategory, setActiveCategory] = useState<string>("ALL");
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<OrderResult | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const visibleItems = useMemo(() => {
    if (activeCategory === "ALL") return items;
    return items.filter((item) => item.category === activeCategory);
  }, [items, activeCategory]);

  const lines = useMemo(() => Object.values(cart), [cart]);
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  const quantityByItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of lines) {
      map.set(line.itemId, (map.get(line.itemId) ?? 0) + line.quantity);
    }
    return map;
  }, [lines]);

  // The idempotency key identifies one exact cart. Any change to the cart's
  // contents starts a new attempt, otherwise a resubmit after a failure would
  // reuse the externalId of an order that may already exist and rewrite it
  // with different lines.
  function invalidateIdempotencyKey() {
    idempotencyKeyRef.current = null;
  }

  function addToCart(item: CatalogItem, variation: CatalogItemVariation) {
    if (typeof variation.price !== "number") return;
    setResult(null);
    invalidateIdempotencyKey();
    const key = cartKeyFor(item.id, variation.id);
    setCart((prev) => {
      const existing = prev[key];
      return {
        ...prev,
        [key]: {
          cartKey: key,
          variationId: variation.id,
          itemId: item.id,
          itemName: item.name,
          variationName: variation.name,
          unitPrice: variation.price!,
          quantity: (existing?.quantity ?? 0) + 1,
        },
      };
    });
  }

  function updateQuantity(cartKey: string, delta: number) {
    invalidateIdempotencyKey();
    setCart((prev) => {
      const line = prev[cartKey];
      if (!line) return prev;
      const nextQuantity = line.quantity + delta;
      if (nextQuantity <= 0) {
        const next = { ...prev };
        delete next[cartKey];
        return next;
      }
      return { ...prev, [cartKey]: { ...line, quantity: nextQuantity } };
    });
  }

  function clearCart() {
    setCart({});
    setResult(null);
    idempotencyKeyRef.current = null;
  }

  async function placeOrder() {
    if (lines.length === 0) return;
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = newIdempotencyKey();
    }
    setPlacing(true);
    setResult(null);
    try {
      const response = await fetch("/api/square/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKeyRef.current,
          lineItems: lines.map((line) => ({
            variationExternalId: line.variationId,
            quantity: line.quantity,
          })),
        }),
      });
      const data = await parseJsonResponse(response);

      if (response.status === 207) {
        // The order exists; only its payment failed. Offer a payment-only
        // retry instead of leaving the merchant with an unpaid open order. The
        // idempotency key is kept only until the cart changes again.
        setResult({
          type: "partial",
          orderId: String(data.orderId ?? "order"),
          total: formatPrice(Number(data.total ?? total), String(data.currencyCode ?? currencyCode), locale),
          message: String(data.error ?? "Payment was not recorded"),
          retryable: data.retryable === true,
        });
        setCart({});
        return;
      }

      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to create order");
      }

      setResult({
        type: "success",
        orderId: String(data.orderId ?? "order"),
        total: formatPrice(Number(data.total ?? total), String(data.currencyCode ?? currencyCode), locale),
        paymentRecorded: data.paymentRecorded === true,
      });
      setCart({});
      idempotencyKeyRef.current = null;
    } catch (err) {
      setResult({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to create order",
      });
    } finally {
      setPlacing(false);
    }
  }

  async function retryPayment() {
    if (result?.type !== "partial") return;
    const pending = result;
    setPlacing(true);
    try {
      const response = await fetch(
        `/api/square/orders/${encodeURIComponent(pending.orderId)}/payment`,
        { method: "POST" }
      );
      const data = await parseJsonResponse(response);
      if (!response.ok) {
        setResult({
          ...pending,
          message: typeof data.error === "string" ? data.error : "Retrying the payment failed",
          retryable: data.retryable === true,
        });
        return;
      }
      setResult({
        type: "success",
        orderId: pending.orderId,
        total: pending.total,
        paymentRecorded: true,
      });
      idempotencyKeyRef.current = null;
    } catch (err) {
      setResult({
        ...pending,
        message: err instanceof Error ? err.message : "Retrying the payment failed",
      });
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-6 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={activeCategory === "ALL"}
              onClick={() => setActiveCategory("ALL")}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                activeCategory === "ALL"
                  ? "bg-foreground text-background"
                  : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
            >
              All
            </button>
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                aria-pressed={activeCategory === category}
                onClick={() => setActiveCategory(category)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  activeCategory === category
                    ? "bg-foreground text-background"
                    : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        )}

        <div className="grid auto-rows-min grid-cols-2 gap-4 sm:grid-cols-3">
          {visibleItems.map((item) => {
            const accent = accentColorFor(item.category ?? item.name);
            const qtyInCart = quantityByItem.get(item.id) ?? 0;
            return (
              <div
                key={item.id}
                className="relative flex flex-col overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-white/10 dark:bg-zinc-900"
              >
                <div className={`h-1.5 w-full ${accent}`} />
                {qtyInCart > 0 && (
                  <span className="absolute right-2 top-3 flex h-6 min-w-6 items-center justify-center rounded-full bg-foreground px-1.5 text-xs font-semibold text-background">
                    {qtyInCart}
                  </span>
                )}
                <div className="flex flex-col gap-2 p-3">
                  <p className="pr-6 font-semibold text-black dark:text-zinc-50">
                    {item.name}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {item.variations.map((variation) => {
                      const hasPrice = typeof variation.price === "number";
                      return (
                        <button
                          key={variation.id}
                          type="button"
                          disabled={!hasPrice}
                          title={hasPrice ? undefined : "No price set for this variation"}
                          onClick={() => addToCart(item, variation)}
                          className="flex items-center justify-between rounded-lg bg-zinc-100 px-3 py-2 text-left text-sm font-medium text-black transition-colors hover:bg-zinc-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-700"
                        >
                          <span>{variation.name ?? "Regular"}</span>
                          {hasPrice && (
                            <span className="font-semibold">
                              {formatPrice(variation.price!, currencyCode, locale)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          {visibleItems.length === 0 && (
            <p className="col-span-full text-sm text-zinc-600 dark:text-zinc-400">
              No items in this category.
            </p>
          )}
        </div>
      </div>

      <div className="flex w-full flex-col overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm lg:w-80 lg:shrink-0 dark:border-white/10 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 dark:border-white/10">
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
            Current order
          </h2>
          {itemCount > 0 && (
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {itemCount} item{itemCount === 1 ? "" : "s"}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {lines.length === 0 ? (
            result?.type === "success" || result?.type === "partial" ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center" role="status" aria-live="polite">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="h-7 w-7 text-green-600 dark:text-green-300"
                  >
                    <path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-lg font-semibold text-black dark:text-zinc-50">
                    {result.type === "partial"
                      ? "Order recorded - payment not confirmed"
                      : result.paymentRecorded
                        ? "Order recorded (simulated payment)"
                        : "Order recorded (no payment written)"}
                  </p>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">{result.total}</p>
                  {result.type === "partial" && (
                    <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{result.message}</p>
                  )}
                  <p className="mt-1 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                    {result.orderId}
                  </p>
                </div>
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                Tap an item to add it.
              </p>
            )
          ) : (
            <ul className="flex flex-col divide-y divide-black/5 dark:divide-white/10">
              {lines.map((line) => (
                <li
                  key={line.cartKey}
                  className="flex items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-black dark:text-zinc-50">
                      {line.itemName}
                      {line.variationName ? ` (${line.variationName})` : ""}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatPrice(line.unitPrice, currencyCode, locale)} × {line.quantity} ={" "}
                      {formatPrice(line.unitPrice * line.quantity, currencyCode, locale)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      aria-label={`Decrease quantity of ${line.itemName}`}
                      onClick={() => updateQuantity(line.cartKey, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-black/10 text-black transition-colors hover:bg-black/5 dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/10"
                    >
                      −
                    </button>
                    <span className="w-5 text-center text-sm font-medium text-black dark:text-zinc-50">
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      aria-label={`Increase quantity of ${line.itemName}`}
                      onClick={() => updateQuantity(line.cartKey, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-black/10 text-black transition-colors hover:bg-black/5 dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/10"
                    >
                      +
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-black/10 px-4 py-4 dark:border-white/10">
          {(result?.type === "success" || result?.type === "partial") && lines.length === 0 ? (
            <>
              {result.type === "partial" && result.retryable && (
                <button
                  type="button"
                  onClick={retryPayment}
                  disabled={placing}
                  className="flex h-12 w-full items-center justify-center rounded-full bg-foreground text-base font-semibold text-background transition-colors hover:bg-foreground-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {placing ? "Retrying…" : `Retry payment (${result.total})`}
                </button>
              )}
              <button
                type="button"
                onClick={clearCart}
                disabled={placing}
                className={
                  result.type === "partial" && result.retryable
                    ? "flex h-9 w-full items-center justify-center rounded-full border border-black/10 text-sm font-medium text-black transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]"
                    : "flex h-12 w-full items-center justify-center rounded-full bg-foreground text-base font-semibold text-background transition-colors hover:bg-foreground-hover"
                }
              >
                Start new order
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between text-base font-semibold text-black dark:text-zinc-50">
                <span>Total</span>
                <span>{formatPrice(total, currencyCode, locale)}</span>
              </div>

              {result?.type === "error" && (
                <p role="alert" aria-live="assertive" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                  {result.message}
                </p>
              )}

              <button
                type="button"
                onClick={placeOrder}
                disabled={lines.length === 0 || placing}
                className="flex h-12 w-full items-center justify-center rounded-full bg-foreground text-base font-semibold text-background transition-colors hover:bg-foreground-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {placing
                  ? "Processing…"
                  : `${paymentWritesEnabled ? "Charge" : "Place order"} ${formatPrice(total, currencyCode, locale)}`}
              </button>
              {lines.length > 0 && (
                <button
                  type="button"
                  onClick={clearCart}
                  className="flex h-9 w-full items-center justify-center rounded-full border border-black/10 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]"
                >
                  Clear order
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
