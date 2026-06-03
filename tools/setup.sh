#!/tmp/.artizo/bin/sh
# Copyright (c) 2026 Aergic Labs, LLC
# SPDX-License-Identifier: AGPL-3.0-only

export PATH=/tmp/.artizo/bin:$PATH
set -e

SERVER_ROOT="${ARTIZO_SERVER_ROOT}"

# 1. Extract server tarball (piped via stdin)
mkdir -p "${SERVER_ROOT}/bin"
gzip -d | tar -xC "${SERVER_ROOT}" --strip-components=1

# 2. Relay deployed as file during bootstrap, verify it exists
test -f /tmp/.artizo/bin/relay.js

# 3. Detect HOME
HOME_DIR=$(printenv HOME 2>/dev/null || echo "/root")
echo "HOME=$HOME_DIR"

# 4. Create connection token
TOKEN=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM)
echo "$TOKEN" > "${SERVER_ROOT}/connection-token"
chmod 600 "${SERVER_ROOT}/connection-token"

# 5. Copy auth token if provided via env
if [ -n "${ARTIZO_AUTH_TOKEN}" ] && [ -n "${ARTIZO_AUTH_TOKEN_PATH}" ]; then
  mkdir -p "${HOME_DIR}/$(dirname "${ARTIZO_AUTH_TOKEN_PATH}")"
  echo "${ARTIZO_AUTH_TOKEN}" > "${HOME_DIR}/${ARTIZO_AUTH_TOKEN_PATH}"
  chmod 600 "${HOME_DIR}/${ARTIZO_AUTH_TOKEN_PATH}"
fi

echo "SETUP_DONE"