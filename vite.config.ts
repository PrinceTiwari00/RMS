import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Shared config for Vitest and vite-node so scratch scripts and tests resolve
 * the `@/` alias exactly the way Next.js does at runtime.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
