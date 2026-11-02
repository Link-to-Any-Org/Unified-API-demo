import { NextRequest, NextResponse } from "next/server";
import {
  findSquareAccountForMerchant,
  getReturnUrl,
  getUniflowClient,
} from "@/lib/uniflow";
import { getSession } from "@/lib/session";
import type { Account } from "@linktoany/sdk";

function extractBusinessName(account: Account): string | undefined {
  const info = account.externalAccountInfo as
    | { accounts?: { locations?: { business_name?: string }[] } }
    | undefined;
  return account.name ?? info?.accounts?.locations?.[0]?.business_name;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  // `request.nextUrl` reflects the dev server's own bind address, not the
  // public tunnel/domain the Unified API redirects back to, so build
  // redirects from the registered successUrl's origin instead.
  const appOrigin = new URL(getReturnUrl()).origin;

  // Square is a hosted-consent platform: even a failed connection lands on
  // this successUrl (no separate failure redirect), flagged by
  // error=CONNECTION_FAILED rather than a distinct error page.
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("details") ?? error;
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(description)}`, appOrigin)
    );
  }

  try {
    // Hosted-consent platforms (Square, Clover, Lightspeed, Shopify) send
    // `external_id` (the platform's own merchant id) instead of accountId.
    const externalId = url.searchParams.get("external_id");
    const accountIdParam = url.searchParams.get("accountId");

    let account: Account | undefined;
    if (accountIdParam) {
      const { data } = await getUniflowClient().accounts.get(accountIdParam);
      account = data;
    } else if (externalId) {
      account = await findSquareAccountForMerchant(externalId);
    }

    if (!account) {
      throw new Error(
        "No connected account found - the callback did not include an accountId or external_id."
      );
    }

    const session = await getSession();
    session.uniflowAccountId = account._id;
    session.merchantName = extractBusinessName(account);
    await session.save();

    return NextResponse.redirect(new URL("/items", appOrigin));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(message)}`, appOrigin)
    );
  }
}
