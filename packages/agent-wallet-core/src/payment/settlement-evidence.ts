import {
  decodeSettlementStatusExtension,
  SETTLEMENT_STATES,
  settlementFlags,
  type PaymentResponse,
  type SettlementState,
} from "../protocol/http.js";

const SETTLEMENT_IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAIP2_NETWORK = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const TRANSACTION = /^[\x21-\x7e]{1,256}$/;
const SETTLEMENT_STATE_SET = new Set<SettlementState>(SETTLEMENT_STATES);
const SETTLEMENT_TRANSITIONS: Record<SettlementState, readonly SettlementState[]> = {
  created: ["verifying", "rejected", "failed"],
  verifying: ["verified", "rejected", "failed"],
  verified: ["reserved", "rejected", "expired"],
  reserved: ["broadcasting", "rejected", "expired", "manual_review"],
  broadcasting: ["broadcast", "broadcast_unknown", "rejected", "manual_review"],
  broadcast_unknown: [
    "broadcast",
    "confirming",
    "confirmed",
    "finalized",
    "expired",
    "reverted",
    "reorged",
    "manual_review",
  ],
  broadcast: [
    "confirming",
    "confirmed",
    "finalized",
    "reverted",
    "reorged",
    "manual_review",
  ],
  confirming: [
    "confirmed",
    "finalized",
    "reverted",
    "reorged",
    "manual_review",
  ],
  confirmed: ["finalized", "reverted", "reorged", "manual_review"],
  finalized: ["reorged", "manual_review"],
  rejected: [],
  failed: ["manual_review"],
  expired: ["late_confirmed", "manual_review"],
  reverted: ["manual_review"],
  reorged: ["manual_review"],
  late_confirmed: ["finalized", "reorged", "manual_review"],
  manual_review: [],
};

export type SettlementEvidence = {
  version: 1;
  paymentId?: string;
  state?: SettlementState;
  confirmed?: boolean;
  finalized?: boolean;
  transaction?: string;
  network?: string;
};

export type StoredSettlementEvidence = SettlementEvidence & {
  updatedAt: string;
};

type StatusEvidence = {
  state: SettlementState;
  confirmed: boolean;
  finalized: boolean;
};

type BodyEvidence = SettlementEvidence;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function paymentId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SETTLEMENT_IDENTIFIER.test(value)) {
    throw new Error(`${label} is not a canonical settlement UUID`);
  }
  return value;
}

function network(value: unknown, label: string): string {
  if (typeof value !== "string" || !CAIP2_NETWORK.test(value)) {
    throw new Error(`${label} is not a CAIP-2 network`);
  }
  return value;
}

function transaction(value: unknown, label: string): string {
  if (typeof value !== "string" || !TRANSACTION.test(value)) {
    throw new Error(`${label} is not a bounded transaction identifier`);
  }
  return value;
}

function unique<T>(values: readonly T[], label: string): T | undefined {
  const distinct = [...new Set(values)];
  if (distinct.length > 1) throw new Error(`${label} values contradict`);
  return distinct[0];
}

function statusEvidence(
  value: Record<string, unknown>,
  label: string,
  recognizeStateOnly = false,
): StatusEvidence | undefined {
  if (
    !hasOwn(value, "confirmed") &&
    !hasOwn(value, "finalized") &&
    !(recognizeStateOnly && hasOwn(value, "state"))
  ) {
    return undefined;
  }
  const present = ["state", "confirmed", "finalized"].filter((key) =>
    hasOwn(value, key),
  );
  if (present.length === 0) return undefined;
  if (
    present.length !== 3 ||
    typeof value.state !== "string" ||
    !SETTLEMENT_STATE_SET.has(value.state as SettlementState) ||
    typeof value.confirmed !== "boolean" ||
    typeof value.finalized !== "boolean"
  ) {
    throw new Error(`${label} settlement status is malformed`);
  }
  const state = value.state as SettlementState;
  const expected = settlementFlags(state);
  if (
    expected.confirmed !== value.confirmed ||
    expected.finalized !== value.finalized
  ) {
    throw new Error(`${label} settlement flags contradict its state`);
  }
  return {
    state,
    confirmed: value.confirmed,
    finalized: value.finalized,
  };
}

