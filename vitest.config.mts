import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    include: [
      "src/**/*.test.ts",
      "src/**/*.property.test.ts",
      "test/**/*.test.ts",
      "test/**/*.property.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        // Vendored devcontainers CLI: loaded in-process by readResolvedConfig
        // tests, but not our code to test. Excluded so the overall number
        // reflects artizo src only.
        "vendor/**",
        "src/**/*.test.ts",
        "src/**/*.property.test.ts",
        "src/cli/devcontainerCli.ts",
        "src/cli/commandBuilder.ts",
        "src/cli/wslWrapper.ts",
        "src/cli/provisionOptionsBuilder.ts",
        "src/cli/devcontainerEngine.ts",
        "src/cli/devcontainerEngine.d.ts",
        "src/views/**",
      ],
    },
  },
});
