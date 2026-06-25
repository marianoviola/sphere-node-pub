import { describe, it, expect } from "vitest";
import { gateContent } from "../src/core/gate.ts";
import type { FragmentManifest } from "../src/core/types.ts";

const FULL = "Line one of the body.\nLine two with much more text that goes well past the preview window.";

function manifest(access: FragmentManifest["access"]): FragmentManifest {
  return { id: "2026-01-15-x", title: "X", license: "CC-BY", access };
}

describe("gateContent", () => {
  it("returns full content with 200 for free policy", () => {
    const result = gateContent(manifest({ policy: "free" }), FULL);
    expect(result.status).toBe(200);
    expect(result.body).toBe(FULL);
    expect(result.contentType).toContain("text/markdown");
    expect(result.eventType).toBe("access");
    expect(result.challenge).toBeUndefined();
  });

  it("returns a bounded preview and a 402 challenge for paid policy", () => {
    const result = gateContent(
      manifest({
        policy: "paid",
        preview_chars: 20,
        price_per_access: 0.02,
        currency: "USD",
        payment: { profile: "MPP", method: "PaymentAuth", endpoint: "https://pay.example.com/mpp" },
      }),
      FULL,
    );

    expect(result.status).toBe(402);
    expect(result.eventType).toBe("payment_required");
    expect(result.contentType).toContain("application/json");

    const payload = JSON.parse(result.body) as {
      policy: string;
      preview: string;
      challenge: Record<string, unknown>;
    };
    expect(payload.policy).toBe("paid");
    expect(payload.preview).toBe(FULL.slice(0, 20));
    expect(payload.preview.length).toBe(20);
    expect(payload.challenge).toEqual({
      profile: "MPP",
      method: "PaymentAuth",
      endpoint: "https://pay.example.com/mpp",
      price_per_access: 0.02,
      currency: "USD",
    });

    expect(result.wwwAuthenticate).toContain("Payment");
    expect(result.wwwAuthenticate).toContain("https://pay.example.com/mpp");
  });

  it("treats metered like paid (preview + 402)", () => {
    const result = gateContent(
      manifest({
        policy: "metered",
        preview_chars: 5,
        price_per_access: 0.01,
        currency: "USD",
        payment: { profile: "MPP", method: "PaymentAuth", endpoint: "https://pay.example.com/mpp" },
      }),
      FULL,
    );
    expect(result.status).toBe(402);
    expect(result.eventType).toBe("payment_required");
  });
});
