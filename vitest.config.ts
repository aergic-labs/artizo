import { defineConfig } from "vitest/config";

// Test defaults: Kiro feature set
const testFlags = {
  HAS_SECCOMP_UNCONFINED: JSON.stringify(false),
  HAS_HOME_SYMLINK: JSON.stringify(false),
  HAS_ARGV_PATCH: JSON.stringify(true),
  HAS_KIRO_ADAPTER: JSON.stringify(true),
  HAS_TRAE_ADAPTER: JSON.stringify(false),
  HAS_DEVIN_ADAPTER: JSON.stringify(false),
  HAS_VSCODIUM_ADAPTER: JSON.stringify(false),
  ARTIZO_SPIKE: JSON.stringify(false),
};

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
  define: {
    __TARGET__: JSON.stringify(process.env.TARGET || "kiro"),
    ...testFlags,
  },
});
