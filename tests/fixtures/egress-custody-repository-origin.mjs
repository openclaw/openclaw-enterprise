import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { custodyOriginWire } from "./egress-custody-origin-wire.mjs";

export const repository = { id: 7301, full_name: "fixture/repository" };
export const credentialFreeRepository = { id: 7311, full_name: "fixture/credential-free" };
export const repositoryPath = "/repos/" + repository.full_name;

// Only GitHub's public wire is simulated. Production OCE must prepare the token
// and constrain its use; this listener counts even unauthorized business traffic.
export async function startCustodyRepositoryOrigin(t, configuration) {
  const identity = {
    app_id: "7302",
    installation_id: "7303",
    repository_id: "7301",
    repository: repository.full_name,
  };
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = "synthetic-custody-" + randomBytes(32).toString("hex");
  const issuerKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  configuration.protect?.(token, issuerKey);
  const observations = [];
  const gates = [];
  const releases = new Set();
  let nextResponse;
  let issues = 0;
  let retirement204 = 0;
  // GitHub's installation-token exchange: an RS256 app JWT and the one-repository body.
  const acceptsIssueRequest = (authorization, text) => {
    try {
      const bearer = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/i.exec(authorization ?? "");
      assert.ok(bearer, "expected a bearer with three compact JWT segments");
      const [, header, claims, signature] = bearer;
      assert.ok(
        verify("RSA-SHA256", header + "." + claims, publicKey, Buffer.from(signature, "base64url")),
      );
      assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
      const { iss, iat, exp } = JSON.parse(Buffer.from(claims, "base64url"));
      const now = Math.floor(Date.now() / 1000);
      assert.equal(String(iss), identity.app_id);
      assert.ok(Number.isSafeInteger(iat) && Number.isSafeInteger(exp));
      assert.ok(iat <= now && now < exp && exp - iat <= 600);
      assert.deepEqual(JSON.parse(text), {
        repository_ids: [repository.id],
        permissions: { metadata: "read" },
      });
      return true;
    } catch {
      return false;
    }
  };
  const server = custodyOriginWire(
    {
      cert: await readFile(configuration.certificatePath),
      key: await readFile(configuration.privateKeyPath),
    },
    async (req, res) => {
      const body = [];
      for await (const chunk of req) {
        body.push(chunk);
      }
      const text = Buffer.concat(body).toString();
      if (req.method === "POST" && req.url === "/app/installations/7303/access_tokens") {
        if (!acceptsIssueRequest(req.headers.authorization, text)) {
          res.writeHead(403).end();
          return;
        }
        issues++;
        res.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({
            token,
            permissions: { metadata: "read" },
            repositories: [repository],
            expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
          }),
        );
        return;
      }
      if (
        req.method === "DELETE" &&
        req.url === "/installation/token" &&
        req.headers.authorization === "Bearer " + token
      ) {
        retirement204++;
        res.writeHead(204).end();
        return;
      }
      const exactCredentialFreeRead =
        req.method === "GET" &&
        req.url === "/repos/" + credentialFreeRepository.full_name &&
        !text &&
        Object.keys(req.headers).every((name) =>
          ["host", "connection", "content-length", "accept", "user-agent"].includes(name),
        );
      const entry = {
        exactCredentialFreeRead,
        number: observations.length + 1,
        mode: "denied",
        wireRequest: server.requestOnWire(req.socket),
        exactRead:
          issues > 0 &&
          req.method === "GET" &&
          req.url === repositoryPath &&
          !text &&
          req.headers.authorization === "Bearer " + token,
        finished: false,
        closed: false,
      };
      observations.push(entry);
      res.once("close", () => {
        entry.closed = true;
      });
      if (!entry.exactRead && !exactCredentialFreeRead) {
        res.writeHead(403).end();
        return;
      }
      assert.ok(entry.wireRequest, "observe request on the TLS socket before parsing it");
      // Count denied traffic, but reserve the controlled response for an admitted read.
      const gate = gates.shift();
      const selected = gate?.response ?? nextResponse ?? "normal";
      nextResponse = undefined;
      entry.mode = selected;
      if (gate) {
        gate.arrived.resolve(entry);
        await gate.send.promise;
      }
      // Identical status, headers, valid body and chunk framing. Only the last
      // actual trailer differs. No Trailer declaration or earlier trailer can block it.
      const responseBody = JSON.stringify({
        ...(exactCredentialFreeRead ? credentialFreeRepository : repository),
        description: "omit-from-response",
      });
      const finalName = selected === "forbidden-final" ? "x-fixture-forbidden-last" : null;
      const wire = [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Connection: close",
        "Transfer-Encoding: chunked",
        "",
        responseBody.length.toString(16),
        responseBody,
        "0",
        ...(finalName ? [finalName + ": synthetic-forbidden-value"] : []),
        "",
        "",
      ].join("\r\n");
      const socket = res.socket;
      const submitted = Boolean(socket && !socket.destroyed);
      if (submitted) {
        socket.end(wire, (error) => {
          if (!error) {
            entry.actualLastTrailer = finalName;
            entry.finished = true;
          }
        });
      }
      // A replaced workload can already have lost its provider socket. Record
      // that separately from a submitted late reply; neither proves delivery at A.
      gate?.released.resolve(
        submitted ? "submitted-to-origin-socket" : "origin-socket-already-closed",
      );
    },
  );

  t.after(
    () =>
      new Promise((resolve) => {
        for (const release of releases) {
          release();
        }
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.bindPort, configuration.bindHost, resolve);
  });
  return {
    observations,
    identity,
    businessOrigin: new URL(configuration.origin).origin,
    privateKey: issuerKey,
    forbiddenFinal() {
      nextResponse = "forbidden-final";
    },
    get wireRequests() {
      return server.wireCount();
    },
    holdNext(response = "normal") {
      const send = Promise.withResolvers();
      const arrived = Promise.withResolvers();
      const released = Promise.withResolvers();
      const release = () => {
        releases.delete(release);
        send.resolve();
        return released.promise;
      };
      releases.add(release);
      gates.push({ response, arrived, send, released });
      return { arrived: arrived.promise, release };
    },
    // Aggregate fixture observations only. This origin reuses a token, and writing a 204
    // does not prove delivery to the caller or which prepared source initiated retirement.
    retirementEvidence() {
      return { issues, retirement204 };
    },
    get issues() {
      return issues;
    },
    get tcpConnections() {
      return server.tcpCount();
    },
  };
}
