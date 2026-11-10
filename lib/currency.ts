const DEFAULT_CURRENCY = "USD";
// Fallback only. Prices are formatted in the viewer's own language (from the
// request's Accept-Language - see lib/request-locale.ts) and the merchant's
// currency; the unified location carries a currency but no language.
const DEFAULT_LOCALE = "en-US";

// The unified order/payment write contracts take decimal currency units
// (e.g. unitPrice: 9.97), not integer minor units, and Square rounds
// sub-cent amounts to the nearest cent on write (see
// docs/integration-notes.md). So amounts are rounded to the
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

// Normalises a provider-style locale ("en_US") to BCP 47 ("en-US") and falls
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

// Picks the highest-weighted language from an Accept-Language header
// ("fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5") that the runtime can format with.
export function localeFromAcceptLanguage(header: string | null | undefined): string {
  if (!header) return DEFAULT_LOCALE;
  const candidates = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of candidates) {
    try {
      const [supported] = Intl.NumberFormat.supportedLocalesOf(tag);
      if (supported) return supported;
    } catch {
      // Malformed tag - try the next one.
    }
  }
  return DEFAULT_LOCALE;
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
