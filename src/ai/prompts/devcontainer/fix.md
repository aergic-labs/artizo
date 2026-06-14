Fix ONLY syntax errors in `.devcontainer/devcontainer.json` so it parses as
valid JSONC. Do NOT change configuration values, add/remove features, rename
properties, or make any semantic change — only what's required to make it parse.

1. Read `.devcontainer/devcontainer.json` as JSONC.
2. Identify ONLY syntax errors: trailing/missing commas, extra/missing braces or
   brackets, unquoted keys, wrong quote characters, unterminated strings.
3. Fix ONLY those. Change nothing else.
4. Write the repaired file back to `.devcontainer/devcontainer.json`.
5. Verify it parses as valid JSONC. If not, repeat until it does.
6. Report what was fixed (line numbers + specific corrections).

If the structure is ambiguous (e.g. where a missing brace belongs), you may
consult the devcontainer schema to decide the correct nesting —
https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainer.base.schema.json
— but still fix ONLY syntax. Do not "correct" anything to match the schema; a
key the schema doesn't recognize is not a syntax error and must be left as-is.
