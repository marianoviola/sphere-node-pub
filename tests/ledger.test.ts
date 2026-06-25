import { describe, it, expect } from "vitest";
import { makeEvent, uaFamily, refSource } from "../src/core/ledger.ts";

describe("ledger privacy reduction", () => {
  it("buckets user-agents into coarse families and never returns the raw string", () => {
    const chromeUA =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(uaFamily(chromeUA)).toBe("browser");
    expect(uaFamily("GPTBot/1.1 (+https://openai.com/gptbot)")).toBe("agent");
    expect(uaFamily("ClaudeBot/1.0")).toBe("agent");
    expect(uaFamily("curl/8.4.0")).toBe("cli");
    expect(uaFamily("SomeRandomCrawler/2.0 bot")).toBe("bot");
    expect(uaFamily(null)).toBe("none");

    // The bucket must not echo the original UA back.
    expect(uaFamily(chromeUA)).not.toContain("Macintosh");
    expect(uaFamily(chromeUA).length).toBeLessThan(20);
  });

  it("reduces a referrer to its origin, dropping path and query", () => {
    expect(refSource("https://news.example.com/article/123?utm=abc&uid=secret")).toBe(
      "https://news.example.com",
    );
    expect(refSource(null)).toBe("direct");
    expect(refSource("not a url")).toBe("direct");
  });

  it("makeEvent stores exactly the five lean columns and no PII", () => {
    const event = makeEvent({
      ts: 1700000000000,
      fragmentId: "2026-01-15-sample-fragment",
      eventType: "manifest",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Chrome/120",
      referer: "https://ref.example.com/path?token=leak",
    });

    expect(Object.keys(event).sort()).toEqual(
      ["eventType", "fragmentId", "refSource", "ts", "uaFamily"].sort(),
    );

    // No IP, no full UA, no path/query, no token anywhere in the serialized row.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("iPhone");
    expect(serialized).not.toContain("AppleWebKit");
    expect(serialized).not.toContain("token=leak");
    expect(serialized).not.toContain("/path");
    expect(event.uaFamily).toBe("browser");
    expect(event.refSource).toBe("https://ref.example.com");
  });
});
