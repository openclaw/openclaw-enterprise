import assert from "node:assert/strict";

/** Calls the Keycloak admin API as the lane's bootstrap administrator. */
export async function keycloakRealmAdmin(issuer, admin, method, path, body) {
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
  const response = await fetch(`${base}/admin/realms/oce${path}`, {
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
