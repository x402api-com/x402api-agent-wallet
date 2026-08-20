export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type PaymentRequirement = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: JsonObject;
};

export type ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
};

export type PaymentRequired = {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirement[];
  extensions?: Record<string, ExtensionDeclaration>;
};

export type ExtensionDeclaration = {
  info: JsonObject;
  schema?: JsonObject;
};

export type PaymentPayload = {
  x402Version: 2;
  accepted: PaymentRequirement;
  payload: JsonObject;
  extensions: Record<string, ExtensionDeclaration>;
  resource?: PaymentRequired["resource"];
};

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 512 * 1024;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const CAIP2_NETWORK = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const PAYMENT_IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("cryptographic JSON numbers must be safe integers");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertJsonValue);
    return;
  }
  if (isObject(value)) {
    Object.values(value).forEach(assertJsonValue);
    return;
  }
  throw new Error("value is not JSON");
}

export function canonicalJson(value: JsonValue): string {
  assertJsonValue(value);
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function decodeBase64Json(value: string, maximumBytes: number): unknown {
  if (value.length === 0 || value.length > maximumBytes || !BASE64.test(value)) {
    throw new Error("x402 header is not canonical base64");
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) throw new Error("non-canonical base64");
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("x402 header is not valid base64");
  }
  if (bytes.byteLength > maximumBytes) {
    throw new Error("x402 header exceeds the maximum size");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("x402 header is not UTF-8 JSON");
  }
}

function encodeBase64Json(value: JsonValue, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.byteLength > maximumBytes) {
    throw new Error("x402 value exceeds the maximum size");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  if (encoded.length > maximumBytes) {
    throw new Error("x402 header exceeds the maximum size");
  }
  return encoded;
}

