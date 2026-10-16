import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Install the actual Helm-rendered profile Pod, isolation and least-privilege readback Role. */
export function installStrandsProfile(kubectl, namespace, image) {
  const manifest = execFileSync("helm", [
    "template",
    "strands-profile",
    "deploy/helm/openclaw-execution",
    "-n",
    namespace,
    "--show-only",
    "templates/strands-installation.yaml",
    "--set",
    "strandsBoxCredentialProxy.enabled=true",
    "--set-string",
    "strandsBoxCredentialProxy.gatewayImage=" + image,
    // Required execution chart settings. Render only the installation profile, never apply routing here.
    "--set",
    "routing.hostname=profile.invalid,routing.gatewayClassName=envoy,routing.tlsSecretName=none,routing.controlPlaneCidrs[0]=192.0.2.1/32",
  ]);
  kubectl(["-n", namespace, "create", "-f", "-"], { input: manifest });
  kubectl([
    "-n",
    namespace,
    "rollout",
    "status",
    "statefulset/oce-strands-installation",
    "--timeout=180s",
  ]);
}

// A fresh, private CA and SAN-verified end entity for the disposable installation.
// Do not import this root into the host or relax TLS verification in either direction.
export function issueStrandsTlsFixture(dir, san) {
  const run = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const read = (file) => readFileSync(dir + "/" + file, "utf8");
  run(
    "req",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-days",
    "2",
    "-subj",
    "/CN=Qualification Root",
    "-keyout",
    "ca-key",
    "-out",
    "ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  run(
    "req",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-subj",
    "/CN=Qualification Origin",
    "-keyout",
    "key",
    "-out",
    "csr",
  );
  writeFileSync(
    dir + "/extensions",
    "basicConstraints=critical,CA:FALSE\nsubjectAltName=" + san + "\nextendedKeyUsage=serverAuth\n",
  );
  run(
    "x509",
    "-req",
    "-days",
    "2",
    "-in",
    "csr",
    "-CA",
    "ca",
    "-CAkey",
    "ca-key",
    "-CAcreateserial",
    "-extfile",
    "extensions",
    "-out",
    "cert",
  );
  return { caPath: dir + "/ca", ca: read("ca"), cert: read("cert"), key: read("key") };
}

// Return a content-free client probe to run inside the released Harness, never the valid capability.
// Require explicit 401/403 on the established connection; capability behavior is not server identity.
export function rejectedStrandsWsCapabilities(port = 18790) {
  return `
    const http = require("node:http"), crypto = require("node:crypto");
    const probe = (authorization) => new Promise((ok, fail) => {
      let connected = false;
      const headers = { connection:"Upgrade", upgrade:"websocket",
        "sec-websocket-version":"13", "sec-websocket-key":crypto.randomBytes(16).toString("base64") };
      if (authorization) headers.authorization = authorization;
      const req = http.request({hostname:"127.0.0.1",port:${Number(port)},path:"/",headers,agent:false,
        signal:AbortSignal.timeout(4000)});
      req.on("socket", socket => socket.once("connect", () => connected = true));
      req.once("error", e => fail(new Error("need an explicit capability refusal at the listener: " + e.code)));
      req.once("response", res => {
        res.resume();
        if (connected && [401,403].includes(res.statusCode)) ok();
        else fail(new Error("expected an explicit capability refusal at the established listener"));
      });
      req.once("upgrade", (res,socket) => {
        socket.destroy(); fail(new Error("listener allowed missing or deliberately wrong capability"));
      });
      req.end();
    });
    Promise.all([probe(),probe("Bearer qualification-wrong-" + crypto.randomUUID())])
      .catch(error => { console.error(error.message); process.exitCode = 2; });
  `;
}
