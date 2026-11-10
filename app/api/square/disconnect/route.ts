import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { disconnectAccount, getReturnUrl } from "@/lib/linktoany";
import { logger } from "@/lib/logger";

export async function POST() {
  const requestId = randomUUID();
  const appOrigin = new URL(getReturnUrl()).origin;
  const session = await getSession();
  const accountId = session.linkToAnyAccountId;

  if (accountId) {
    try {
      // Deliberately deletes the upstream LinkToAny account record, not just
      // the local session - "Disconnect" should actually sever the
      // connection, so reconnecting always goes through OAuth again rather
      // than silently reusing a still-live account.
      await disconnectAccount(accountId);
    } catch (err) {
      logger.error("square.disconnect.failed", { requestId, accountId, err });
    }
  }
  session.destroy();
  // 303, not the default 307: this request is a POST, and a 307 would make
  // the browser re-POST to "/", which has no POST handler.
  return NextResponse.redirect(new URL("/", appOrigin), 303);
}
