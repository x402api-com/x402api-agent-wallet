import { describe, expect, it } from "vitest";

import {
  mergeSettlementEvidence,
  parseStoredSettlementEvidence,
  settlementEvidenceFromResponse,
  type PaymentResponse,
  type SettlementEvidence,
} from "../src/index.js";

const paymentId = "01a069c8-77b9-75c7-946b-1858db8b8249";
const network = "eip155:8453";
const transaction = `0x${"ab".repeat(32)}`;

function body(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function response(
  state: "confirmed" | "finalized" = "confirmed",
): PaymentResponse {
  const finalized = state === "finalized";
  return {
    success: true,
    transaction,
    network,
    extensions: {
      "com.k1hub.settlement-status": {
        version: 1,
        settlementJobId: paymentId,
        state,
        confirmed: true,
        finalized,
      },
    },
  };
}

describe("confirmed-first settlement evidence", () => {
  it("reconciles the dynamic-charge body with PAYMENT-RESPONSE", () => {
    expect(
      settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: body({
          payment_id: paymentId,
          state: "confirmed",
          confirmed: true,
          finalized: false,
          transaction,
          network,
        }),
        attemptNetwork: network,
      }),
    ).toEqual({
      version: 1,
      paymentId,
      state: "confirmed",
      confirmed: true,
      finalized: false,
      transaction,
      network,
    });
  });

  it("accepts the same confirmed-first contract for Solana", () => {
    const solanaNetwork = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const solanaTransaction = "5".repeat(88);
    expect(
      settlementEvidenceFromResponse({
        paymentResponse: {
          success: true,
          transaction: solanaTransaction,
          network: solanaNetwork,
          extensions: {
            "com.k1hub.settlement-status": {
              version: 1,
              settlementJobId: paymentId,
              state: "confirmed",
              confirmed: true,
              finalized: false,
            },
          },
        },
        responseBody: body({
          payment_id: paymentId,
          state: "confirmed",
          confirmed: true,
          finalized: false,
          transaction: solanaTransaction,
          network: solanaNetwork,
        }),
        attemptNetwork: solanaNetwork,
      }),
    ).toEqual({
      version: 1,
      paymentId,
      state: "confirmed",
      confirmed: true,
      finalized: false,
      transaction: solanaTransaction,
      network: solanaNetwork,
    });
  });

  it("reconciles gateway nested payment status", () => {
    expect(
      settlementEvidenceFromResponse({
        paymentResponse: response("finalized"),
        responseBody: body({
          status: "payment_settled",
          transaction,
          payment: {
            state: "finalized",
            confirmed: true,
            finalized: true,
          },
          fulfillment: { status: "complete" },
        }),
        attemptNetwork: network,
      }),
    ).toMatchObject({
      paymentId,
      state: "finalized",
      confirmed: true,
      finalized: true,
    });
  });

  it("conservatively maps legacy x402 success to confirmed", () => {
    expect(
      settlementEvidenceFromResponse({
        paymentResponse: { success: true, transaction, network },
        responseBody: body({ download: "ready" }),
        attemptNetwork: network,
      }),
    ).toEqual({
      version: 1,
      state: "confirmed",
      confirmed: true,
      finalized: false,
      transaction,
      network,
    });
  });

  it.each([
    {
      label: "top-level",
      responseBody: {
        payment_id: paymentId,
        state: "finalized",
        confirmed: true,
        finalized: true,
        transaction,
        network,
      },
    },
    {
      label: "nested",
      responseBody: {
        payment: {
          payment_id: paymentId,
          state: "finalized",
          confirmed: true,
          finalized: true,
          transaction,
          network,
        },
      },
    },
  ])("does not infer legacy $label finality from the response body", ({ responseBody }) => {
    expect(
      settlementEvidenceFromResponse({
        paymentResponse: { success: true, transaction, network },
        responseBody: body(responseBody),
        attemptNetwork: network,
      }),
    ).toMatchObject({
      paymentId,
      state: "confirmed",
      confirmed: true,
      finalized: false,
      transaction,
      network,
    });
  });

  it("does not mistake an ordinary fulfillment state field for settlement evidence", () => {
    expect(
      settlementEvidenceFromResponse({
        paymentResponse: { success: true, transaction, network },
        responseBody: body({ state: "ready", report: "complete" }),
        attemptNetwork: network,
      }),
    ).toMatchObject({
      state: "confirmed",
      confirmed: true,
      finalized: false,
    });
  });

  it("accepts empty transaction fields before confirmation and advances later", () => {
    const pending = settlementEvidenceFromResponse({
      paymentResponse: {
        success: false,
        errorReason: "confirming",
        transaction: "",
        network,
        extensions: {
          "com.k1hub.settlement-status": {
            version: 1,
            settlementJobId: paymentId,
            state: "confirming",
            confirmed: false,
            finalized: false,
          },
        },
      },
      responseBody: body({
        payment_id: paymentId,
        state: "confirming",
        confirmed: false,
        finalized: false,
        transaction: "",
        network,
      }),
      attemptNetwork: network,
    });
    expect(pending).toMatchObject({
      state: "confirming",
      confirmed: false,
      finalized: false,
    });
    expect(pending).not.toHaveProperty("transaction");
    expect(
      mergeSettlementEvidence(
        pending,
        settlementEvidenceFromResponse({
          paymentResponse: response(),
          responseBody: new Uint8Array(),
          attemptNetwork: network,
        }),
      ),
    ).toMatchObject({ state: "confirmed", confirmed: true, transaction });
  });

  it.each([
    {
      label: "payment ID",
      responseBody: {
        payment_id: "01a069c8-77b9-75c7-946b-1858db8b8250",
        state: "confirmed",
        confirmed: true,
        finalized: false,
      },
    },
    {
      label: "transaction",
      responseBody: {
        payment_id: paymentId,
        state: "confirmed",
        confirmed: true,
        finalized: false,
        transaction: `0x${"cd".repeat(32)}`,
      },
    },
    {
      label: "network",
      responseBody: {
        payment_id: paymentId,
        state: "confirmed",
        confirmed: true,
        finalized: false,
        network: "eip155:137",
      },
    },
    {
      label: "state",
      responseBody: {
        payment_id: paymentId,
        state: "finalized",
        confirmed: true,
        finalized: true,
      },
    },
  ])("rejects contradictory body $label evidence", ({ responseBody }) => {
    expect(() =>
      settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: body(responseBody),
        attemptNetwork: network,
      }),
    ).toThrow(/contradict/);
  });

  it("rejects malformed recognized body evidence", () => {
    expect(() =>
      settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: body({
          payment_id: paymentId,
          state: "confirmed",
          confirmed: "true",
          finalized: false,
        }),
        attemptNetwork: network,
      }),
    ).toThrow(/malformed/);
    expect(() =>
      settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: body({ payment_id: "not-a-uuid" }),
        attemptNetwork: network,
      }),
    ).toThrow(/UUID/);
    expect(() =>
      settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: body({ payment_id: paymentId, state: "confirmed" }),
        attemptNetwork: network,
      }),
    ).toThrow(/malformed/);
    expect(() =>
      settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: body({ payment: { state: "confirmed" } }),
        attemptNetwork: network,
      }),
    ).toThrow(/malformed/);
  });

  it("rejects successful evidence for the wrong attempt network", () => {
    expect(() =>
      settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: new Uint8Array(),
        attemptNetwork: "eip155:137",
      }),
    ).toThrow(/payment attempt/);
  });

  it("rejects direct PaymentResponse objects that contradict their extension", () => {
    expect(() =>
      settlementEvidenceFromResponse({
        paymentResponse: { ...response(), success: false },
        responseBody: new Uint8Array(),
        attemptNetwork: network,
      }),
    ).toThrow(/success contradicts/);
  });

  it("allows finalization and explicit invalidation but not regression", () => {
    const confirmed: SettlementEvidence = {
      version: 1,
      paymentId,
      state: "confirmed",
      confirmed: true,
      finalized: false,
      transaction,
      network,
    };
    expect(
      mergeSettlementEvidence(confirmed, {
        ...confirmed,
        state: "finalized",
        finalized: true,
      }),
    ).toMatchObject({ state: "finalized", confirmed: true, finalized: true });
    expect(
      mergeSettlementEvidence(confirmed, {
        ...confirmed,
        state: "reorged",
        confirmed: false,
        finalized: false,
      }),
    ).toMatchObject({ state: "reorged", confirmed: false, finalized: false });
    expect(() =>
      mergeSettlementEvidence(
        { ...confirmed, state: "finalized", finalized: true },
        confirmed,
      ),
    ).toThrow(/regressed/);
    expect(
      mergeSettlementEvidence(
        {
          version: 1,
          paymentId,
          state: "confirming",
          confirmed: false,
          finalized: false,
          transaction,
          network,
        },
        confirmed,
      ),
    ).toMatchObject({ state: "confirmed", confirmed: true });
    expect(() =>
      mergeSettlementEvidence(
        {
          ...confirmed,
          state: "reorged",
          confirmed: false,
          finalized: false,
        },
        confirmed,
      ),
    ).toThrow(/regressed|incompatibly/);
    expect(() =>
      mergeSettlementEvidence(undefined, {
        ...confirmed,
        version: 2 as 1,
      }),
    ).toThrow(/version/);
  });

  it("follows the service settlement transition graph across skipped polls", () => {
    const evidence = (
      state: NonNullable<SettlementEvidence["state"]>,
    ): SettlementEvidence => ({
      version: 1,
      paymentId,
      state,
      confirmed: state === "confirmed" || state === "finalized",
      finalized: state === "finalized",
      transaction,
      network,
    });

    expect(
      mergeSettlementEvidence(evidence("created"), evidence("finalized")),
    ).toMatchObject({ state: "finalized", confirmed: true, finalized: true });
    expect(
      mergeSettlementEvidence(evidence("expired"), evidence("late_confirmed")),
    ).toMatchObject({
      state: "late_confirmed",
      confirmed: false,
      finalized: false,
    });
    expect(
      mergeSettlementEvidence(evidence("expired"), evidence("finalized")),
    ).toMatchObject({ state: "finalized", confirmed: true, finalized: true });
    expect(
      mergeSettlementEvidence(
        evidence("confirmed"),
        evidence("manual_review"),
      ),
    ).toMatchObject({
      state: "manual_review",
      confirmed: false,
      finalized: false,
    });

    for (const [previous, observed] of [
      ["confirming", "created"],
      ["rejected", "confirmed"],
      ["expired", "confirmed"],
    ] as const) {
      expect(() =>
        mergeSettlementEvidence(evidence(previous), evidence(observed)),
      ).toThrow(/regressed|incompatibly/);
    }
  });

  it("strictly parses a stored sidecar", () => {
    const stored = {
      ...settlementEvidenceFromResponse({
        paymentResponse: response(),
        responseBody: new Uint8Array(),
        attemptNetwork: network,
      }),
      updatedAt: "2026-09-04T03:00:00.000Z",
    };
    expect(parseStoredSettlementEvidence(stored)).toEqual(stored);
    expect(() =>
      parseStoredSettlementEvidence({ ...stored, unexpected: true }),
    ).toThrow(/sidecar/);
  });
});
