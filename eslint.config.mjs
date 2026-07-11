import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  module: "readonly",
  console: "readonly",
  process: "readonly",
  require: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  global: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
};

export default tseslint.config(
  {
    ignores: ["vendor/**", "dist/**", "coverage/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/webview/**"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        acquireVsCodeApi: "readonly",
      },
    },
    // Browser-side webview code; not part of the extension bundle's strictness.
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Non-shipping code (build scripts, tools, test helpers, test project) keeps
  // the relaxed rules: these run in Node, use require() freely, and aren't part
  // of the extension bundle.
  {
    files: [
      "scripts/**",
      "tools/**",
      "stubs/**",
      "test-project/**",
      "test/**/*.ts",
      "esbuild.config.mjs",
    ],
    languageOptions: { globals: nodeGlobals },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
  // Shipping source: keep the recommended strictness. `any` is surfaced as a
  // warning (a real strictness signal without blocking the build); unused vars
  // stay an error (underscore-prefixed names are intentional discards).
  // `require()` is an error here too - the few intentional lazy loads carry a
  // scoped eslint-disable with a rationale.
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Proposed VS Code APIs (registerRemoteAuthorityResolver,
  // RemoteAuthorityResolverError, ResolvedAuthority, remoteAuthority) are
  // not in @types/vscode. These files cast to `any` to access them.
  {
    files: [
      "src/remote/authorityResolver.ts",
      "src/remote/sideload.ts",
      "src/host/state.ts",
      "src/host/services.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Vendored CLI wrapper: the devcontainers-cli module has no type
  // declarations, so its launch()/wrapper functions are inherently `any`.
  {
    files: ["src/devcontainer/api.ts", "src/host/commands.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
