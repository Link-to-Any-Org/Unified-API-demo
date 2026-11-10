import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createConnectLink, getReturnUrl } from "@/lib/linktoany";
import { getSession } from "@/lib/session";
import { getSystemProfile } from "@/lib/system-profile";
import { logger } from "@/lib/logger";

// Starts a hosted-consent (OAuth) connection. Systems that connect with the
// merchant's own credentials go through /api/connect/credentials instead.
export async function POST() {
  const requestId = randomUUID();
  // Build redirects from the registered return URL's origin rather than the
  // request URL, since the dev server may be reached through a tunnel whose
  // public hostname differs from its local bind address.
  const appOrigin = new URL(getReturnUrl()).origin;

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
