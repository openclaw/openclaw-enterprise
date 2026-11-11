import assert from "node:assert/strict";

async function keycloakAdmin(issuer, admin, method, path, body) {
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
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${(await token.json()).access_token}`,
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

/** Calls the Keycloak admin API for the lane's imported realm. */
export async function keycloakRealmAdmin(issuer, admin, method, path, body) {
  return keycloakAdmin(issuer, admin, method, `/admin/realms/oce${path}`, body);
}

/** Matches the configured client locally so fixture data stays out of the request URL. */
export async function findKeycloakRealmClient(issuer, admin, clientId) {
  const clients = await keycloakRealmAdmin(issuer, admin, "GET", "/clients");
  return clients.find((client) => client.clientId === clientId);
}

/** Creates a realm for one test and returns a function that deletes it. */
export async function createKeycloakTestRealm(issuer, admin, realm) {
  const name = realm.realm;
  assert.ok(
    typeof name === "string" && name.length > 0 && name !== "." && name !== "..",
    "the test realm has a name",
  );
  await keycloakAdmin(issuer, admin, "POST", "/admin/realms", realm);
  return async () => {
    await keycloakAdmin(issuer, admin, "DELETE", `/admin/realms/${encodeURIComponent(name)}`);
  };
}

/** Regenerate one real client's secret, then verify its previous secret no longer authenticates. */
export async function rotateKeycloakClientSecret(
  issuer,
  admin,
  clientId,
  previousSecret,
  tokenUrl,
) {
  const [client] = await keycloakRealmAdmin(issuer, admin, "GET", `/clients?clientId=${clientId}`);
  const next = await keycloakRealmAdmin(
    issuer,
    admin,
    "POST",
    `/clients/${client.id}/client-secret`,
  );
  assert.ok(
    typeof next.value === "string" && next.value.length > 0 && next.value !== previousSecret,
  );
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
  assert.ok(["invalid_client", "unauthorized_client"].includes((await rejected.json()).error));
  return next.value;
}