function partialTerminalStatus(
  value: Record<string, unknown> | undefined,
): StatusEvidence | undefined {
  if (value === undefined || !hasOwn(value, "state")) return undefined;
  if (typeof value.state !== "string") {
    throw new Error("error detail settlement state is malformed");
  }
  if (!SETTLEMENT_STATE_SET.has(value.state as SettlementState)) {
    throw new Error("error detail settlement state is unknown");
  }
  const state = value.state as SettlementState;
  if (state !== "reverted" && state !== "reorged") return undefined;
  return { state, ...settlementFlags(state) };
}

function parseBodyEvidence(body: Uint8Array): BodyEvidence {
  if (body.byteLength === 0) return { version: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    return { version: 1 };
  }
  if (!isObject(parsed)) return { version: 1 };

  const error = isObject(parsed.error) ? parsed.error : undefined;
  const detail = isObject(error?.detail) ? error.detail : undefined;
  const nestedPayment = isObject(parsed.payment) ? parsed.payment : undefined;
  const identifiers: string[] = [];
  for (const [container, key, label] of [
    [parsed, "paymentId", "paymentId"],
    [parsed, "payment_id", "payment_id"],
    [detail, "paymentId", "error.detail.paymentId"],
    [detail, "payment_id", "error.detail.payment_id"],
    [nestedPayment, "paymentId", "payment.paymentId"],
    [nestedPayment, "payment_id", "payment.payment_id"],
  ] as const) {
    if (container !== undefined && hasOwn(container, key)) {
      identifiers.push(paymentId(container[key], label));
    }
  }

  const topStatus = statusEvidence(
    parsed,
    "response body",
    identifiers.length > 0,
  );
  const nestedStatus =
    nestedPayment === undefined
      ? undefined
      : statusEvidence(nestedPayment, "response body payment", true);
  const terminalStatus =
    identifiers.length === 0 ? undefined : partialTerminalStatus(detail);
  const statuses = [topStatus, nestedStatus, terminalStatus].filter(
    (item): item is StatusEvidence => item !== undefined,
  );
  const serializedStatuses = statuses.map(
    (item) => `${item.state}|${item.confirmed}|${item.finalized}`,
  );
  if (new Set(serializedStatuses).size > 1) {
    throw new Error("response body settlement statuses contradict");
  }
  const status = statuses[0];
  const anchored =
    identifiers.length > 0 || topStatus !== undefined || nestedStatus !== undefined;

  const transactions: string[] = [];
  const networks: string[] = [];
  if (anchored) {
    for (const [container, key, label] of [
      [parsed, "transaction", "response body transaction"],
      [nestedPayment, "transaction", "response body payment transaction"],
    ] as const) {
      if (container !== undefined && hasOwn(container, key)) {
        if (container[key] === "" && status?.confirmed !== true) continue;
        transactions.push(transaction(container[key], label));
      }
    }
    for (const [container, key, label] of [
      [parsed, "network", "response body network"],
      [nestedPayment, "network", "response body payment network"],
    ] as const) {
      if (container !== undefined && hasOwn(container, key)) {
        if (container[key] === "" && status?.confirmed !== true) continue;
        networks.push(network(container[key], label));
      }
    }
  }

  const identifier = unique(identifiers, "response body payment ID");
  const observedTransaction = unique(
    transactions,
    "response body transaction",
  );
  const observedNetwork = unique(networks, "response body network");
  return {
    version: 1,
    ...(identifier === undefined ? {} : { paymentId: identifier }),
    ...(status === undefined ? {} : status),
    ...(observedTransaction === undefined
      ? {}
      : { transaction: observedTransaction }),
    ...(observedNetwork === undefined ? {} : { network: observedNetwork }),
  };
}

