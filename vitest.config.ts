import { defineConfig } from "vitest/config";

// Plain Node environment. The worker router (handleRequest) and core modules
// depend only on web-standard APIs (Request, Response, Headers) plus injected
// ports, so tests run without a Cloudflare/miniflare pool. The Cloudflare
// runtime is exercised by the owner via `wrangler dev`, not by unit tests.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
