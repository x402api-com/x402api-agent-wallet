import {
  canonicalJson,
  type JsonObject,
  type PaymentRequired,
  type PaymentRequirement,
} from "./http.js";

export const EXTERNAL_RECIPIENT_EXTENSION = "com.k1hub.external-recipient";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UTC =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?Z$/;

export type VerifiedExternalRecipient = {
  network: string;
  asset: string;
  payTo: string;
  recipientDescriptorDigest: string;
  recipientDescriptor: JsonObject;
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} is malformed`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  const result = object(value, field);
  if (Object.keys(result).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${field} contains missing or unknown fields`);
  }
  return result;
}

function canonicalTimestamp(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !CANONICAL_UTC.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${field} is not a canonical UTC timestamp`);
  }
}

function validateDescriptor(
  value: unknown,
  recipient: {
    network: string;
    payTo: string;
  },
): JsonObject {
  const candidate = object(value, "external recipient descriptor");
  const type = candidate.type;
  const rotation = type === "com.k1hub.external-receiving-address-rotation.v1";
  const descriptor = exact(
    candidate,
    rotation
      ? [
          "type",
          "tenantId",
          "network",
          "address",
          "controlChallengeDigest",
          "replacesWalletVersionId",
          "reason",
          "coolingOffEndsAt",
        ]
      : ["type", "tenantId", "network", "address", "controlChallengeDigest"],
    "external recipient descriptor",
  );
  if (
    (!rotation &&
      descriptor.type !== "com.k1hub.external-receiving-address.v1") ||
    typeof descriptor.tenantId !== "string" ||
    !UUID.test(descriptor.tenantId) ||
    descriptor.network !== recipient.network ||
    descriptor.address !== recipient.payTo ||
    typeof descriptor.controlChallengeDigest !== "string" ||
    !SHA256.test(descriptor.controlChallengeDigest)
  ) {
    throw new Error(
      "external recipient descriptor does not match the payment recipient",
    );
  }
  if (rotation) {
    if (
      typeof descriptor.replacesWalletVersionId !== "string" ||
      !UUID.test(descriptor.replacesWalletVersionId) ||
      typeof descriptor.reason !== "string" ||
      descriptor.reason.trim() !== descriptor.reason ||
      descriptor.reason.length < 1 ||
      descriptor.reason.length > 1_024
    ) {
      throw new Error("external recipient rotation descriptor is malformed");
    }
    canonicalTimestamp(
      descriptor.coolingOffEndsAt,
      "external recipient coolingOffEndsAt",
    );
  }
  return descriptor as JsonObject;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(value: JsonObject): Promise<string> {
  return `sha256:${hex(
    await crypto.subtle.digest(
      "SHA-256",
      arrayBuffer(utf8(canonicalJson(value))),
    ),
  )}`;
}

/**
 * Verify the immutable address-only recipient declaration before a browser
 * asks any wallet for accounts, signatures, or a transaction.
 *
 * This declaration is intentionally separate from the dormant managed-wallet
 * manifest protocol. Its digest binds the exact receiving-address descriptor
 * whose signed-nonce proof of control was admitted by K1Hub.
 */
export async function verifyExternalRecipientDeclaration(options: {
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
}): Promise<VerifiedExternalRecipient> {
  const extensions = options.paymentRequired.extensions ?? {};
  if (extensions["com.k1hub.wallet-manifest"] !== undefined) {
    throw new Error(
      "external payment challenge must not contain a managed wallet manifest",
    );
  }
  const declaration = extensions[EXTERNAL_RECIPIENT_EXTENSION];
  const info = exact(
    declaration?.info,
    ["version", "recipients"],
    "external-recipient info",
  );
  if (info.version !== 1 || !Array.isArray(info.recipients)) {
    throw new Error("unsupported external-recipient declaration version");
  }
  if (info.recipients.length < 1 || info.recipients.length > 32) {
    throw new Error("external-recipient list is outside the supported bound");
  }

  const verified: VerifiedExternalRecipient[] = [];
  const identities = new Set<string>();
  for (const value of info.recipients) {
    const entry = exact(
      value,
      [
        "network",
        "asset",
        "payTo",
        "recipientDescriptorDigest",
        "recipientDescriptor",
      ],
      "external recipient",
    );
    if (
      typeof entry.network !== "string" ||
      typeof entry.asset !== "string" ||
      typeof entry.payTo !== "string" ||
      typeof entry.recipientDescriptorDigest !== "string" ||
      !SHA256.test(entry.recipientDescriptorDigest)
    ) {
      throw new Error("external recipient declaration is malformed");
    }
    const descriptor = validateDescriptor(entry.recipientDescriptor, {
      network: entry.network,
      payTo: entry.payTo,
    });
    if ((await digest(descriptor)) !== entry.recipientDescriptorDigest) {
      throw new Error("external recipient descriptor digest is invalid");
    }
    const identity = canonicalJson({
      network: entry.network,
      asset: entry.asset,
      payTo: entry.payTo,
    });
    if (identities.has(identity)) {
      throw new Error("external recipient declaration contains a duplicate");
    }
    identities.add(identity);
    verified.push({
      network: entry.network,
      asset: entry.asset,
      payTo: entry.payTo,
      recipientDescriptorDigest: entry.recipientDescriptorDigest,
      recipientDescriptor: descriptor,
    });
  }

  const matches = verified.filter(
    (entry) =>
      entry.network === options.accepted.network &&
      entry.asset === options.accepted.asset &&
      entry.payTo === options.accepted.payTo,
  );
  if (matches.length !== 1) {
    throw new Error(
      "accepted requirement has no unique external recipient declaration",
    );
  }
  return matches[0]!;
}
