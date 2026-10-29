// Function-level end-to-end tests: real Convex functions against an
// in-memory backend (convex-test). Unit tests stay on `bun test src/tests/`.
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "edge-runtime",
    include: ["src/e2e/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    testTimeout: 30_000,
  },
});
