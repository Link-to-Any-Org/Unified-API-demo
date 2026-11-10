import { headers } from "next/headers";
import { localeFromAcceptLanguage } from "@/lib/currency";

// The viewer's preferred language for number/price formatting. Read on the
// server and passed to client components as a prop, so the server render and
// hydration format prices identically.
export async function getRequestLocale(): Promise<string> {
  return localeFromAcceptLanguage((await headers()).get("accept-language"));
}
