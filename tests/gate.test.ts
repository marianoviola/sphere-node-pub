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

  it("keeps the original generic challenge shape for a profile that isn't x402 or mpp", () => {
    const result = gateContent(
      manifest({
        policy: "paid",
        preview_chars: 20,
        price_per_access: 0.02,
        currency: "USD",
        payment: { profile: "custom-provider", method: "PaymentAuth", endpoint: "https://pay.example.com/custom" },
      }),
      FULL,
    );
    expect(result.status).toBe(402);
    expect(result.contentType).toContain("application/json");
    const payload = JSON.parse(result.body) as { challenge: Record<string, unknown> };
    expect(payload.challenge).toEqual({
      profile: "custom-provider",
      method: "PaymentAuth",
      endpoint: "https://pay.example.com/custom",
      price_per_access: 0.02,
      currency: "USD",
    });
    expect(result.wwwAuthenticate).toBe(
      'Payment profile="custom-provider", endpoint="https://pay.example.com/custom", price="0.02", currency="USD"',
    );
  });

  it("shapes a real 'Payment' HTTP auth-scheme challenge for profile mpp (case-insensitive)", () => {
    const result = gateContent(
      manifest({
        policy: "paid",
        preview_chars: 20,
        price_per_access: 0.02,
        currency: "USD",
        payment: { profile: "mpp", method: "PaymentAuth", endpoint: "https://pay.example.com/mpp" },
      }),
      FULL,
    );
    expect(result.status).toBe(402);
    // Body is untouched — MPP is a header-level scheme.
    const payload = JSON.parse(result.body) as { policy: string; preview: string };
    expect(payload.policy).toBe("paid");
    expect(payload.preview).toBe(FULL.slice(0, 20));

    const header = result.wwwAuthenticate ?? "";
    expect(header).toMatch(/^Payment /);
    expect(header).toContain('realm="https://pay.example.com/mpp"');
    expect(header).toContain('method="PaymentAuth"');
    expect(header).toContain('intent="charge"');
    const requestMatch = header.match(/request="([^"]+)"/);
    expect(requestMatch).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(requestMatch![1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { amount: number; currency: string };
    expect(decoded).toEqual({ amount: 0.02, currency: "USD" });
  });

  it("replaces the body with the real x402 PaymentRequired envelope for profile x402", () => {
    const result = gateContent(
      manifest({
        policy: "paid",
        preview_chars: 20,
        price_per_access: 0.02,
        currency: "USD",
        payment: {
          profile: "x402",
          method: "PaymentAuth",
          endpoint: "https://pay.example.com/x402",
          network: "eip155:8453",
          asset: "USDC",
          pay_to: "0xabc123",
        },
      }),
      FULL,
      "https://node.example/fragments/2026-01-15-x/content.md",
    );

    expect(result.status).toBe(402);
    expect(result.contentType).toContain("application/json");
    expect(result.wwwAuthenticate).toBeUndefined();

    const envelope = JSON.parse(result.body) as {
      x402Version: number;
      resource: { url: string; description: string; mimeType: string };
      accepts: Array<Record<string, unknown>>;
      extensions: { sphere: { policy: string; preview: string } };
    };
    expect(envelope.x402Version).toBe(1);
    expect(envelope.resource).toEqual({
      url: "https://node.example/fragments/2026-01-15-x/content.md",
      description: "X",
      mimeType: "text/markdown",
    });
    expect(envelope.accepts).toEqual([
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "0.02",
        asset: "USDC",
        payTo: "0xabc123",
        maxTimeoutSeconds: 60,
        extra: { currency: "USD" },
      },
    ]);
    // Sphere's own preview rides in x402's designated extension point.
    expect(envelope.extensions.sphere).toEqual({ policy: "paid", preview: FULL.slice(0, 20) });
  });
});
