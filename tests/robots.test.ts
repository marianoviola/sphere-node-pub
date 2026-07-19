import { describe, it, expect } from "vitest";
import { renderRobotsTxt } from "../src/core/robots.ts";

const ORIGIN = "https://node.example";

describe("renderRobotsTxt", () => {
  it("allows everything, points at the sitemap, and defaults ai-train to no", () => {
    const txt = renderRobotsTxt({ allowAiTraining: false }, ORIGIN);
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(txt).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=no");
  });

  it("flips ai-train to yes when configured, leaving search/ai-input untouched", () => {
    const txt = renderRobotsTxt({ allowAiTraining: true }, ORIGIN);
    expect(txt).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
  });

  it("does not double the origin when it carries a trailing slash", () => {
    const txt = renderRobotsTxt({ allowAiTraining: false }, `${ORIGIN}/`);
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(txt).not.toContain("//sitemap.xml");
  });
});
