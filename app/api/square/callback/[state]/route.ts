import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  findSquareAccountForMerchant,
  getReturnUrl,
  getUniflowClient,
  verifySquareConnection,
} from "@/lib/uniflow";
import { getSession } from "@/lib/session";
import { logger } from "@/lib/logger";
import type { Account } from "@linktoany/sdk";

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function errorRedirect(appOrigin: string, code: string) {
  return NextResponse.redirect(new URL(`/?error=${code}`, appOrigin));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ state: string }> }
) {
  const requestId = randomUUID();
  const url = request.nextUrl;
  // `request.nextUrl` reflects the dev server's own bind address, not the
  // public tunnel/domain the Unified API redirects back to, so build
  // redirects from the registered successUrl's origin instead.
  const appOrigin = new URL(getReturnUrl()).origin;

  const session = await getSession();
  const expectedState = session.oauthState;
  const stateCreatedAt = session.oauthStateCreatedAt;
  session.oauthState = undefined;
  session.oauthStateCreatedAt = undefined;

  // The state nonce travels as a path segment, not a query param: LinkToAny
  // appends its own `?accountId=...&merchantId=...` to our successUrl, and
  // if that's done without checking for an existing `?` (as its own docs'
  // phrasing suggests), a query-string state would get silently merged into
  // one garbled param instead of staying a separate, comparable value.
  const { state } = await params;
  const stateAge = stateCreatedAt ? Date.now() - new Date(stateCreatedAt).getTime() : Infinity;
  if (!expectedState || !state || state !== expectedState || stateAge > OAUTH_STATE_TTL_MS) {
    await session.save();
    // Temporary verbose diagnostics while chasing a reproducing invalid_state
    // bug - remove once resolved. No secrets here: state is a random nonce,
    // not a credential, and the rest is just the callback's own query string.
    logger.warn("square.callback.invalid_state", {
      requestId,
      hasExpectedState: Boolean(expectedState),
      hasReceivedState: Boolean(state),
      statesMatch: expectedState === state,
      stateAgeMs: stateAge,
      pathname: url.pathname,
      search: url.search,
      cookiePresent: request.cookies.has("square_session"),
    });
    return errorRedirect(appOrigin, "invalid_state");
  }
  const flowStartedAt = new Date(stateCreatedAt!);

  // Square is a hosted-consent platform: even a failed connection lands on
  // this successUrl (no separate failure redirect), flagged by an `error`
  // param rather than a distinct error page.
  const error = url.searchParams.get("error");
  if (error) {
    await session.save();
    logger.warn("square.callback.provider_error", { requestId, error, search: url.search });
    return errorRedirect(appOrigin, "connect_failed");
  }

  try {
    // Hosted-consent platforms (Square, Clover, Lightspeed, Shopify) send
    // the platform's own merchant id back as `external_id` (or `merchantId`)
    // instead of accountId.
    const externalId =
      url.searchParams.get("external_id") ?? url.searchParams.get("merchantId") ?? undefined;
    const accountIdParam = url.searchParams.get("accountId");

    let account: Account | undefined;
    if (accountIdParam) {
      const { data } = await getUniflowClient().accounts.get(accountIdParam);
      account = data;
    } else if (externalId) {
      account = await findSquareAccountForMerchant(externalId);
    }

    if (!account) {
      throw new Error("No connected account found in the callback");
    }

    const verified = await verifySquareConnection(account, externalId, flowStartedAt);

    session.uniflowAccountId = verified.account._id;
    session.merchantName = verified.merchantName;
    session.currencyCode = verified.currencyCode;
    await session.save();

    return NextResponse.redirect(new URL("/items", appOrigin));
  } catch (err) {
    await session.save();
    logger.error("square.callback.failed", { requestId, accountId: session.uniflowAccountId, err });
    return errorRedirect(appOrigin, "not_verified");
  }
}
