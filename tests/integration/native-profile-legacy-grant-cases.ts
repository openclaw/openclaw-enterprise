import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import {
  LegacyBrowserGrant,
  legacyBrowserHandshake,
  legacyGrantChecks,
  legacyGatewayClientConstructor,
  legacySdkHostDeps,
  legacyDeviceAuthResult,
  withLegacyGrantForward,
} from "../helpers/native-profile-legacy-grant.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { withEnvironment } from "../helpers/environment.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

function observations() {
  // These generated keys/tokens validate fixture custody, not native pairing or
  // authentication. Actual integration reads the existing browser/server grant.
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "jwk" }).x;
  const privateKey = pair.privateKey.export({ format: "jwk" }).d;
  assert.ok(publicKey && privateKey);
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const binding = {
    deviceId,
    publicKey,
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
    platform: "Linux x86_64",
    clientVersion: "2026.11.4",
    origin: "https://owned-native.example.test",
    scopes: ["operator.admin", "operator.read", "operator.write"],
  };
  const identity = { version: 1, deviceId, publicKey, privateKey, createdAtMs: Date.now() };
  const operator = {
    token: randomUUID() + randomUUID(),
    role: "operator",
    scopes: binding.scopes,
    createdAtMs: Date.now(),
  };
  const row = {
    device_id: deviceId,
    public_key: publicKey,
    client_id: binding.clientId,
    client_mode: binding.clientMode,
    browser_origin: null,
    role: "operator",
    roles_json: JSON.stringify(["operator"]),
    approved_scopes_json: JSON.stringify(["operator.admin"]),
    tokens_json: JSON.stringify({ operator }),
    approved_via: "trusted-proxy",
  };
  const outgoing = {
    type: "req",
    id: randomUUID(),
    method: "connect",
    params: {
      client: {
        id: binding.clientId,
        mode: binding.clientMode,
        platform: binding.platform,
        version: binding.clientVersion,
      },
      role: "operator",
      scopes: binding.scopes,
      device: {
        id: deviceId,
        publicKey,
        signature: "recorded-signature-shape",
        signedAt: Date.now(),
        nonce: randomUUID(),
      },
    },
  };
  const incoming = {
    type: "res",
    id: outgoing.id,
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { method: "trusted-proxy", role: "operator", scopes: binding.scopes },
    },
  };
  return { binding, identity, operator, row, outgoing, incoming };
}

