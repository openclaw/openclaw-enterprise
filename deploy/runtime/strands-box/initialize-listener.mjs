import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";

const hosts = process.argv.slice(2);
const uid = process.env.POD_UID;
if (
  !uid ||
  !/^[0-9a-f-]{36}$/u.test(uid) ||
  hosts.length !== 2 ||
  hosts.some((host) => !/^[a-z0-9-]+\.[a-z0-9-]+\.svc$/u.test(host))
) {
  throw new Error("Invalid Strands listener identity");
}
process.umask(0o077);
const directory = "/run/strands-listener";
// The worker obtains the public certificate from kubelet's init status.
// Only this init and the trusted supervisor mount the private tmpfs.
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    "365",
    "-subj",
    `/CN=${uid}`,
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "extendedKeyUsage=serverAuth",
    "-addext",
    `subjectAltName=${hosts.map((host) => "DNS:" + host).join(",")}`,
    "-keyout",
    directory + "/key.pem",
    "-out",
    directory + "/peer.pem",
  ],
  { stdio: "ignore" },
);
copyFileSync(directory + "/peer.pem", "/dev/termination-log");
