import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ValidationError as SdkValidationError } from "@linktoany/sdk";
import { connectWithCredentials, getReturnUrl, verifyConnection } from "@/lib/linktoany";
import { storeConnection } from "@/lib/connect-session";
import { getSession } from "@/lib/session";
import { getSystemProfile } from "@/lib/system-profile";
import { logger } from "@/lib/logger";
import { checkRateLimit, clientRateLimitKey } from "@/lib/rate-limit";
import { BodyTooLargeError, readBodyWithLimit } from "@/lib/read-body";
import { isSameOriginRequest } from "@/lib/same-origin";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELD_LENGTH = 1024;

function redirectTo(appOrigin: string, path: string) {
  // 303, not 307: this request is a POST and the target only handles GET.
  return NextResponse.redirect(new URL(path, appOrigin), 303);
}

// Connects a system that authenticates with the merchant's own credentials
// (API token, basic auth, ...) instead of a hosted consent screen. The fields
// are the ones the system's link requirements name, so the same route serves
// every direct-auth system. Credential values are passed straight through:
// never logged, never echoed into a redirect or an error message.
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const appOrigin = new URL(getReturnUrl()).origin;

  // The account doesn't exist yet, so this is keyed by client address; it
  // blunts credential guessing.
  if (!checkRateLimit(clientRateLimitKey(request))) {
    return redirectTo(appOrigin, "/?error=too_many_attempts");
  }

  // No session is needed to reach this route, and its response sets one. A
  // form posted from another site therefore could log the visitor into an
  // account the attacker controls (login CSRF), so only the app's own form
  // is accepted.
  if (!isSameOriginRequest(request)) {
    logger.warn("connect.credentials.cross_site", { requestId });
    return redirectTo(appOrigin, "/?error=connect_failed");
  }

  let submitted: URLSearchParams;
  try {
    submitted = new URLSearchParams(await readBodyWithLimit(request.body, MAX_BODY_BYTES));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return redirectTo(appOrigin, "/?error=connect_failed");
    }
    return redirectTo(appOrigin, "/?error=missing_fields");
  }

  try {
    const { connect } = await getSystemProfile();
    if (connect.mode !== "form") {
      logger.warn("connect.credentials.not_form", { requestId, mode: connect.mode });
      return redirectTo(appOrigin, "/?error=connect_failed");
    }

    // Only the fields the system asked for are forwarded; anything else in the
    // body is dropped.
    const fields: Record<string, string> = {};
    for (const field of connect.fields) {
      const value = submitted.get(field.sourceField)?.trim();
      if (!value || value.length > MAX_FIELD_LENGTH) {
        return redirectTo(appOrigin, "/?error=missing_fields");
      }
      fields[field.sourceField] = value;
    }

    const flowStartedAt = new Date();
    const account = await connectWithCredentials(connect.application, fields);
    // The account was created by this very call from these credentials, so
    // there's no platform merchant id from a third party to cross-check.
    const verified = await verifyConnection(account, undefined, flowStartedAt);

    const session = await getSession();
    const landingPath = await storeConnection(session, verified);
    logger.info("connect.credentials.connected", { requestId, accountId: verified.account._id });
    return redirectTo(appOrigin, landingPath);
  } catch (err) {
    // Log the failure's type only: an SDK error body can echo request fields.
    logger.error("connect.credentials.failed", {
      requestId,
      reason: err instanceof Error ? err.name : "unknown",
    });
    return redirectTo(
      appOrigin,
      err instanceof SdkValidationError ? "/?error=invalid_credentials" : "/?error=connect_failed"
    );
  }
}
