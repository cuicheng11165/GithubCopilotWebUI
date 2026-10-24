import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Package "import" exports point at dist/, which does not exist until build.
      "@app/security": fileURLToPath(new URL("./packages/security/src/index.ts", import.meta.url)),
      "@app/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "json", "html"] }
  }
});
