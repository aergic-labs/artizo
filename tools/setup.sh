#!/tmp/.artizo/bin/sh
# Copyright (c) 2026 Aergic Labs, LLC
# SPDX-License-Identifier: AGPL-3.0-only

export PATH=/tmp/.artizo/bin:$PATH
set -e

SERVER_ROOT="${ARTIZO_SERVER_ROOT}"

# 1. Detect HOME (needed before auth file writes in step 2)
HOME_DIR=$(printenv HOME 2>/dev/null || echo "/root")

# 2. Read auth files from stdin (path/b64 pairs, blank line terminator)
#    before the server tarball. Streamed on stdin rather than argv so
#    file contents never appear on the host `docker` process command
#    line. Each pair is a relative-path line followed by a base64 line.
#
#    Writes are atomic (temp file in the same dir, then mv -f) and
#    non-fatal: if the write fails (read-only bind-mount of ~/.aws,
#    no perms) we continue so the server tarball still extracts. We
#    always attempt the write even if the dest exists, so reused
#    containers don't keep a stale token.
if [ -n "${ARTIZO_AUTH_FILES_STDIN}" ]; then
  while IFS= read -r AUTH_PATH; do
    [ -z "${AUTH_PATH}" ] && break
    IFS= read -r AUTH_B64
    DEST="${HOME_DIR}/${AUTH_PATH}"
    DIR=$(dirname "${DEST}")
    mkdir -p "${DIR}" 2>/dev/null || true
    TMP="${DIR}/.auth.$$"
    if printf '%s' "${AUTH_B64}" | base64 -d > "${TMP}" 2>/dev/null; then
      chmod 600 "${TMP}" 2>/dev/null || true
      # rename(2) on the same fs is atomic; on a ro mount this fails
      # (the mounted file is what the server uses) and we clean up.
      mv -f "${TMP}" "${DEST}" 2>/dev/null || rm -f "${TMP}" 2>/dev/null
    fi
  done
fi

# 3. Extract server tarball (piped via stdin)
mkdir -p "${SERVER_ROOT}/bin"
gzip -d | tar -xC "${SERVER_ROOT}" --strip-components=1

# 4. Relay deployed as file during bootstrap, verify it exists
test -f /tmp/.artizo/bin/relay.js

# 5. Report HOME (parsed by parseHome in bootstrap.ts)
echo "HOME=$HOME_DIR"

# 6. Create connection token
TOKEN=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM)
echo "$TOKEN" > "${SERVER_ROOT}/connection-token"
chmod 600 "${SERVER_ROOT}/connection-token"

echo "SETUP_DONE"