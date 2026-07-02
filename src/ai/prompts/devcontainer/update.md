The user has an existing `.devcontainer/devcontainer.json`. Review it and
suggest improvements. DO NOT replace the file immediately.

## 0. Syntax gate

Parse `.devcontainer/devcontainer.json` as JSONC. If there are parse errors
(trailing commas, stray braces, missing quotes), STOP  -  do not summarize or ask
anything else. Report only the error and ask: "Should I fix this syntax error?"
If yes, fix ONLY the error, then continue to step 1.

## 1. Summarize the current config

Tell the user what it does today: base image (and Alpine vs Debian tradeoffs),
features, `postCreateCommand`, forwarded ports, extensions, mounts/runArgs, and
anything a typical project of this type would have but this one is missing.

## 2. Question protocol  -  follow exactly

Base questions on what you actually observe; don't ask "what do you want to
add?".

1. Decide what's worth clarifying. If nothing, say so and stop.
2. Announce the count and offer an escape hatch, e.g.:
   "I have {N} suggestions to ask about  -  want me to go through them one by one,
   or should I just apply my best recommendations?"
3. If best-guess: apply sensible improvements and state what you changed.
4. Otherwise ask **one at a time**, prefixed "Question {i} of {N}: …", waiting
   for each answer.
5. Make the **final** question open-ended:
   "Question {N} of {N}: Anything else you'd like changed or added?"

Good questions are specific, e.g. "Makefile has a `test` target but no test
runner is configured  -  add one?" / "Config uses Alpine but package.json has
node-gyp  -  switch to Debian?" / "`.python-version` is 3.12 but the image
defaults to 3.11  -  pin it?"

## 3. Apply

After the answers, apply the agreed changes  -  preserve everything the user
didn't ask to change. Keep the result valid against the devcontainer schema
(https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainer.base.schema.json)
and verify it parses as valid JSONC; fix any syntax errors immediately. Then
explain what changed and why.
