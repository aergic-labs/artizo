You are creating or updating `.devcontainer/devcontainer.json` for THIS project.
Work conversationally: investigate, ask, then write.

## 1. Existing config

If `.devcontainer/devcontainer.json` already exists, MODIFY it  -  preserve what
works, fix what's broken, fill gaps. Don't replace it wholesale unless it's
clearly wrong. If it doesn't exist, create it.

## 2. Investigate (don't write yet)

Infer the dev environment from the repo:

- Language/runtime manifests and lockfiles (package.json, pyproject.toml,
  go.mod, Cargo.toml, Gemfile, composer.json, etc.) and version pins
  (.nvmrc, .tool-versions, .python-version, …).
- Build/test/lint tooling actually used (package managers, build systems,
  formatters, test runners).
- Services implied by the code/config (databases, caches, queues) and ports.
- Native build needs (node-gyp, C extensions)  -  these rule out Alpine.
- **The Makefile (or Justfile/taskfile) is authoritative when present**  -  mine
  its install/build/test targets, system packages, env vars, and tool versions.
  Treat it as the source of truth when it conflicts with other files.

## 3. Principles

- Configure the **dev loop only**  -  what's needed to install deps, run, test,
  and lint. NOT production/CI-only concerns (nginx, gunicorn, terraform, CI
  agents). Treat `.github/workflows` / `.gitlab-ci.yml` and a production
  `Dockerfile` as *hints*, not requirements.
- Prefer devcontainer **features** over raw `apt-get`. Prefer slim/official
  images. Only add VS Code extensions the project actually uses (full id, e.g.
  `ms-python.python`).

## 4. Question protocol  -  follow exactly

1. Finish investigating silently. Do not write the file yet.
2. Decide what you genuinely need clarified. If nothing, say so and proceed.
3. Announce the count and offer an escape hatch, e.g.:
   "I'd like to ask {N} quick questions to get this right  -  okay to go through
   them, or should I just take my best guess?"
4. If they choose best-guess: proceed with sensible defaults and state your
   assumptions.
5. Otherwise ask **one question at a time**, each prefixed
   "Question {i} of {N}: …". Wait for the answer before the next.
6. Make the **final** question open-ended:
   "Question {N} of {N}: Anything else I should know  -  other tools, services,
   constraints, or preferences?"
7. Only after the last answer, write the config.

Good questions are specific to what you found, e.g. "Found Python 3.11, 3.12,
and 3.13 referenced  -  which one?" / "node-gyp is present, so Alpine won't work  - 
Debian OK?" / "PostgreSQL and Redis both appear  -  include both as services?"

## 5. Output

Write `.devcontainer/devcontainer.json` (and a Dockerfile only if needed). Use
`image` / `build.dockerfile`, `features`, `forwardPorts`, `postCreateCommand`,
and `customizations.vscode.extensions`. The result must be valid against the
devcontainer schema:
https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainer.base.schema.json
(reference: https://containers.dev/implementors/json_reference/).

After writing, verify it parses as valid JSONC (no trailing commas / stray
braces / unquoted keys); fix any syntax errors immediately. Then briefly explain
what you generated and why.
