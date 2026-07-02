#!/tmp/.artizo/bin/sh
# Copyright (c) 2026 Aergic Labs, LLC
# SPDX-License-Identifier: AGPL-3.0-only

export PATH=/tmp/.artizo/bin:$PATH
set -e

SERVER_ROOT="${ARTIZO_SERVER_ROOT}"

# 1. Read auth token from stdin (first line, base64) before the tarball.
#    Streamed on stdin rather than argv so the SSO token never appears on the
#    host `docker` process command line. `read` stops at the newline, leaving
#    the tarball bytes on stdin for the gzip pipe below.
if [ -n "${ARTIZO_AUTH_TOKEN_STDIN}" ]; then
  IFS= read -r ARTIZO_AUTH_TOKEN_B64
fi

# 2. Extract server tarball (piped via stdin)
mkdir -p "${SERVER_ROOT}/bin"
gzip -d | tar -xC "${SERVER_ROOT}" --strip-components=1

# 3. Relay deployed as file during bootstrap, verify it exists
test -f /tmp/.artizo/bin/relay.js

# 4. Detect HOME
HOME_DIR=$(printenv HOME 2>/dev/null || echo "/root")
echo "HOME=$HOME_DIR"

# 5. Create connection token
TOKEN=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM)
echo "$TOKEN" > "${SERVER_ROOT}/connection-token"
chmod 600 "${SERVER_ROOT}/connection-token"

# 6. Write auth token if provided via stdin
if [ -n "${ARTIZO_AUTH_TOKEN_B64}" ] && [ -n "${ARTIZO_AUTH_TOKEN_PATH}" ]; then
  mkdir -p "${HOME_DIR}/$(dirname "${ARTIZO_AUTH_TOKEN_PATH}")"
  printf '%s' "${ARTIZO_AUTH_TOKEN_B64}" | base64 -d > "${HOME_DIR}/${ARTIZO_AUTH_TOKEN_PATH}"
  chmod 600 "${HOME_DIR}/${ARTIZO_AUTH_TOKEN_PATH}"
fi

echo "SETUP_DONE"