import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:https";
import { isIPv4 } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLLED_INFERENCE_MARKER } from "../host/egress.ts";
import { fields, object, privateDirectory, readConfig, string } from "../host/launch.ts";
import { controlledModelRequests, isNonce } from "./box-workload.ts";

function privateAddress(input: unknown): string {
  const value = string(input);
  if (!isIPv4(value) || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(value)) {
    throw new Error("Use an exact private IPv4 address.");
  }
  return value;
}

function tlsFile(value: unknown, privateKey: boolean): Buffer {
  const path = string(value);
  const stat = lstatSync(path);
  if (
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & (privateKey ? 0o077 : 0o022)) !== 0 ||
    stat.size > 32_768
  ) {
    throw new Error("Use an owner-controlled TLS file.");
  }
  return readFileSync(path);
}

function start(path: string) {
  const data = object(readConfig(path));
  fields(data, ["address", "port", "boxAddress", "certificate", "key", "runDirectory", "nonce"]);
  const host = privateAddress(data.address);
  const boxAddress = privateAddress(data.boxAddress);
  const port = data.port;
  const nonce = data.nonce;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    !isNonce(nonce)
  ) {
    throw new Error("Use an unprivileged TLS port and an exact probe nonce.");
  }
  const runDirectory = privateDirectory(data.runDirectory);
  const receipt = join(runDirectory, "controlled-chat.jsonl");
  appendFileSync(receipt, "", { flag: "wx", mode: 0o600 });
  const server = createServer(
    {
      cert: tlsFile(data.certificate, false),
      key: tlsFile(data.key, true),
      minVersion: "TLSv1.2",
      requestTimeout: 15_000,
      headersTimeout: 5_000,
    },
    controlledModelRequests(nonce, (row) => appendFileSync(receipt, JSON.stringify(row) + "\n"), {
      address: boxAddress,
      authorization: `Bearer ${CONTROLLED_INFERENCE_MARKER}`,
    }),
  );
  server.maxConnections = 8;
  server.on("error", () => {
    process.stderr.write("Controlled model listener refused.\n");
    process.exitCode = 1;
  });
  server.listen(port, host, () => process.stdout.write("Controlled model fixture is listening.\n"));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] === undefined) {
      throw new Error("Expected one private fixture configuration.");
    }
    start(process.argv[2]);
  } catch {
    process.stderr.write("Controlled model fixture refused its configuration.\n");
    process.exitCode = 1;
  }
}
