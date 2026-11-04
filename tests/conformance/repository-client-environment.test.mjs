import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createClientEnvironment } from "../../apps/controller/src/drivers/repo/github/credentials/client/environment.ts";
import { repositoryClientData } from "../fixtures/repository-credentials/builders.mjs";
import { setEnvironment } from "../helpers/environment.mjs";

const configuration = {
  sessionId: "session",
  deadlineWallMs: Date.now() + 86400000,
  hasPublicCa: true,
  client: repositoryClientData(),
};

test("repository client environment preserves only managed proxy and CA variables", (t) => {
  setEnvironment(t, {
    HTTPS_PROXY: "http://127.0.0.1:1234",
    HTTP_PROXY: "http://127.0.0.1:1235",
    ALL_PROXY: "socks5://127.0.0.1:1236",
    https_proxy: "http://127.0.0.1:1237",
    SSL_CERT_FILE: "/managed/ca.pem",
    GIT_SSL_CAINFO: "/managed/git-ca.pem",
    NODE_EXTRA_CA_CERTS: "/managed/node-ca.pem",
    GH_TOKEN: "must-not-leak",
    NO_PROXY: "169.254.169.254",
  });
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
});
