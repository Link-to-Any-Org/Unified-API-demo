import { NextResponse } from "next/server";
import { connectSquareAccount, getReturnUrl } from "@/lib/uniflow";
import { getSession } from "@/lib/session";

export async function GET() {
  // Build redirects from the registered return URL's origin rather than the
  // request URL, since the dev server may be reached through a tunnel whose
  // public hostname differs from its local bind address.
  const appOrigin = new URL(getReturnUrl()).origin;

  try {
    const result = await connectSquareAccount();

    if (result.data.authType === "oauth" && result.data.authUrl) {
      return NextResponse.redirect(result.data.authUrl);
    }

    // Direct-auth integrations connect immediately - no redirect round trip.
    if (result.data.accountId) {
      const session = await getSession();
      session.uniflowAccountId = result.data.accountId;
      await session.save();
      return NextResponse.redirect(new URL("/items", appOrigin));
    }

    throw new Error("Unified API did not return an authUrl or accountId");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(message)}`, appOrigin)
    );
  }
}
