import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createSquareConnectLink, getReturnUrl } from "@/lib/uniflow";
import { getSession } from "@/lib/session";
import { logger } from "@/lib/logger";

export async function POST() {
  const requestId = randomUUID();
  // Build redirects from the registered return URL's origin rather than the
  // request URL, since the dev server may be reached through a tunnel whose
  // public hostname differs from its local bind address.
  const appOrigin = new URL(getReturnUrl()).origin;

  try {
    const state = randomUUID();
    const session = await getSession();
    session.oauthState = state;
    session.oauthStateCreatedAt = new Date().toISOString();
    await session.save();

    const { accountLinkUrl } = await createSquareConnectLink(getReturnUrl(), state);
    // Temporary diagnostics while chasing a reproducing invalid_state bug on
    // the callback - remove once resolved.
    logger.info("square.authorize.started", { requestId, state, accountLinkUrl });
    // 303, not the default 307: this request is a POST, and a 307 would
    // make the browser re-POST to accountLinkUrl instead of visiting it
    // with GET, which LinkToAny's hosted connect page doesn't expect.
    return NextResponse.redirect(accountLinkUrl, 303);
  } catch (err) {
    logger.error("square.authorize.failed", { requestId, err });
    return NextResponse.redirect(
      new URL("/?error=connect_failed", appOrigin),
      303
    );
  }
}
