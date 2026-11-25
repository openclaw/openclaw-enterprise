import assert from "node:assert/strict";
import { after } from "node:test";
import {
  Agent,
  buildConnector,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "../../apps/controller/node_modules/undici/index.js";
import { asRecord } from "../../packages/utils/src/index.ts";
import { keycloakHost, keycloakTokenHost } from "../../scripts/ci/keycloak.ts";

export const keycloakHostPort = Number(process.env.OCC_TEST_KEYCLOAK_HOST_PORT ?? "443");

export function keycloakBrowserRoute(host: string) {
  return `MAP ${host}:443 127.0.0.1:${keycloakHostPort}`;
}

if (keycloakHostPort !== 443) {
  // Route real HTTPS while retaining the Host header and certificate name that OIDC verifies.
  const connect = buildConnector({});
  const dispatcher = new Agent({
    connect(options, callback) {
      if (
        options.protocol === "https:" &&
        (options.port === "" || options.port === "443") &&
        (options.hostname === keycloakHost || options.hostname === keycloakTokenHost)
      ) {
        connect(
          {
            ...options,
            hostname: "127.0.0.1",
            servername: options.hostname,
            port: String(keycloakHostPort),
          },
          callback,
        );
      } else {
        connect(options, callback);
      }
    },
  });
  const original = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);
  after(async () => {
    setGlobalDispatcher(original);
    await dispatcher.destroy();
  });
}

type RealmAdmin = { username: string; password: string };
type RealmRow = Record<string, unknown> & { id: string };

function isRealmRow(value: unknown): value is RealmRow {
  const id = asRecord(value)?.id;
  return typeof id === "string" && id.length > 0;
}

/** Read a Keycloak collection at the call site, retaining the complete rows for fixture updates. */
export function keycloakRealmRows(value: unknown): readonly RealmRow[] {
  assert.ok(Array.isArray(value), "expected a Keycloak realm collection");
  const rows: readonly unknown[] = value;
  assert.ok(rows.every(isRealmRow), "expected each Keycloak realm row to have an id");
  return rows;
}

/** Calls the Keycloak admin API as the lane's bootstrap administrator. */
export async function keycloakRealmAdmin(
  issuer: string,
  admin: RealmAdmin,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: object,
): Promise<unknown> {
  const base = new URL(issuer).origin;
  const token = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: admin.username,
      password: admin.password,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(token.status, 200, "the lane administrator signs in to Keycloak");
  const accessToken = asRecord(await token.json())?.access_token;
  assert.ok(
    typeof accessToken === "string" && accessToken.length > 0,
    "invalid Keycloak admin token",
  );
  const response = await fetch(`${base}/admin/realms/oce${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    assert.fail(
      `Keycloak ${method} ${path} answered HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.status === 200 ? response.json() : response;
}

/** Regenerate one real client's secret, then verify its previous secret no longer authenticates. */
export async function rotateKeycloakClientSecret(
  issuer: string,
  admin: RealmAdmin,
  clientId: string,
  previousSecret: string,
  tokenUrl: string,
): Promise<string> {
  const [client] = keycloakRealmRows(
    await keycloakRealmAdmin(issuer, admin, "GET", `/clients?clientId=${clientId}`),
  );
  assert.ok(client, "expected the Keycloak client to rotate");
  const next = asRecord(
    await keycloakRealmAdmin(issuer, admin, "POST", `/clients/${client.id}/client-secret`),
  )?.value;
  assert.ok(typeof next === "string" && next.length > 0 && next !== previousSecret);
  const rejected = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${clientId}:${previousSecret}`).toString("base64"),
    },
    // A client authentication failure is distinguishable from a rejection of this unused grant.
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "unused-test-grant" }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(rejected.status, 401);
  const error = asRecord(await rejected.json())?.error;
  assert.ok(typeof error === "string" && ["invalid_client", "unauthorized_client"].includes(error));
  return next;
}
