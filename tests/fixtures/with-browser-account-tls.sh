#!/usr/bin/env bash
# Give the disposable OpenShell supervisor and controlled MCP recipient a shared TLS root.
set -euo pipefail
umask 077

: "${OPENSHELL_DOCKER_SUPERVISOR_IMAGE:?Set the pinned stock OpenShell supervisor image}"
if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

fixture=$(mktemp -d)
image="oce-browser-account-tls:$(openssl rand -hex 12)"
container=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm "$container" >/dev/null 2>&1 || true; fi
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT

export OCC_TEST_BROWSER_ACCOUNT_TLS_DIR="$fixture/recipient"
export OCC_TEST_BROWSER_ACCOUNT_DNS="127.93.$((RANDOM % 254 + 1)).$((RANDOM % 254 + 1))"
mkdir "$OCC_TEST_BROWSER_ACCOUNT_TLS_DIR"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -subj '/CN=OCE browser account fixture CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign' \
  -keyout "$fixture/ca.key" -out "$fixture/ca.crt"
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -subj '/CN=mcp.slack.com' -keyout "$OCC_TEST_BROWSER_ACCOUNT_TLS_DIR/tls.key" -out "$fixture/recipient.csr"
openssl x509 -req -days 1 -in "$fixture/recipient.csr" -CA "$fixture/ca.crt" -CAkey "$fixture/ca.key" \
  -extfile <(printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature' \
    'extendedKeyUsage=serverAuth' 'subjectAltName=DNS:mcp.slack.com') \
  -out "$OCC_TEST_BROWSER_ACCOUNT_TLS_DIR/tls.crt"
rm "$fixture/ca.key"
openssl verify -purpose sslserver -verify_hostname mcp.slack.com -CAfile "$fixture/ca.crt" \
  "$OCC_TEST_BROWSER_ACCOUNT_TLS_DIR/tls.crt"

# Stock OpenShell is a scratch image. Preserve its CA bundle and executable.
bundle=/etc/ssl/certs/ca-certificates.crt
container=$(docker create --pull never "$OPENSHELL_DOCKER_SUPERVISOR_IMAGE")
docker cp "$container:$bundle" "$fixture/bundle.crt"
chmod u+w "$fixture/bundle.crt"
printf '\n' >> "$fixture/bundle.crt"
cat "$fixture/ca.crt" >> "$fixture/bundle.crt"
chmod 0644 "$fixture/bundle.crt"
docker cp "$fixture/bundle.crt" "$container:$bundle"
# The stock driver supplies an explicit entrypoint and mounts its Docker resolver read-only.
# Gate only the initial broker start on the resolver installed by the fixture for this container.
here=$(cd "$(dirname "$0")" && pwd)
arch=$(docker image inspect --format '{{.Architecture}}' "$OPENSHELL_DOCKER_SUPERVISOR_IMAGE")
CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags "-X main.resolver=$OCC_TEST_BROWSER_ACCOUNT_DNS" \
  -o "$fixture/wait-for-resolver" "$here/browser-account-supervisor.go"
docker cp "$container:/openshell-supervisor" "$fixture/stock-openshell-supervisor"
chmod 0755 "$fixture/wait-for-resolver" "$fixture/stock-openshell-supervisor"
docker cp "$fixture/stock-openshell-supervisor" "$container:/stock-openshell-supervisor"
docker cp "$fixture/wait-for-resolver" "$container:/openshell-supervisor"
docker commit "$container" "$image" >/dev/null
export OPENSHELL_DOCKER_SUPERVISOR_IMAGE="$image"
"$@"
