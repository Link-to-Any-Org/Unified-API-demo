import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createConnectLink, getReturnUrl } from "@/lib/linktoany";
import { getSession } from "@/lib/session";
import { getSystemProfile } from "@/lib/system-profile";
import { logger } from "@/lib/logger";
import { checkRateLimit, clientRateLimitKey } from "@/lib/rate-limit";
import { isSameOriginRequest } from "@/lib/same-origin";

// Starts a hosted-consent (OAuth) connection. Systems that connect with the
// merchant's own credentials go through /api/connect/credentials instead.
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  // Build redirects from the registered return URL's origin rather than the
  // request URL, since the dev server may be reached through a tunnel whose
  // public hostname differs from its local bind address.
  const appOrigin = new URL(getReturnUrl()).origin;

  // Nobody is signed in yet, so this is keyed by client address. Every call
  // mints a connect link upstream with the organisation's API key, which is
  // not something an anonymous loop should be able to do without limit.
  if (!checkRateLimit(clientRateLimitKey(request))) {
    logger.warn("connect.authorize.rate_limited", { requestId });
    return NextResponse.redirect(new URL("/?error=too_many_attempts", appOrigin), 303);
  }

  // Only the app's own Connect button may start a flow: a cross-site POST
  // would plant a state nonce in the visitor's session and send them off to
  // the provider without them having asked.
  if (!isSameOriginRequest(request)) {
    logger.warn("connect.authorize.cross_site", { requestId });
    return NextResponse.redirect(new URL("/?error=connect_failed", appOrigin), 303);
  }

  try {
    const { connect } = await getSystemProfile();
    if (connect.mode !== "oauth_redirect") {
      logger.warn("connect.authorize.not_oauth", { requestId, mode: connect.mode });
      return NextResponse.redirect(new URL("/?error=connect_failed", appOrigin), 303);
    }

    const state = randomUUID();
    const session = await getSession();
    session.oauthState = state;
    session.oauthStateCreatedAt = new Date().toISOString();
    await session.save();

    const { accountLinkUrl } = await createConnectLink(getReturnUrl(), state);
    // 303, not the default 307: this request is a POST, and a 307 would
    // make the browser re-POST to accountLinkUrl instead of visiting it
    // with GET, which LinkToAny's hosted connect page doesn't expect.
    return NextResponse.redirect(accountLinkUrl, 303);
  } catch (err) {
    logger.error("connect.authorize.failed", { requestId, err });
    return NextResponse.redirect(
      new URL("/?error=connect_failed", appOrigin),
      303
    );
  }
}