function requirement(value: unknown): PaymentRequirement {
  if (!isObject(value)) throw new Error("payment requirement is not an object");
  const allowed = new Set([
    "scheme",
    "network",
    "amount",
    "asset",
    "payTo",
    "maxTimeoutSeconds",
    "extra",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("payment requirement has unknown fields");
  }
  if (
    typeof value.scheme !== "string" ||
    typeof value.network !== "string" ||
    !CAIP2_NETWORK.test(value.network) ||
    typeof value.amount !== "string" ||
    !DECIMAL.test(value.amount) ||
    value.amount === "0" ||
    typeof value.asset !== "string" ||
    typeof value.payTo !== "string" ||
    !Number.isSafeInteger(value.maxTimeoutSeconds) ||
    (value.maxTimeoutSeconds as number) < 1 ||
    !isObject(value.extra)
  ) {
    throw new Error("payment requirement is malformed");
  }
  assertJsonValue(value.extra);
  return value as PaymentRequirement;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function resource(value: unknown): PaymentRequired["resource"] {
  const allowed = new Set([
    "url",
    "description",
    "mimeType",
    "serviceName",
    "tags",
    "iconUrl",
  ]);
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.url !== "string" ||
    !optionalString(value.description) ||
    !optionalString(value.mimeType) ||
    !optionalString(value.serviceName) ||
    (value.serviceName !== undefined &&
      (value.serviceName.length < 1 ||
        value.serviceName.length > 32 ||
        !PRINTABLE_ASCII.test(value.serviceName))) ||
    (value.tags !== undefined &&
      (!Array.isArray(value.tags) ||
        value.tags.length > 5 ||
        value.tags.some(
          (tag) =>
            typeof tag !== "string" ||
            tag.length < 1 ||
            tag.length > 32 ||
            !PRINTABLE_ASCII.test(tag),
        ))) ||
    !optionalString(value.iconUrl)
  ) {
    throw new Error("payment resource is malformed");
  }
  return value as PaymentRequired["resource"];
}

function paymentPayloadExtensions(
  value: unknown,
): Record<string, ExtensionDeclaration> {
  if (!isObject(value)) {
    throw new Error("payment payload extensions are malformed");
  }
  const extensions: Record<string, ExtensionDeclaration> = {};
  for (const [name, declaration] of Object.entries(value)) {
    if (
      !isObject(declaration) ||
      Object.keys(declaration).some(
        (key) => key !== "info" && key !== "schema",
      ) ||
      !isObject(declaration.info) ||
      (declaration.schema !== undefined && !isObject(declaration.schema))
    ) {
      throw new Error(`payment payload extension ${name} is malformed`);
    }
    assertJsonValue(declaration.info);
    if (declaration.schema !== undefined) assertJsonValue(declaration.schema);
    extensions[name] = declaration as ExtensionDeclaration;
  }
  return extensions;
}

export function decodePaymentRequiredHeader(value: string): PaymentRequired {
  const parsed = decodeBase64Json(value, MAX_HEADER_BYTES);
  if (!isObject(parsed)) throw new Error("PAYMENT-REQUIRED is not an object");
  const allowed = new Set([
    "x402Version",
    "error",
    "resource",
    "accepts",
    "extensions",
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) {
    throw new Error("PAYMENT-REQUIRED has unknown fields");
  }
  if (
    parsed.x402Version !== 2 ||
    (parsed.error !== undefined && typeof parsed.error !== "string") ||
    !Array.isArray(parsed.accepts) ||
    parsed.accepts.length < 1 ||
    (parsed.extensions !== undefined && !isObject(parsed.extensions))
  ) {
    throw new Error("PAYMENT-REQUIRED is malformed");
  }
  const accepts = parsed.accepts.map(requirement);
  const extensions: Record<string, ExtensionDeclaration> = {};
  if (isObject(parsed.extensions)) {
    for (const [name, declaration] of Object.entries(parsed.extensions)) {
      if (
        !isObject(declaration) ||
        Object.keys(declaration).some(
          (key) => key !== "info" && key !== "schema",
        ) ||
        !isObject(declaration.info) ||
        (declaration.schema !== undefined && !isObject(declaration.schema))
      ) {
        throw new Error(`extension ${name} is malformed`);
      }
      assertJsonValue(declaration.info);
      if (declaration.schema !== undefined) assertJsonValue(declaration.schema);
      extensions[name] = declaration as ExtensionDeclaration;
    }
  }
  return {
    x402Version: 2,
    ...(parsed.error === undefined ? {} : { error: parsed.error }),
    resource: resource(parsed.resource),
    accepts,
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
}
export function encodePaymentRequiredHeader(value: PaymentRequired): string {
  return encodeBase64Json(value as unknown as JsonObject, MAX_HEADER_BYTES);
}

function copiedExtensionInfo(
  declarations: Record<string, ExtensionDeclaration> | undefined,
): Record<string, ExtensionDeclaration> {
  const result: Record<string, ExtensionDeclaration> = {};
  for (const [name, declaration] of Object.entries(declarations ?? {})) {
    result[name] = JSON.parse(
      canonicalJson(declaration as unknown as JsonObject),
    ) as ExtensionDeclaration;
  }
  return result;
}

export function createPaymentPayload(options: {
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  schemePayload: JsonObject;
  paymentIdentifier?: string;
}): PaymentPayload {
  const { paymentRequired, accepted, schemePayload, paymentIdentifier } = options;
  const advertised = paymentRequired.accepts.some(
    (candidate) =>
      canonicalJson(candidate as unknown as JsonObject) ===
      canonicalJson(accepted as unknown as JsonObject),
  );
  if (!advertised) throw new Error("accepted requirement was not advertised");
  assertJsonValue(schemePayload);
  const extensions = copiedExtensionInfo(paymentRequired.extensions);
  const identifier = extensions["payment-identifier"];
  if (identifier) {
    if (!paymentIdentifier || !PAYMENT_IDENTIFIER.test(paymentIdentifier)) {
      throw new Error("a valid buyer payment identifier is required");
    }
    identifier.info.id = paymentIdentifier;
  } else if (paymentIdentifier !== undefined) {
    throw new Error("server did not declare the payment-identifier extension");
  }
  return {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted,
    payload: schemePayload,
    extensions,
  };
}

export function encodePaymentSignature(value: PaymentPayload): string {
  return encodeBase64Json(value as unknown as JsonObject, MAX_SIGNATURE_BYTES);
}

export function decodePaymentSignature(value: string): PaymentPayload {
  const parsed = decodeBase64Json(value, MAX_SIGNATURE_BYTES);
  if (!isObject(parsed)) {
    throw new Error("PAYMENT-SIGNATURE is not an object");
  }
  const allowed = new Set([
    "x402Version",
    "accepted",
    "payload",
    "extensions",
    "resource",
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) {
    throw new Error("PAYMENT-SIGNATURE has unknown fields");
  }
  if (
    parsed.x402Version !== 2 ||
    !isObject(parsed.payload) ||
    !isObject(parsed.extensions)
  ) {
    throw new Error("PAYMENT-SIGNATURE is malformed");
  }
  assertJsonValue(parsed.payload);
  return {
    x402Version: 2,
    accepted: requirement(parsed.accepted),
    payload: parsed.payload as JsonObject,
    extensions: paymentPayloadExtensions(parsed.extensions),
    ...(parsed.resource === undefined
      ? {}
      : { resource: resource(parsed.resource) }),
  };
}
