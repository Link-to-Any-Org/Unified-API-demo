import type { LinkRequirements, UnifiedContract } from "@linktoany/sdk";

// Pure helpers that turn what the Unified API reports about a system (its
// contracts and connect requirements) into what this app needs to decide:
// how to connect, and which screens make sense. Kept free of I/O so they can
// be tested without a network.

export interface EntityCapability {
  entityType: string;
  read: boolean;
  write: boolean;
}

// A contract can map several systems, and a mapping can be disabled, so
// readable/writable is judged per system from the enabled mappings - not from
// the mere existence of the contract.
export function entityCapabilities(
  contracts: UnifiedContract[],
  systemId: string
): EntityCapability[] {
  return contracts
    .map((contract): EntityCapability => ({
      entityType: contract.entityType,
      read: (contract.readMappings ?? []).some(
        (mapping) => mapping.systemId === systemId && mapping.enabled !== false
      ),
      write: (contract.writeMappings ?? []).some(
        (mapping) => mapping.systemId === systemId && mapping.enabled !== false
      ),
    }))
    .filter((entity) => entity.read || entity.write)
    .sort((a, b) => a.entityType.localeCompare(b.entityType));
}

export interface SystemCapabilities {
  // The POS screen needs a catalog to read and an order to create.
  pos: boolean;
  // The orders list needs orders to be readable.
  listOrders: boolean;
  // Recording a payment needs the payment entity to be writable.
  payments: boolean;
}

export function deriveCapabilities(entities: EntityCapability[]): SystemCapabilities {
  const find = (entityType: string) => entities.find((entity) => entity.entityType === entityType);
  return {
    pos: Boolean(find("item")?.read && find("order")?.write),
    listOrders: Boolean(find("order")?.read),
    payments: Boolean(find("payment")?.write),
  };
}

export interface ConnectField {
  name: string;
  // The key the Unified API expects the value under in the connect payload.
  sourceField: string;
  label: string;
  placeholder?: string;
  description?: string;
  // True when the value should be masked while typing.
  secret: boolean;
  // Identifies the merchant on the platform.
  isUnique: boolean;
}

export type ConnectPlan =
  // Hosted consent: send the merchant to the provider and handle the callback.
  | { mode: "oauth_redirect"; application: string }
  // The merchant's own credentials are posted and the account is created at once.
  | { mode: "form"; application: string; fields: ConnectField[] }
  // Nothing to connect through yet (e.g. no credential set registered).
  | { mode: "unavailable"; reason: string };

const SECRET_FIELD = /token|secret|key|password|passphrase|credential/i;

export function isSecretField(sourceField: string): boolean {
  return SECRET_FIELD.test(sourceField);
}

export function planFromRequirements(
  requirements: LinkRequirements,
  configuredApplication?: string
): ConnectPlan {
  const application = configuredApplication ?? requirements.application;
  if (requirements.mode === "oauth_redirect") {
    return { mode: "oauth_redirect", application };
  }
  return {
    mode: "form",
    application,
    fields: requirements.requiredFields.map((field) => ({
      name: field.name,
      sourceField: field.sourceField,
      label: field.label ?? field.sourceField,
      placeholder: field.placeholder,
      description: field.description,
      secret: isSecretField(field.sourceField),
      isUnique: Boolean(field.isUnique),
    })),
  };
}
