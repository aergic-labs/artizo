# Artizo Agent Instructions ## Critical: Stop means stop

When the user says "stop", "STOP", "wait", "hold on", or any similar
interruption; stop immediately. Do not finish your thought. Do not run one
more tool. Do not add a closing sentence. End your turn right then.

## Critical: Never revert or discard working-tree changes

Never run `git checkout`, `git reset`, `git restore`, `git clean`, or any
other command (rm, etc) that reverts, discards, or overwrites working-tree changes
without explicit permission. This includes `git checkout -- <file>` and
`git checkout HEAD -- <file>`. If a file is broken, explain the situation
and ask before reverting.

## Command quick reference

| Task | Command | Notes |
|------|---------|-------|
| Type-check | `npm run typecheck` | TypeScript only, ~3s |
| Lint (full) | `npm run lint` | Types + dead-code (knip), ~3s |
| Unit + property tests | `npm test` | No Docker, no coverage, ~5s |
| Coverage report | `npm run test:coverage` | Same tests, with coverage, ~10s |
| Integration tests | `npm run test:integration` | Needs Docker, ~20s |
| All tests | `npm run test:all` | Unit + property + integration |
| Build bundle | `npm run build` | esbuild dist/`, no VSIX |
| Build single VSIX | `npm run package:kiro` | Full build + package for one platform |
| Full quality gate | `make check` | Lint + all tests |

## Pipeline (what to run, and when)

```
After any code change:
  1. npm run lint          - TypeScript errors + dead code
  2. npm test              - Unit + property tests (fast)

Before considering work done:
  3. npm run test:coverage - Check coverage didn't regress
  4. npm run lint          - One more time, clean exit

Before committing (or when asked to validate fully):
  5. make check            - Lint + all tests (includes Docker integration)
```

## Rules

### Coverage: use the script, not raw vitest
The project has `scripts/parse-coverage.mjs` which parses `coverage/lcov.info` into a sorted per-file report. After running `npm run test:coverage`, use `node scripts/parse-coverage.mjs` to see the results. Do not run `npx vitest run --coverage` directly, use the npm script.

### Lint includes dead-code detection
`npm run lint` runs both `tsc --noEmit` and `knip`. If knip reports issues, triage them, vendor/stubs/tools/test-project are already excluded by `.knip.json`. Real findings are usually dead exports or unused files.

### TypeScript is strict
`tsconfig.json` has `noUnusedLocals` and `noUnusedParameters` enabled. Any unused variable or parameter is a compile error. Remove dead code rather than suppressing.

### Tests are in `test/`, not `src/`
All test files live under `test/unit/`, `test/property/`, or `test/integration/`. The vitest config includes both `src/**/*.test.ts` and `test/**/*.test.ts` patterns, but new tests should go in `test/`.

### Mocks are in `test/__mocks__/vscode.ts`
The VS Code API mock is used by all unit tests. It covers `vscode.window`, `vscode.workspace`, `vscode.commands`, `vscode.Uri`, and common enums. If a test needs a new VS Code API surface, add it to the mock.

### Property tests use fast-check
Property-based tests live in `test/property/` and use `fast-check`. They test invariants (e.g., URI round-trips, config preservation), not specific input/output pairs.

### Docker integration tests are gated
Integration tests in `test/integration/` require Docker. They're excluded from `npm test` and `npm run test:coverage`. Run them explicitly with `npm run test:integration` or as part of `make check`.
