import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";

const expected = JSON.parse(process.argv[2]);
const directory = mkdtempSync("/tmp/gog-account-fixture-");
const cert = join(directory, "cert.pem");
const key = join(directory, "key.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=gmail.googleapis.com",
    "-addext",
    "subjectAltName=DNS:gmail.googleapis.com,DNS:www.googleapis.com",
    "-keyout",
    key,
    "-out",
    cert,
  ],
  { stdio: "ignore" },
);
const received = [];
const endpoint = createServer(
  { cert: readFileSync(cert), key: readFileSync(key) },
  (request, response) => {
    received.push({
      path: request.url.split("?")[0],
      bearerHash: request.headers.authorization
        ? createHash("sha256").update(request.headers.authorization).digest("hex")
        : undefined,
      bindingId: request.headers["x-oce-account-binding"],
    });
    const method = {
      id: "gmail.users.labels.list",
      path: "gmail/v1/users/{userId}/labels",
      httpMethod: "GET",
      parameters: { userId: { type: "string", location: "path", required: true } },
    };
    const description = {
      name: "gmail",
      version: "v1",
      rootUrl: "https://gmail.googleapis.com/",
      resources: { users: { resources: { labels: { methods: { list: method } } } } },
    };
    const isDiscovery = request.url.split("?")[0] === "/discovery/v1/apis/gmail/v1/rest";
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(isDiscovery ? description : { labels: [] }));
  },
);
// The test container has loopback only. Its Google host entries resolve to this listener.
endpoint.listen(443, "127.0.0.1");
await once(endpoint, "listening");
try {
  for (const { args, bearerHash, bindingId, discovery } of expected) {
    const before = received.length;
    const command = discovery
      ? [
          "api",
          "call",
          "gmail",
          "v1",
          "gmail.users.labels.list",
          "--no-cache",
          "--params",
          '{"userId":"me"}',
        ]
      : ["gmail", "labels", "list"];
    const call = promisify(execFile)("gog", [...args, "--json", "--no-input", ...command], {
      env: {
        ...process.env,
        GOG_HOME: directory,
        SSL_CERT_FILE: cert,
        NO_PROXY: "*",
      },
      timeout: 20_000,
    });
    if (bearerHash || bindingId) {
      await call;
      assert.deepEqual(received.slice(before), [
        ...(discovery
          ? [{ path: "/discovery/v1/apis/gmail/v1/rest", bindingId, bearerHash: undefined }]
          : []),
        { path: "/gmail/v1/users/me/labels", bearerHash, bindingId },
      ]);
    } else {
      await assert.rejects(
        call,
        (error) => error.code === 2 && /bound account|account is unavailable/.test(error.stderr),
      );
      assert.equal(received.length, before);
    }
  }
} finally {
  endpoint.close();
}
