import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

export interface SquareSessionData {
  // The connected account id returned by the Unified API once Square OAuth
  // completes - what every records.list/create call is scoped to.
  uniflowAccountId?: string;
  merchantName?: string;
}

const sessionPassword = process.env.SESSION_SECRET;
if (!sessionPassword || sessionPassword.length < 32) {
  throw new Error(
    "SESSION_SECRET env var must be set to a random string of at least 32 characters."
  );
}

export const sessionOptions: SessionOptions = {
  password: sessionPassword,
  cookieName: "square_session",
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
};

export async function getSession() {
  return getIronSession<SquareSessionData>(await cookies(), sessionOptions);
}
