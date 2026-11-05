import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Exercises OCC's Google account flow with a controlled token endpoint. No request leaves the process. */
export async function connectFixtureGoogleAccount(t, owner, namespaceId, grantedScopes) {
  const issuer = "https://accounts.google.com";
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const revocationUrl = "https://oauth2.googleapis.com/revoke";
  const clientId = randomUUID();
  const templateInput = {
    mode: "manual",
    displayName: "Google APIs",
    namespaceId,
    issuer,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl,
    revocationUrl,
    scopes: [],
    destinations: [
      { host: "gmail.googleapis.com", port: 443, path: "/gmail/v1/users/me/messages" },
      { host: "www.googleapis.com", port: 443, path: "/calendar/v3/**" },
    ],
  };
  const template = await owner("POST", "/connection-templates", templateInput);
  assert.equal(template.statusCode, 201, template.body);
  const registration = await owner("POST", "/oauth-clients", {
    connectionTemplateId: template.json().data.id,
    connectionTemplateVersion: template.json().data.current.version,
    displayName: "Google test registration",
    clientId,
    clientSecret: randomUUID(),
    tokenEndpointAuthMethod: "client_secret_post",
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const path = "/namespaces/" + namespaceId + "/connections";
  const start = await owner("POST", path, {
    connectionTemplateId: template.json().data.id,
    selectedScopes: grantedScopes,
  });
  assert.equal(start.statusCode, 201, start.body);
  const { authorizationUrl, credentialSourceId } = start.json().data;
  const authorization = new URL(authorizationUrl);
  assert.equal(authorization.origin, issuer);
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get("state"),
    iss: issuer,
    code: randomUUID(),
  });
  const accessToken = randomUUID();
  const exchange = t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), tokenUrl);
    return Response.json({
      access_token: accessToken,
      refresh_token: randomUUID(),
      expires_in: 3600,
      token_type: "Bearer",
      scope: grantedScopes.join(" "),
    });
  });
  try {
    const completed = await owner("GET", callback.pathname + callback.search);
    assert.match(String(completed.headers.location), /connection=connected/);
    assert.equal(exchange.mock.callCount(), 1);
  } finally {
    exchange.mock.restore();
  }
  const saved = await owner("GET", path);
  assert.equal(saved.statusCode, 200, saved.body);
  const receipt = saved.json().data.find((row) => row.credentialSourceId === credentialSourceId);
  assert.deepEqual(receipt.destinations, templateInput.destinations);
  assert.deepEqual(receipt.grantedScopes, grantedScopes);
  return {
    credentialSourceId,
    accessToken,
    templateInput: { ...templateInput, oauthClientId: registration.json().data.id },
  };
}