export function registerLegacyBrowserGrantCases() {
  test("legacy positive witness loads the installed controller-owned public SDK without connecting", async () => {
    // This executes module import/its dependency graph only, not an auth probe.
    assert.equal(typeof (await legacyGatewayClientConstructor()), "function");
  });

  test("legacy SDK callbacks keep auth storage inert and sign with the supplied real key", () => {
    const callbacks = legacySdkHostDeps();
    const pair = generateKeyPairSync("ed25519");
    const payload = "owned-key-callback-contract-" + randomUUID();
    const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const signature = callbacks.signDevicePayload(pem, payload);
    assert.equal(
      verify(null, Buffer.from(payload), pair.publicKey, Buffer.from(signature, "base64url")),
      true,
    );
    assert.equal(
      callbacks.publicKeyRawBase64UrlFromPem(publicPem) ===
        pair.publicKey.export({ format: "jwk" }).x,
      true,
    );
    callbacks.storeDeviceAuthToken({
      deviceId: randomUUID(),
      role: "operator",
      token: randomUUID(),
      scopes: ["operator.admin"],
    });
    assert.equal(callbacks.loadDeviceAuthToken({ role: "operator" }), null);
    callbacks.clearDeviceAuthToken({ role: "operator" });
    assert.equal(callbacks.loadDeviceAuthToken(), null);
    assert.equal(callbacks.loadOrCreateDeviceIdentity(), undefined);
    assert.throws(() => callbacks.signDevicePayload("not-a-key", payload), /key-grant-binding/);
  });

  test("legacy device-auth result projection does not confuse proxy auth or an unfinished RPC with proof", () => {
    const hello = {
      auth: {
        method: "device-token",
        role: "operator",
        scopes: ["operator.admin"],
        deviceToken: randomUUID(),
      },
    };
    assert.deepEqual(legacyDeviceAuthResult(hello, true), {
      connected: true,
      tokenMismatch: false,
      deviceAuth: true,
      operator: true,
      admin: true,
      rpcCompleted: true,
    });
    assert.equal(
      legacyDeviceAuthResult({ auth: { ...hello.auth, method: "trusted-proxy" } }, true).deviceAuth,
      false,
    );
    assert.equal(
      legacyDeviceAuthResult({ auth: { ...hello.auth, scopes: ["operator.read"] } }, true).admin,
      false,
    );
    assert.equal(legacyDeviceAuthResult(hello, false).rpcCompleted, false);
    assert.equal(
      JSON.stringify(legacyDeviceAuthResult(hello, true)).includes(hello.auth.deviceToken),
      false,
    );
  });

  test("legacy forward lifecycle validates custody twice and closes on private work failure", async (t) => {
    const events: string[] = [];
    const privateMessage = randomUUID();
    await assert.rejects(
      withLegacyGrantForward(
        t,
        async () => {
          events.push("acquire");
          return {
            url: "http://127.0.0.1:12345",
            stop: async () => {
              events.push("stop");
            },
          };
        },
        async () => {
          events.push("validate");
        },
        async () => {
          events.push("work");
          throw new Error(privateMessage);
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(inspect(error).includes(privateMessage), false);
        assert.equal(error.cause, undefined);
        return /positive-command/.test(error.message);
      },
    );
    assert.deepEqual(events, ["validate", "acquire", "validate", "work", "stop"]);
  });

  test("legacy forward refuses a replacement Pod or non-loopback endpoint before credential use", async (t) => {
    for (const scenario of ["replacement", "remote"]) {
      await t.test(scenario, async (context) => {
        let validations = 0;
        let used = false;
        let stopped = 0;
        await assert.rejects(
          withLegacyGrantForward(
            context,
            async () => ({
              url: scenario === "remote" ? "http://192.0.2.1:12345" : "http://127.0.0.1:12345",
              stop: async () => {
                stopped += 1;
              },
            }),
            async () => {
              validations += 1;
              if (scenario === "replacement" && validations === 2) {
                throw new Error("changed Pod");
              }
            },
            async () => {
              used = true;
            },
          ),
          /positive-command/,
        );
        assert.equal(used, false);
        assert.equal(stopped, 1);
      });
    }
  });

  test("legacy grant fixture binds the real key pair and excludes credentials from inspection", () => {
    const { binding, identity, row } = observations();
    const grant = new LegacyBrowserGrant(binding, identity, row);
    grant.assertCurrent(row);
    assert.equal(JSON.stringify(grant), "{}");
    assert.equal(inspect(grant).includes(identity.privateKey), false);
    assert.throws(() => grant.completedChecks(), /Legacy browser grant/);
  });

  test("legacy grant fixture rejects mismatched keys, revoked grants and changed bindings", async (t) => {
    const cases: Array<[string, (input: ReturnType<typeof observations>) => void]> = [
      [
        "device id",
        (input) => {
          input.row.device_id = randomUUID();
        },
      ],
      [
        "public key",
        (input) => {
          input.row.public_key = Buffer.alloc(32, 1).toString("base64url");
        },
      ],
      [
        "client",
        (input) => {
          input.row.client_id = "node-host";
        },
      ],
      [
        "mode",
        (input) => {
          input.row.client_mode = "node";
        },
      ],
      [
        "approval provenance",
        (input) => {
          input.row.approved_via = "owner";
        },
      ],
      [
        "role",
        (input) => {
          input.row.role = "node";
          input.row.roles_json = '["node"]';
        },
      ],
      [
        "scope ceiling",
        (input) => {
          input.row.approved_scopes_json = '["operator.read"]';
        },
      ],
      [
        "revocation",
        (input) => {
          input.row.tokens_json = JSON.stringify({
            operator: { ...input.operator, revokedAtMs: Date.now() },
          });
        },
      ],
      [
        "wrong role token",
        (input) => {
          input.row.tokens_json = JSON.stringify({ node: input.operator });
        },
      ],
      [
        "missing token",
        (input) => {
          input.row.tokens_json = JSON.stringify({
            operator: { ...input.operator, token: undefined },
          });
        },
      ],
      [
        "wrong private key",
        (input) => {
          const other = observations();
          input.identity.privateKey = other.identity.privateKey;
        },
      ],
    ];
    for (const [name, alter] of cases) {
      await t.test(name, () => {
        const input = observations();
        alter(input);
        assert.throws(
          () => new LegacyBrowserGrant(input.binding, input.identity, input.row),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(inspect(error).includes(input.identity.privateKey), false);
            assert.equal(inspect(error).includes(input.operator.token), false);
            assert.equal(error.cause, undefined);
            return /Legacy browser grant/.test(error.message);
          },
        );
      });
    }
    const input = observations();
    const grant = new LegacyBrowserGrant(input.binding, input.identity, input.row);
    assert.throws(
      () =>
        new LegacyBrowserGrant(input.binding, input.identity, {
          ...input.row,
          browser_origin: input.binding.origin,
        }),
      /Legacy browser grant/,
    );
    assert.throws(
      () =>
        grant.assertCurrent({
          ...input.row,
          tokens_json: JSON.stringify({
            operator: { ...input.operator, scopes: ["operator.admin"] },
          }),
        }),
      /Legacy browser grant/,
    );
    assert.throws(
      () =>
        grant.assertCurrent({
          ...input.row,
          tokens_json: JSON.stringify({ operator: { ...input.operator, token: randomUUID() } }),
        }),
      /Legacy browser grant/,
    );
  });

  test("legacy hello requires a successful correlated operator response with token omission", async (t) => {
    const input = observations();
    assert.deepEqual(
      legacyBrowserHandshake(input.outgoing, input.incoming, input.binding.origin),
      input.binding,
    );
    const cases: Array<[string, () => unknown]> = [
      ["wrong response id", () => ({ ...input.incoming, id: randomUUID() })],
      ["failed response", () => ({ ...input.incoming, ok: false })],
      [
        "wrong auth method",
        () => ({
          ...input.incoming,
          payload: {
            ...input.incoming.payload,
            auth: { ...input.incoming.payload.auth, method: "device-token" },
          },
        }),
      ],
      [
        "non-operator",
        () => ({
          ...input.incoming,
          payload: {
            ...input.incoming.payload,
            auth: { ...input.incoming.payload.auth, role: "node" },
          },
        }),
      ],
      [
        "missing admin",
        () => ({
          ...input.incoming,
          payload: {
            ...input.incoming.payload,
            auth: { ...input.incoming.payload.auth, scopes: ["operator.read"] },
          },
        }),
      ],
      [
        "unexpected delivered token",
        () => ({
          ...input.incoming,
          payload: {
            ...input.incoming.payload,
            auth: { ...input.incoming.payload.auth, deviceToken: input.operator.token },
          },
        }),
      ],
    ];
    for (const [name, response] of cases) {
      await t.test(name, () =>
        assert.throws(
          () => legacyBrowserHandshake(input.outgoing, response(), input.binding.origin),
          /Legacy browser grant/,
        ),
      );
    }
  });

  test("legacy grant receipts require every completed witness and project fixed booleans only", () => {
    const input = observations();
    const complete = {
      helloTokenOmitted: true,
      actualPersistedGrantBound: true,
      positiveMatchingKeyAuth: true,
      afterReplayRefused: true,
    };
    assert.deepEqual(
      legacyGrantChecks({
        ...complete,
        token: input.operator.token,
        privateKey: input.identity.privateKey,
      }),
      complete,
    );
    for (const key of Object.keys(complete)) {
      assert.throws(() => legacyGrantChecks({ ...complete, [key]: false }), /Legacy browser grant/);
    }
  });

  test("legacy grant private subprocess failure never exposes its output or cause", async (t) => {
    const directory = await temporaryDirectory(t, "native-grant-private-");
    const command = join(directory, "kubectl");
    const input = observations();
    const privateOutput = syntheticCredentialUrl({
      protocol: "https",
      username: "synthetic",
      password: randomUUID(),
      host: "example.test",
    });
    await writeFile(
      command,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(privateOutput)});process.stderr.write(${JSON.stringify(privateOutput)});process.exit(1);\n`,
      { mode: 0o700 },
    );
    const grant = new LegacyBrowserGrant(input.binding, input.identity, input.row);
    await withEnvironment({ OCC_KUBECTL_BIN: command }, async () => {
      await assert.rejects(
        grant.proveBeforeCutover(
          {
            namespace: "owned",
            name: "gateway",
            uid: "owned-pod",
            agentId: "agent",
            revisionId: "revision",
            port: 18789,
          },
          t,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(inspect(error).includes(input.operator.token), false);
          assert.equal(inspect(error).includes(input.identity.privateKey), false);
          assert.equal(inspect(error).includes(privateOutput), false);
          assert.equal(error.cause, undefined);
          assert.match(error.message, /\[positive-pod\]/);
          return /Legacy browser grant/.test(error.message);
        },
      );
    });
  });
}