function assertStatusShape(value: SettlementEvidence, label: string): void {
  if (value.version !== 1) {
    throw new Error(`${label} has an unsupported version`);
  }
  if (value.paymentId !== undefined) {
    paymentId(value.paymentId, `${label} paymentId`);
  }
  if (value.transaction !== undefined) {
    transaction(value.transaction, `${label} transaction`);
  }
  if (value.network !== undefined) {
    network(value.network, `${label} network`);
  }
  const present = [value.state, value.confirmed, value.finalized].filter(
    (item) => item !== undefined,
  ).length;
  if (present !== 0 && present !== 3) {
    throw new Error(`${label} has incomplete settlement status`);
  }
  if (value.state !== undefined) {
    if (!SETTLEMENT_STATE_SET.has(value.state)) {
      throw new Error(`${label} has an unknown settlement state`);
    }
    const expected = settlementFlags(value.state);
    if (
      expected.confirmed !== value.confirmed ||
      expected.finalized !== value.finalized
    ) {
      throw new Error(`${label} settlement flags contradict its state`);
    }
  }
}

function assertCompatibleStatus(
  left: SettlementEvidence,
  right: SettlementEvidence,
): void {
  if (left.state === undefined || right.state === undefined) return;
  if (
    left.state !== right.state ||
    left.confirmed !== right.confirmed ||
    left.finalized !== right.finalized
  ) {
    throw new Error("settlement status evidence contradicts");
  }
}

function canReachSettlementState(
  previous: SettlementState,
  observed: SettlementState,
): boolean {
  if (previous === observed) return true;
  const visited = new Set<SettlementState>([previous]);
  const pending = [...SETTLEMENT_TRANSITIONS[previous]];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (candidate === observed) return true;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    pending.push(...SETTLEMENT_TRANSITIONS[candidate]);
  }
  return false;
}

export function settlementEvidenceFromResponse(options: {
  paymentResponse?: PaymentResponse;
  responseBody: Uint8Array;
  attemptNetwork: string;
}): SettlementEvidence {
  const body = parseBodyEvidence(options.responseBody);
  const extension = decodeSettlementStatusExtension(
    options.paymentResponse?.extensions,
  );
  if (
    extension !== undefined &&
    options.paymentResponse?.success !== extension.confirmed
  ) {
    throw new Error(
      "PAYMENT-RESPONSE success contradicts settlement-status confirmation",
    );
  }
  const headerStatus: SettlementEvidence = {
    version: 1,
    ...(extension === undefined
      ? {}
      : {
          paymentId: extension.settlementJobId,
          state: extension.state,
          confirmed: extension.confirmed,
          finalized: extension.finalized,
        }),
  };
  assertCompatibleStatus(headerStatus, body);

  const response = options.paymentResponse;
  if (response === undefined) {
    return body.paymentId === undefined
      ? { version: 1 }
      : { version: 1, paymentId: body.paymentId };
  }
  if (body.confirmed === true && response.success === false) {
    throw new Error("response body confirmation contradicts PAYMENT-RESPONSE");
  }

  const identifiers = [headerStatus.paymentId, body.paymentId].filter(
    (item): item is string => item !== undefined,
  );
  const identifier = unique(identifiers, "settlement payment ID");

  const headerTransaction =
    response.transaction.length === 0
      ? undefined
      : transaction(response.transaction, "PAYMENT-RESPONSE transaction");
  const headerNetwork =
    response.network.length === 0
      ? undefined
      : network(response.network, "PAYMENT-RESPONSE network");
  if (headerNetwork !== undefined && headerNetwork !== options.attemptNetwork) {
    throw new Error("PAYMENT-RESPONSE network contradicts the payment attempt");
  }
  const observedTransaction = unique(
    [headerTransaction, body.transaction].filter(
      (item): item is string => item !== undefined,
    ),
    "settlement transaction",
  );
  const observedNetwork = unique(
    [headerNetwork, body.network].filter(
      (item): item is string => item !== undefined,
    ),
    "settlement network",
  );
  if (observedNetwork !== undefined && observedNetwork !== options.attemptNetwork) {
    throw new Error("response body network contradicts the payment attempt");
  }

  let status = extension === undefined ? undefined : headerStatus;
  if (status === undefined && body.state !== undefined) status = body;
  if (response.success) {
    if (headerTransaction === undefined || headerNetwork === undefined) {
      throw new Error(
        "successful PAYMENT-RESPONSE requires transaction and network",
      );
    }
    if (status !== undefined && status.confirmed !== true) {
      throw new Error(
        "successful PAYMENT-RESPONSE contradicts unconfirmed settlement state",
      );
    }
    if (extension === undefined) {
      status = {
        version: 1,
        state: "confirmed",
        confirmed: true,
        finalized: false,
      };
    } else {
      status ??= {
        version: 1,
        state: "confirmed",
        confirmed: true,
        finalized: false,
      };
    }
  }

  const result: SettlementEvidence = {
    version: 1,
    ...(identifier === undefined ? {} : { paymentId: identifier }),
    ...(status?.state === undefined
      ? {}
      : {
          state: status.state,
          confirmed: status.confirmed,
          finalized: status.finalized,
        }),
    ...(observedTransaction === undefined
      ? {}
      : { transaction: observedTransaction }),
    ...(observedNetwork === undefined ? {} : { network: observedNetwork }),
  };
  assertStatusShape(result, "settlement response");
  return result;
}

