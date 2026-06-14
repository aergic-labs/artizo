A dev container build/provision just FAILED. Help me diagnose and fix it.

The failing build output (tail) and the relevant config are provided below /
attached. Work from the actual error — don't guess.

1. Read the build log tail below and identify the **root cause** of the failure
   (e.g. a missing system package, a failing `RUN`/feature install, a bad base
   image or tag, an apt/pip/npm error, a compose service that didn't come up).
   Point to the specific line(s) that show the failure. If the tail is
   truncated or doesn't show the cause, use a shell command to read the entire
   full log file referenced near the end of this message (detect the shell
   first if unsure — `echo $SHELL` — then use an appropriate read command),
   then scan from the bottom up to find the most recent build run and its failure — it is a
   rolling session log containing earlier unrelated runs, so ignore those.
2. Read `.devcontainer/devcontainer.json` (and the Dockerfile / compose file if
   referenced) to see what produced that step.
3. Propose the **smallest fix** that addresses the root cause. Prefer editing
   `.devcontainer/devcontainer.json` (or the Dockerfile it references). Keep the
   result valid against the devcontainer schema:
   https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainer.base.schema.json
4. If the cause is genuinely ambiguous, ask me ONE focused question before
   changing anything; otherwise apply the fix and briefly explain what was wrong
   and what you changed. Then suggest rebuilding the container.

Do not make unrelated changes or "improvements" — fix only what caused the
failure.
