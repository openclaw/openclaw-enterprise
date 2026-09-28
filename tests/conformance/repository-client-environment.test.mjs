import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createClientEnvironment } from "../../apps/controller/src/drivers/repo/github/credentials/client/environment.ts";

const configuration = {
  sessionId: "session",
  deadlineWallMs: Date.now() + 86400000,
  hasPublicCa: true,
  client: {
    gatewayOrigin: "https://credentials.example.test",
    gitRemote: "https://credentials.example.test/example/project.git",
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository: "example/project",
  },
};

test("repository client environment preserves only managed proxy and CA variables", () => {
  const names = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "SSL_CERT_FILE",
    "GIT_SSL_CAINFO",
    "NODE_EXTRA_CA_CERTS",
    "GH_TOKEN",
    "NO_PROXY",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.HTTPS_PROXY = "http://127.0.0.1:1234";
    process.env.HTTP_PROXY = "http://127.0.0.1:1235";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1236";
    process.env.https_proxy = "http://127.0.0.1:1237";
    process.env.SSL_CERT_FILE = "/managed/ca.pem";
    process.env.GIT_SSL_CAINFO = "/managed/git-ca.pem";
    process.env.NODE_EXTRA_CA_CERTS = "/managed/node-ca.pem";
    process.env.GH_TOKEN = "must-not-leak";
    process.env.NO_PROXY = "169.254.169.254";
    const env = createClientEnvironment(configuration, "/session", "/home/node");
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:1234");
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:1235");
    assert.equal(env.ALL_PROXY, "socks5://127.0.0.1:1236");
    assert.equal(env.https_proxy, "http://127.0.0.1:1237");
    assert.equal(env.SSL_CERT_FILE, "/managed/ca.pem");
    assert.equal(env.GIT_SSL_CAINFO, "/managed/git-ca.pem");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/managed/node-ca.pem");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.NO_PROXY, undefined);

    delete process.env.SSL_CERT_FILE;
    delete process.env.GIT_SSL_CAINFO;
    delete process.env.NODE_EXTRA_CA_CERTS;
    const fallback = createClientEnvironment(configuration, "/session", "/home/node");
    assert.equal(fallback.SSL_CERT_FILE, join("/session", "ca.pem"));
    assert.equal(fallback.GIT_SSL_CAINFO, join("/session", "ca.pem"));
    assert.equal(fallback.NODE_EXTRA_CA_CERTS, join("/session", "ca.pem"));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
