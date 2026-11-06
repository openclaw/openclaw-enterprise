#!/usr/bin/env bash
# Add the worker stream entry point to a private checkout of the published native sender.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo "Usage: $0 <OpenShell git checkout> <output test binary>" >&2
  exit 2
fi
source_repo=$(realpath "$1")
output=$(realpath -m "$2")
fixture=$(realpath "$(dirname "$0")/../../tests/fixtures/browser-account-relay.rs")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
git -C "$source_repo" archive 0b094797c38883ce68424cdcc2b109ff1ac5ab62 | tar -x -C "$scratch"
cd "$scratch"
module=crates/openshell-supervisor-network/src/l7/relay
cp "$fixture" "$module/browser_account_relay.rs"
printf '\ninclude!("browser_account_relay.rs");\n' >> "$module/request_credential_tests.rs"
cargo test --locked -p openshell-supervisor-network --lib --no-run --message-format=json > build.jsonl
artifact=$(node --input-type=module -e '
import {readFileSync} from "node:fs";
const rows=readFileSync("build.jsonl","utf8").trim().split("\n").map(JSON.parse);
const binary=rows.find(row=>row.reason==="compiler-artifact" && row.target.name==="openshell_supervisor_network" && row.profile.test && row.executable);
if(!binary) throw new Error("Missing native credential relay test binary");
console.log(binary.executable);
')
install -m 0755 "$artifact" "$output"
