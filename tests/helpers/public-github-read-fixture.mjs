import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caAndLeaf } from "./certificates.mjs";

// Both reader fixtures serve an end entity, never their trusted issuer. Only the
// public issuer and serving key/leaf escape this temporary signing directory.
export async function publicReaderTls(address, dnsName) {
  const directory = await mkdtemp(join(tmpdir(), "oce-reader-tls-"));
  try {
    const files = await caAndLeaf(directory, {
      caName: "public-reader-fixture-ca",
      commonName: dnsName ?? "public-reader-fixture",
      subjectAltName: ["IP:" + address, ...(dnsName ? ["DNS:" + dnsName] : [])].join(","),
    });
    return {
      ca: await readFile(files.caPath, "utf8"),
      cert: await readFile(files.certPath, "utf8"),
      key: await readFile(files.keyPath, "utf8"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const receiptPrefix = "public-read-receipt ";
const roles = ["reader", "git-provider", "api-provider"];
const tlsErrors = [
  "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ECONNRESET",
];

// Observe existing traffic only. No URLs, headers, bodies, or error messages
// enter the recorder, and a noisy peer cannot grow its output without bound.
export function publicReadReceipts(emit) {
  let count = 0;
  emit(receiptPrefix + JSON.stringify({ event: "start" }));
  function record(value) {
    if (count < 64) {
      emit(receiptPrefix + JSON.stringify(value));
    } else if (count === 64) {
      emit(receiptPrefix + JSON.stringify({ event: "truncated" }));
    }
    count = Math.min(count + 1, 65);
  }
  return (server, role) => {
    if (!roles.includes(role)) {
      throw new Error("Unsupported receipt role");
    }
    server.on("secureConnection", () => record({ role, event: "tls-accepted" }));
    server.on("tlsClientError", (error) =>
      record({
        role,
        event: "tls-error",
        code: tlsErrors.includes(error.code) ? error.code : "unknown",
      }),
    );
    server.prependListener("request", (_request, response) => {
      record({ role, event: "http-entry" });
      response.once("finish", () =>
        record({ role, event: "http-finish", status: response.statusCode }),
      );
    });
  };
}

export function readPublicReadReceipts(text) {
  const result = { collected: false, truncated: false, malformed: false, events: [] };
  if (typeof text !== "string" || text.length > 64 * 1024) {
    return result;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith(receiptPrefix)) {
      continue;
    }
    try {
      const value = JSON.parse(line.slice(receiptPrefix.length));
      if (value.event === "start" && Object.keys(value).length === 1) {
        result.collected = true;
      } else if (value.event === "truncated" && Object.keys(value).length === 1) {
        result.truncated = true;
      } else if (
        roles.includes(value.role) &&
        ((["tls-accepted", "http-entry"].includes(value.event) &&
          Object.keys(value).length === 2) ||
          (value.event === "tls-error" &&
            [...tlsErrors, "unknown"].includes(value.code) &&
            Object.keys(value).length === 3) ||
          (value.event === "http-finish" &&
            Number.isInteger(value.status) &&
            value.status >= 100 &&
            value.status <= 599 &&
            Object.keys(value).length === 3))
      ) {
        if (result.events.length < 64) {
          result.events.push(value);
        } else {
          result.truncated = true;
        }
      } else {
        result.malformed = true;
      }
    } catch {
      result.malformed = true;
    }
  }
  result.collected &&= !result.malformed;
  return result;
}
