const DEFAULT_CURRENCY = "USD";

// Confirmed live (see memory: square-unified-api-capability-matrix) that the
// unified order/payment write contracts take decimal currency units (e.g.
// unitPrice: 9.97), not integer minor units, and that Square's own API
// rounds sub-cent amounts to the nearest cent on write. So the fix here is
// rounding to the currency's precision before sending, not switching to
// integer minor units - that would misinterpret every amount by 100x.
export function currencyPrecision(currencyCode: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currencyCode,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function roundToCurrencyPrecision(amount: number, currencyCode = DEFAULT_CURRENCY): number {
  const digits = currencyPrecision(currencyCode);
  const factor = 10 ** digits;
  return Math.round(amount * factor) / factor;
}

export function formatPrice(amount: number, currencyCode = DEFAULT_CURRENCY): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(amount);
}

export { DEFAULT_CURRENCY };
