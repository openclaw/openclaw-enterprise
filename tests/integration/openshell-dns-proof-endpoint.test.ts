import assert from "node:assert/strict";
import test from "node:test";
import { modelEndpointSupportsDnsProofs } from "../helpers/openshell-dns-proof-endpoint.ts";

for (const port of ["", ":8443"]) {
  test(`DNS hostname enables DNS proofs with port ${port || "default"}`, () => {
    assert.equal(modelEndpointSupportsDnsProofs(new URL(`https://model.example${port}/v1`)), true);
  });

  test(`IPv4 disables DNS proofs with port ${port || "default"}`, () => {
    assert.equal(modelEndpointSupportsDnsProofs(new URL(`https://192.0.2.1${port}/v1`)), false);
  });

  test(`IPv6 disables DNS proofs with port ${port || "default"}`, () => {
    // URL.hostname retains IPv6 brackets; an address cannot be redirected through DNS.
    assert.equal(modelEndpointSupportsDnsProofs(new URL(`https://[2001:db8::1]${port}/v1`)), false);
  });
}