export function mergeSettlementEvidence(
  previous: SettlementEvidence | undefined,
  observed: SettlementEvidence,
): SettlementEvidence {
  assertStatusShape(observed, "observed settlement evidence");
  if (previous === undefined) return observed;
  assertStatusShape(previous, "stored settlement evidence");
  for (const field of ["paymentId", "transaction", "network"] as const) {
    if (
      previous[field] !== undefined &&
      observed[field] !== undefined &&
      previous[field] !== observed[field]
    ) {
      throw new Error(`settlement ${field} changed across an exact retry`);
    }
  }
  if (previous.state !== undefined && observed.state !== undefined) {
    if (!canReachSettlementState(previous.state, observed.state)) {
      throw new Error("settlement state regressed or changed incompatibly");
    }
  }
  const merged: SettlementEvidence = {
    version: 1,
    ...((observed.paymentId ?? previous.paymentId) === undefined
      ? {}
      : { paymentId: observed.paymentId ?? previous.paymentId }),
    ...((observed.state ?? previous.state) === undefined
      ? {}
      : { state: observed.state ?? previous.state }),
    ...((observed.confirmed ?? previous.confirmed) === undefined
      ? {}
      : { confirmed: observed.confirmed ?? previous.confirmed }),
    ...((observed.finalized ?? previous.finalized) === undefined
      ? {}
      : { finalized: observed.finalized ?? previous.finalized }),
    ...((observed.transaction ?? previous.transaction) === undefined
      ? {}
      : { transaction: observed.transaction ?? previous.transaction }),
    ...((observed.network ?? previous.network) === undefined
      ? {}
      : { network: observed.network ?? previous.network }),
  };
  return merged;
}

export function parseStoredSettlementEvidence(
  value: unknown,
): StoredSettlementEvidence {
  if (!isObject(value)) throw new Error("settlement sidecar is malformed");
  const allowed = new Set([
    "version",
    "paymentId",
    "state",
    "confirmed",
    "finalized",
    "transaction",
    "network",
    "updatedAt",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.version !== 1 ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error("settlement sidecar is malformed");
  }
  const evidence: StoredSettlementEvidence = {
    version: 1,
    updatedAt: value.updatedAt,
    ...(value.paymentId === undefined
      ? {}
      : { paymentId: paymentId(value.paymentId, "sidecar paymentId") }),
    ...(value.state === undefined
      ? {}
      : { state: value.state as SettlementState }),
    ...(value.confirmed === undefined
      ? {}
      : { confirmed: value.confirmed as boolean }),
    ...(value.finalized === undefined
      ? {}
      : { finalized: value.finalized as boolean }),
    ...(value.transaction === undefined
      ? {}
      : { transaction: transaction(value.transaction, "sidecar transaction") }),
    ...(value.network === undefined
      ? {}
      : { network: network(value.network, "sidecar network") }),
  };
  if (
    (value.confirmed !== undefined && typeof value.confirmed !== "boolean") ||
    (value.finalized !== undefined && typeof value.finalized !== "boolean")
  ) {
    throw new Error("settlement sidecar flags are malformed");
  }
  assertStatusShape(evidence, "settlement sidecar");
  if (
    evidence.paymentId === undefined &&
    evidence.state === undefined &&
    evidence.transaction === undefined &&
    evidence.network === undefined
  ) {
    throw new Error("settlement sidecar has no evidence");
  }
  return evidence;
}

export function settlementInvalidated(
  evidence: SettlementEvidence,
): boolean {
  return evidence.state === "reverted" || evidence.state === "reorged";
}
