import {
  canonicalJson,
  type PaymentRequired,
  type PaymentRequirement,
} from "../../src/protocol/http.js";

export const TRON_PAYMENT_NOW_MS = 1_784_980_800_000;
export const TRON_PAYER = "TCNkawTmcQgYSU8nP8cHswT1QPjharxJr7"; // pragma: allowlist secret
export const TRON_RECIPIENT = "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV"; // pragma: allowlist secret
export const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // pragma: allowlist secret
export const TRON_SIGNATURE =
  "79fb1b00000003154bc2f5b7d27c9aeb87b74feb57c7937594b3ceb1653694834bb70b422c63901e1432c2fbe146eaf5d2a7cae4fb084a951aab4386338e18a100"; // pragma: allowlist secret

export const TRON_TRANSACTION = {
  txID: "62b7ad4e4c5d78310deb617c4f0d5f3f89a9a57a2d46f78f75a5a86915a74b33", // pragma: allowlist secret
  raw_data_hex:
    "0a0212342208565656565656565640c0ad9dc9f93352254b3158340100000000000000000000000000000000000000000000000000000000000000005aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15411a642f0e3c3af545e7acbd38b07251b3990914f1121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f42407098fc95c9f933900180c2d72f", // pragma: allowlist secret
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildTronPaymentTrustFixture(): Promise<{
  accepted: PaymentRequirement;
  paymentRequired: PaymentRequired;
}> {
  const accepted: PaymentRequirement = {
    scheme: "exact",
    network: "tron:mainnet",
    amount: "1000000",
    asset: TRON_USDT,
    payTo: TRON_RECIPIENT,
    maxTimeoutSeconds: 180,
    extra: {
      assetTransferMethod: "signed_trc20_transaction",
      payloadProfile: "com.k1hub.x402.tron-exact.v1",
      transactionContractType: "TriggerSmartContract",
      function: "transfer(address,uint256)",
      challengeCommitment: `sha256:${"00".repeat(32)}`,
    },
  };
  const recipientDescriptor = {
    type: "com.k1hub.external-receiving-address.v1",
    tenantId: "019f99e4-3371-7252-9d0a-eac7d4822520",
    network: accepted.network,
    address: accepted.payTo,
    controlChallengeDigest: `sha256:${"77".repeat(32)}`,
  };
  const recipientDescriptorDigest = `sha256:${hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(recipientDescriptor)),
    ),
  )}`;
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: "https://tenant.test/report",
      description: "Report",
      mimeType: "application/json",
    },
    accepts: [accepted],
    extensions: {
      "payment-identifier": { info: { required: true } },
      "com.k1hub.external-recipient": {
        info: {
          version: 1,
          recipients: [
            {
              network: accepted.network,
              asset: accepted.asset,
              payTo: accepted.payTo,
              recipientDescriptorDigest,
              recipientDescriptor,
            },
          ],
        },
      },
    },
  };
  return { accepted, paymentRequired };
}
