const DEFAULT_CURRENCY = "USD";
// Fallback only - the real locale comes from the connected merchant's Square
// location (see verifySquareConnection) and is passed through explicitly.
const DEFAULT_LOCALE = "en-US";

// The unified order/payment write contracts take decimal currency units
// (e.g. unitPrice: 9.97), not integer minor units, and Square rounds
// sub-cent amounts to the nearest cent on write (see
// docs/square-integration-notes.md). So amounts are rounded to the
// currency's own precision before sending, rather than converted to minor
// units - that would misinterpret every amount by 100x.
export function currencyPrecision(currencyCode: string): number {
  try {
    // Fraction digits are a property of the currency, not the locale, so any
    // valid locale gives the same answer here.
    return (
      new Intl.NumberFormat(DEFAULT_LOCALE, {
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

// Normalises a Square-style locale ("en_US") to BCP 47 ("en-US") and falls
// back to the default if the runtime doesn't support it.
export function resolveLocale(locale: string | undefined): string {
  if (!locale) return DEFAULT_LOCALE;
  const candidate = locale.replace(/_/g, "-");
  try {
    return Intl.NumberFormat.supportedLocalesOf(candidate)[0] ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function formatPrice(
  amount: number,
  currencyCode = DEFAULT_CURRENCY,
  locale: string = DEFAULT_LOCALE
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
  }).format(amount);
}

export { DEFAULT_CURRENCY, DEFAULT_LOCALE };
