import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const { issuer, keys, expectedSubjects, path, port } = JSON.parse(
  readFileSync(process.argv[2], "utf8"),
);

function verifiedIdentity(authorization) {
  if (!authorization.startsWith("Bearer ")) {
    return { rejection: "missing-bearer" };
  }
  const bearer = authorization.slice("Bearer ".length);
  if (bearer.startsWith("openshell:")) {
    return { rejection: "unexpanded-placeholder" };
  }
  if (bearer.split(".").length !== 3) {
    return { rejection: "not-a-jwt" };
  }
  const [header, body, signature] = bearer.split(".");
  let jose;
  let claims;
  try {
    jose = JSON.parse(Buffer.from(header, "base64url"));
    claims = JSON.parse(Buffer.from(body, "base64url"));
  } catch {
    return { rejection: "malformed-jwt" };
  }
  const jwk = keys.find((key) => key.kid === jose.kid);
  if (jose.alg !== "RS256" || !jwk) {
    return { rejection: "unexpected-signing-key" };
  }
  if (
    !verify(
      "RSA-SHA256",
      Buffer.from(header + "." + body),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    )
  ) {
    return { rejection: "signature-invalid" };
  }
  if (claims.iss !== issuer) {
    return { rejection: "issuer-mismatch" };
  }
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
    return { rejection: "expired-token" };
  }
  if (!expectedSubjects.includes(claims.sub)) {
    return { rejection: "unexpected-subject" };
  }
  return { subject: claims.sub };
}

// The recipient checks the actual browser grant on each request. It never logs bearer tokens.
createServer(
  { cert: readFileSync("/tls.crt"), key: readFileSync("/tls.key") },
  async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (request.method !== "POST" || request.url !== path) {
      return reply(405);
    }
    const { subject, rejection } = verifiedIdentity(request.headers.authorization ?? "");
    if (rejection) {
      console.log(JSON.stringify({ rejection }));
      return reply(401);
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const { id, method, params } = JSON.parse(Buffer.concat(chunks));
    const success = (result) => reply(200, { jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return success({
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "Keycloak identity fixture", version: "1.0" },
      });
    }
    if (method === "notifications/initialized") {
      return reply(202);
    }
    if (method === "tools/list") {
      return success({
        tools: [
          {
            name: "whoami",
            description: "Return the authenticated account subject.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    }
    if (
      method === "tools/call" &&
      params?.name === "whoami" &&
      Object.keys(params.arguments).length === 0
    ) {
      console.log(JSON.stringify({ tool: params.name, subject }));
      return success({ content: [{ type: "text", text: subject }] });
    }
    return reply(400);
  },
).listen(port, "0.0.0.0");
