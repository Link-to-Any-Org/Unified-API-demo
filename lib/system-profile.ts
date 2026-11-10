import { cacheLife, cacheTag } from "next/cache";
import { ValidationError } from "@linktoany/sdk";
import { getConfig } from "@/lib/config";
import { getLinkToAnyClient } from "@/lib/linktoany";
import {
  deriveCapabilities,
  entityCapabilities,
  planFromRequirements,
  type ConnectPlan,
  type EntityCapability,
  type SystemCapabilities,
} from "@/lib/system-capabilities";

export interface SystemProfile {
  systemId: string;
  name: string;
  connect: ConnectPlan;
  // Unified entities this system can read and/or write, from its contracts.
  entities: EntityCapability[];
  capabilities: SystemCapabilities;
}

// Everything the app needs to know about the configured system, discovered
// from the Unified API instead of hard-coded: pointing LINKTOANY_SYSTEM_ID at
// another integration changes the name, the way it connects and which screens
// are offered, with no code change.
//
// Only genuine "this system can't be connected" answers are cached. A
// transient failure (network, 5xx) throws and is retried on the next request.
export async function getSystemProfile(): Promise<SystemProfile> {
  "use cache";
  cacheLife("minutes");
  cacheTag("system-profile");

  const { linkToAnySystemId: systemId, linkToAnyApplication } = getConfig();
  const client = getLinkToAnyClient();

  const [integration, contracts, connect] = await Promise.all([
    client.integrations.get(systemId),
    client.entities.list({ systemIds: [systemId] }),
    client.auth.getLinkRequirements(systemId).then(
      (requirements): ConnectPlan => planFromRequirements(requirements, linkToAnyApplication),
      (err): ConnectPlan => {
        if (err instanceof ValidationError) {
          // The Unified API has no shared default credential set, so a system
          // the organisation hasn't registered one for can't be connected.
          return {
            mode: "unavailable",
            reason:
              "No credential set is registered for this system on your LinkToAny organisation. Add one under Client credentials in the LinkToAny dashboard.",
          };
        }
        throw err;
      }
    ),
  ]);

  const entities = entityCapabilities(contracts.data, systemId);
  return {
    systemId,
    name: integration.data.name,
    connect,
    entities,
    capabilities: deriveCapabilities(entities),
  };
}
