import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { AgentWalletError } from "../errors.js";
import {
  canonicalJson,
  decodePaymentRequiredHeader,
  type JsonObject,
  type PaymentRequired,
  type PaymentRequirement,
} from "../protocol/http.js";

export type RequestEnvelope = {
  version: 1;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  contentType: string;
  bodyBase64: string;
  paymentRequired: string;
  challengeDigest: string;
  merchantReference?: string;
};

export type PaymentArtifact = {
  version: 1;
  attemptId: string;
  requestDigest: string;
  buyerPaymentIdentifier: string;
  wallet: string;
  payerAddress: string;
  selectedRequirementDigest: string;
  paymentSignature: string;
  createdAt: string;
  expiresAt: string;
};

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONTENT_TYPE = /^[\x21-\x7e]{1,256}$/;

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentWalletError("invalid_input", `${label} is not an object`);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) {
    throw new AgentWalletError("invalid_input", `${label} has unknown fields`);
  }
  return object;
}

export function normalizeRequestUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AgentWalletError("invalid_input", "request URL is invalid", {
      cause: error,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    value !== url.toString()
  ) {
    throw new AgentWalletError(
      "invalid_input",
      "request URL must be a normalized credential-free HTTPS URL",
    );
  }
  return url.toString();
}

export function parseRequestEnvelope(value: unknown): {
  envelope: RequestEnvelope;
  paymentRequired: PaymentRequired;
  body: Uint8Array;
  requestDigest: string;
} {
  const object = exactObject(
    value,
    [
      "version",
      "method",
      "url",
      "contentType",
      "bodyBase64",
      "paymentRequired",
      "challengeDigest",
      "merchantReference",
    ],
    "request envelope",
  );
  if (
    object.version !== 1 ||
    typeof object.method !== "string" ||
    !METHODS.has(object.method) ||
    typeof object.url !== "string" ||
    typeof object.contentType !== "string" ||
    !CONTENT_TYPE.test(object.contentType) ||
    typeof object.bodyBase64 !== "string" ||
    typeof object.paymentRequired !== "string" ||
    typeof object.challengeDigest !== "string" ||
    !SHA256.test(object.challengeDigest) ||
    (object.merchantReference !== undefined &&
      (typeof object.merchantReference !== "string" ||
        object.merchantReference.length > 256))
  ) {
    throw new AgentWalletError("invalid_input", "request envelope is malformed");
  }
  const body = Buffer.from(object.bodyBase64, "base64");
  if (
    body.length > 2 * 1024 * 1024 ||
    body.toString("base64") !== object.bodyBase64
  ) {
    throw new AgentWalletError(
      "invalid_input",
      "request body is not bounded canonical base64",
    );
  }
  const envelope: RequestEnvelope = {
    version: 1,
    method: object.method as RequestEnvelope["method"],
    url: normalizeRequestUrl(object.url),
    contentType: object.contentType,
    bodyBase64: object.bodyBase64,
    paymentRequired: object.paymentRequired,
    challengeDigest: object.challengeDigest,
    ...(object.merchantReference === undefined
      ? {}
      : { merchantReference: object.merchantReference }),
  };
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(envelope.paymentRequired);
  } catch (error) {
    throw new AgentWalletError(
      "request_binding_mismatch",
      "PAYMENT-REQUIRED could not be decoded strictly",
      { cause: error },
    );
  }
  if (normalizeRequestUrl(paymentRequired.resource.url) !== envelope.url) {
    throw new AgentWalletError(
      "request_binding_mismatch",
      "PAYMENT-REQUIRED resource does not match the exact request URL",
    );
  }
  return {
    envelope,
    paymentRequired,
    body,
    requestDigest: digestJson(envelope as unknown as JsonObject),
  };
}

export async function loadRequestEnvelope(path: string): Promise<ReturnType<typeof parseRequestEnvelope>> {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new AgentWalletError("invalid_input", `request envelope not found: ${absolute}`);
    }
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 3 * 1024 * 1024) {
    throw new AgentWalletError("invalid_input", "request envelope file is unsafe or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new AgentWalletError("invalid_input", "request envelope is not JSON", {
      cause: error,
    });
  }
  return parseRequestEnvelope(parsed);
}

export function digestBytes(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestJson(value: JsonObject): string {
  return digestBytes(canonicalJson(value));
}

export function requirementDigest(requirement: PaymentRequirement): string {
  return digestJson(requirement as unknown as JsonObject);
}

export function createBuyerPaymentIdentifier(): string {
  return randomBytes(24).toString("base64url");
}
