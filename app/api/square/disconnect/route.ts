import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { disconnectAccount } from "@/lib/uniflow";

export async function POST(request: Request) {
  const session = await getSession();
  if (session.uniflowAccountId) {
    try {
      await disconnectAccount(session.uniflowAccountId);
    } catch {
      // Still clear the local session even if the delete call fails
      // (e.g. the account was already removed).
    }
  }
  session.destroy();
  return NextResponse.redirect(new URL("/", request.url));
}
