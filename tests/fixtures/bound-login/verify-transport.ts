import https from "node:https";
import net from "node:net";
import assert from "node:assert/strict";

const rejected = await new Promise<string>((resolve) => {
  https
    .get({ hostname: "localhost", port: 39081, path: "/", ca: [] }, (r) => {
      r.resume();
      resolve("TRUSTED");
    })
    .on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "UNKNOWN"));
});
assert.ok(
  [
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ].includes(rejected),
);
const trusted = await fetch("https://api.github.com/bound-login-denied-route", {
  signal: AbortSignal.timeout(5000),
});
assert.equal(trusted.status, 403);
const denied = await new Promise<string>((resolve, reject) => {
  const s = net.connect({ host: "127.0.0.1", port: 39082 }, () =>
    s.write("CONNECT forbidden.invalid:443 HTTP/1.1\r\nHost: forbidden.invalid:443\r\n\r\n"),
  );
  s.once("data", (b) => {
    resolve(b.toString());
    s.destroy();
  });
  s.on("error", reject);
  s.setTimeout(5000, () => s.destroy(new Error("Timeout")));
});
assert.ok(denied.startsWith("HTTP/1.1 403"));
process.stdout.write(
  JSON.stringify({
    untrustedChainRejected: true,
    normalAuthorityVerified: true,
    foreignConnectRejected: true,
  }),
);
