import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { VerifiedConnection } from "@/lib/linktoany";
import type { SessionData } from "@/lib/session";
import { getSystemProfile } from "@/lib/system-profile";

type SaveableSession = SessionData & { save: () => Promise<void> };

// Stores a verified connection in the session and says where to land. Shared
// by both ways of connecting (hosted OAuth callback, direct credentials) so a
// connection is recorded the same way whichever system or route produced it.
export async function storeConnection(
  session: SaveableSession,
  verified: VerifiedConnection
): Promise<string> {
  session.linkToAnyAccountId = verified.account._id;
  session.systemId = getConfig().linkToAnySystemId;
  session.merchantName = verified.merchantName;
  session.currencyCode = verified.currencyCode;
  session.pendingPayment = undefined;
  await session.save();

  // Land on the POS screen when the system supports it, else on the home
  // screen, which lists what the system does support. A failed profile lookup
  // must not undo a connection that has already succeeded.
  try {
    const { capabilities } = await getSystemProfile();
    return capabilities.pos ? "/items" : "/";
  } catch (err) {
    logger.warn("connect.profile_unavailable", { err });
    return "/";
  }
}
