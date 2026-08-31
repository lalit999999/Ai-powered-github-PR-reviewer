import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isPayloadTooLarge,
  MAX_WEBHOOK_PAYLOAD_BYTES,
  verifyWebhookSignature,
} from "./webhook-verification.js";

const SECRET = "test-webhook-secret";

// Indented deliberately, not compacted: this is what makes the re-encode test below
// meaningful. A body parser that runs JSON.parse then JSON.stringify (no indentation
// option) collapses this whitespace, so the "after re-encode" bytes genuinely differ
// from these bytes even though the parsed value is identical — the exact class of
// mutation plan.md §45 names as the most common implementation bug in this phase.
const REALISTIC_BODY = JSON.stringify(
  {
    action: "opened",
    number: 42,
    pull_request: {
      number: 42,
      state: "open",
      draft: false,
      head: { sha: "abc123def456" },
      base: { sha: "def456abc123" },
    },
    repository: { full_name: "acme/widgets" },
    installation: { id: 987654321 },
  },
  null,
  2,
);

function sign(body: Buffer, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature over a realistic JSON body", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const result = verifyWebhookSignature(body, sign(body), SECRET);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a tampered body (one byte changed) as a mismatch", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const signature = sign(body);
    const tamperedBody = Buffer.from(
      REALISTIC_BODY.replace("opened", "closed"),
      "utf8",
    );

    const result = verifyWebhookSignature(tamperedBody, signature, SECRET);
    expect(result).toEqual({ ok: false, reason: "MISMATCH" });
  });

  it("rejects a tampered signature (one hex char changed) as a mismatch", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const signature = sign(body);
    const flippedChar = signature.at(-1) === "0" ? "1" : "0";
    const tamperedSignature = signature.slice(0, -1) + flippedChar;

    const result = verifyWebhookSignature(body, tamperedSignature, SECRET);
    expect(result).toEqual({ ok: false, reason: "MISMATCH" });
  });

  it("reports a missing header as MISSING_SIGNATURE", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const result = verifyWebhookSignature(body, undefined, SECRET);
    expect(result).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
  });

  it("reports an empty-string header as MISSING_SIGNATURE", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const result = verifyWebhookSignature(body, "", SECRET);
    expect(result).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
  });

  it("reports a header without the sha256= prefix as MALFORMED_SIGNATURE", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const hexDigest = createHmac("sha256", SECRET).update(body).digest("hex");
    const result = verifyWebhookSignature(body, hexDigest, SECRET);
    expect(result).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE" });
  });

  it("reports a header of the wrong length as MALFORMED_SIGNATURE, without throwing", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const tooShort = "sha256=abcd";

    let result;
    expect(() => {
      result = verifyWebhookSignature(body, tooShort, SECRET);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE" });
  });

  it("rejects a correct signature computed with the wrong secret", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const signature = sign(body, "a-different-secret");

    const result = verifyWebhookSignature(body, signature, SECRET);
    expect(result).toEqual({ ok: false, reason: "MISMATCH" });
  });

  // The regression guard for plan.md §45's named failure point: a body parser that
  // round-trips the raw bytes through JSON.parse/JSON.stringify (whitespace collapsed,
  // keys possibly reordered) produces a byte sequence GitHub never signed, even though
  // the parsed value is identical. If this test ever passes, the HMAC is being computed
  // over something other than the exact bytes received, and the whole module has
  // regressed to the bug plan.md §45 calls the most common implementation mistake in
  // this phase.
  it("detects the JSON re-encode mutation (body parser corrupting the signed bytes)", () => {
    const body = Buffer.from(REALISTIC_BODY, "utf8");
    const signature = sign(body);

    const reEncoded = Buffer.from(
      JSON.stringify(JSON.parse(body.toString())),
      "utf8",
    );

    const result = verifyWebhookSignature(reEncoded, signature, SECRET);
    expect(result).toEqual({ ok: false, reason: "MISMATCH" });
  });
});

describe("isPayloadTooLarge", () => {
  it("is false for a body at or under the cap", () => {
    expect(isPayloadTooLarge(Buffer.alloc(MAX_WEBHOOK_PAYLOAD_BYTES))).toBe(
      false,
    );
    expect(isPayloadTooLarge(Buffer.alloc(10))).toBe(false);
  });

  it("is true for a body over the cap", () => {
    expect(isPayloadTooLarge(Buffer.alloc(MAX_WEBHOOK_PAYLOAD_BYTES + 1))).toBe(
      true,
    );
  });
});
