import { cookies } from "next/headers";
import { connection } from "next/server";
import { getIronSession, type SessionOptions } from "iron-session";
import { getConfig } from "@/lib/config";

export interface SquareSessionData {
  // The connected account id returned by the Unified API once Square OAuth
  // completes - what every records.list/create call is scoped to.
  linkToAnyAccountId?: string;
  merchantName?: string;
  currencyCode?: string;
  // Set when an order was created but its payment write failed, so the
  // merchant can retry just the payment. Kept server-side (in the sealed
  // session) so the amount can't be changed by the client, and the payment's
  // own externalId is fixed here so a retry can't capture twice.
  pendingPayment?: {
    orderId: string;
    paymentExternalId: string;
    amount: number;
    currencyCode: string;
  };
  // CSRF protection for the OAuth round trip: minted in the authorize route,
  // echoed back in the successUrl, and checked in the callback route.
  oauthState?: string;
  oauthStateCreatedAt?: string;
}

function buildSessionOptions(): SessionOptions {
  return {
    password: getConfig().sessionSecret,
    cookieName: "square_session",
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  };
}

export async function getSession() {
  // iron-session's own seal/unseal checks the cookie's timestamp against
  // Date.now(), which Cache Components flags as a non-deterministic value
  // unless the route is already explicitly marked as rendering at request
  // time - `instant = false` alone doesn't cover this. `connection()` makes
  // that explicit right before the call that reaches it.
  await connection();
  return getIronSession<SquareSessionData>(await cookies(), buildSessionOptions());
}
