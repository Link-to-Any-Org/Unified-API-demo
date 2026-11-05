import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  findSquareAccountForMerchant,
  getReturnUrl,
  getLinkToAnyClient,
  verifySquareConnection,
} from "@/lib/linktoany";
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

  // The state nonce travels as a path segment, not a query param, so it
  // can't be mangled when LinkToAny appends its own `?accountId=...` to our
  // successUrl - see docs/square-integration-notes.md.
  const { state } = await params;
  const stateAge = stateCreatedAt ? Date.now() - new Date(stateCreatedAt).getTime() : Infinity;
  const stateProblem = !expectedState
    ? "no_state_in_session"
    : state !== expectedState
      ? "state_mismatch"
      : stateAge > OAUTH_STATE_TTL_MS
        ? "state_expired"
        : undefined;
  if (stateProblem) {
    await session.save();
    // Reason code only - never the nonce, the connect URL or the callback's
    // query string.
    logger.warn("square.callback.invalid_state", { requestId, reason: stateProblem });
    // No nonce in the session means this callback belongs to a link that was
    // already used (e.g. sign-in finished in an older tab) or was started on
    // another host - worth a more specific message than a plain mismatch.
    return errorRedirect(
      appOrigin,
      stateProblem === "no_state_in_session" ? "stale_link" : "invalid_state"
    );
  }
  const flowStartedAt = new Date(stateCreatedAt!);

  // Square is a hosted-consent platform: even a failed connection lands on
  // this successUrl (no separate failure redirect), flagged by an `error`
  // param rather than a distinct error page.
  const error = url.searchParams.get("error");
  if (error) {
    await session.save();
    logger.warn("square.callback.provider_error", { requestId, error });
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
      const { data } = await getLinkToAnyClient().accounts.get(accountIdParam);
      account = data;
    } else if (externalId) {
      account = await findSquareAccountForMerchant(externalId);
    }

    if (!account) {
      throw new Error("No connected account found in the callback");
    }

    const verified = await verifySquareConnection(account, externalId, flowStartedAt);

    session.linkToAnyAccountId = verified.account._id;
    session.merchantName = verified.merchantName;
    session.currencyCode = verified.currencyCode;
    session.locale = verified.locale;
    session.pendingPayment = undefined;
    await session.save();

    return NextResponse.redirect(new URL("/items", appOrigin));
  } catch (err) {
    await session.save();
    logger.error("square.callback.failed", { requestId, accountId: session.linkToAnyAccountId, err });
    return errorRedirect(appOrigin, "not_verified");
  }
}
