import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { test } from "node:test";
import {
  legacyBrowserHandshake,
  legacyPairingMetadata,
} from "../helpers/native-profile-legacy-grant.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

function observations() {
  // Public wire shapes from native b589 device.pair.list and Control UI connect.
  // These parser cases do not prove real pairing, authentication, or an upgrade.
  const publicKey = Buffer.alloc(32, 1).toString("base64url");
  const binding = {
    deviceId: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
    publicKey,
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
  };
  const scopes = ["operator.admin", "operator.read", "operator.write"];
  const outgoing = {
    type: "req",
    id: randomUUID(),
    method: "connect",
    params: {
      client: {
        id: binding.clientId,
        mode: binding.clientMode,
        platform: "web",
        version: "2026.11.4",
      },
      role: "operator",
      scopes,
      device: {
        id: binding.deviceId,
        publicKey: binding.publicKey,
        signature: "public-signature",
        nonce: "challenge",
        signedAt: 1,
      },
    },
  };
  const incoming = {
    type: "res",
    id: outgoing.id,
    ok: true,
    payload: { type: "hello-ok", auth: { method: "trusted-proxy", role: "operator", scopes } },
  };
  const paired = {
    ...binding,
    role: "operator",
    roles: ["operator"],
    scopes,
    approvedVia: "trusted-proxy",
    createdAtMs: 1000,
    approvedAtMs: 1001,
    tokens: [{ role: "operator", scopes, createdAtMs: 1001 }],
  };
  return { binding, outgoing, incoming, paired };
}

export function registerLegacyBrowserPairingCases() {
  test("legacy pairing binds a matched successful Control UI hello without a delivered token", () => {
    const { binding, outgoing, incoming } = observations();
    assert.deepEqual(
      legacyBrowserHandshake(outgoing, incoming, "https://owned.example.test"),
      binding,
    );
    assert.throws(
      () =>
        legacyBrowserHandshake(
          outgoing,
          { ...incoming, id: "other-request" },
          "https://owned.example.test",
        ),
      /Legacy browser pairing/,
    );
    assert.throws(
      () =>
        legacyBrowserHandshake(outgoing, { ...incoming, ok: false }, "https://owned.example.test"),
      /Legacy browser pairing/,
    );
    assert.throws(
      () =>
        legacyBrowserHandshake(
          outgoing,
          {
            ...incoming,
            payload: {
              ...incoming.payload,
              auth: { ...incoming.payload.auth, deviceToken: "unexpected" },
            },
          },
          "https://owned.example.test",
        ),
      /Legacy browser pairing/,
    );
    assert.throws(
      () =>
        legacyBrowserHandshake(
          { ...outgoing, params: { ...outgoing.params, role: "node" } },
          incoming,
          "https://owned.example.test",
        ),
      /Legacy browser pairing/,
    );
  });

  test("legacy pairing projects only its owned redacted approval metadata", () => {
    const { binding, paired } = observations();
    const list = { pending: [], paired: [{ ...paired, deviceId: "sibling" }, paired] };
    const expected = {
      ...binding,
      approvedVia: "trusted-proxy",
      createdAtMs: 1000,
      approvedAtMs: 1001,
      operatorTokenCreatedAtMs: 1001,
    };
    assert.deepEqual(legacyPairingMetadata(binding, list), expected);
    // Live/lifecycle metadata may change without replacing the original pairing.
    assert.deepEqual(
      legacyPairingMetadata(binding, {
        pending: [],
        paired: [
          {
            ...paired,
            connected: false,
            lastSeenAtMs: 2000,
            tokens: [{ ...paired.tokens[0], lastUsedAtMs: 2000 }],
          },
        ],
      }),
      expected,
    );
  });

  const refusals: Array<[string, Record<string, unknown>]> = [
    ["another public key", { publicKey: "other-key" }],
    ["another client", { clientId: "node-host" }],
    ["another client mode", { clientMode: "node" }],
    ["another approval owner", { approvedVia: "owner" }],
    ["a node-only role", { role: "node", roles: ["node"] }],
    ["missing approval time", { approvedAtMs: undefined }],
    [
      "a persisted token map instead of public summaries",
      { tokens: { operator: { role: "operator" } } },
    ],
    [
      "missing operator authority",
      { tokens: [{ role: "operator", scopes: ["operator.read"], createdAtMs: 1001 }] },
    ],
    [
      "a revoked operator summary",
      {
        tokens: [
          { role: "operator", scopes: ["operator.admin"], createdAtMs: 1001, revokedAtMs: 2000 },
        ],
      },
    ],
  ];
  for (const [label, fields] of refusals) {
    test("legacy pairing refuses " + label, () => {
      const { binding, paired } = observations();
      assert.throws(
        () => legacyPairingMetadata(binding, { pending: [], paired: [{ ...paired, ...fields }] }),
        /Legacy browser pairing/,
      );
    });
  }

  test("legacy pairing refuses absent or ambiguous owned records", () => {
    const { binding, paired } = observations();
    for (const entries of [[], [{ ...paired, deviceId: "sibling" }], [paired, paired]]) {
      assert.throws(
        () => legacyPairingMetadata(binding, { pending: [], paired: entries }),
        /Legacy browser pairing/,
      );
    }
  });

  test("legacy pairing rejects private material without exposing response data or causes", () => {
    const { binding, paired } = observations();
    const withheld = syntheticCredentialUrl({
      protocol: "https",
      username: "synthetic",
      password: randomUUID(),
      host: "example.test",
    });
    for (const fields of [
      { privateKey: withheld },
      { approvedScopes: ["operator.admin"] },
      { tokens_json: withheld },
      { tokens: [{ ...paired.tokens[0], token: withheld }] },
    ]) {
      assert.throws(
        () => legacyPairingMetadata(binding, { pending: [], paired: [{ ...paired, ...fields }] }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "Legacy browser pairing metadata observation failed.");
          assert.equal(error.cause, undefined);
          assert.equal(inspect(error).includes(withheld), false);
          return true;
        },
      );
    }
  });
}
