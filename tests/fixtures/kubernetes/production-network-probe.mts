import { Resolver } from "node:dns/promises";
import { get } from "node:https";
import { createConnection } from "node:net";

type TcpTarget = { host: string; port: number; dns?: never; ca?: never };
type ApiTarget = Omit<TcpTarget, "ca"> & { ca: string };

export type NetworkProbeTarget =
  { dns: string; host?: never; port?: never; ca?: never } | TcpTarget | ApiTarget;

const timeoutMs = 1500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(value: unknown, name: string): NetworkProbeTarget {
  if (isRecord(value)) {
    const { dns, host, port, ca } = value;
    if (typeof dns === "string" && host === undefined && port === undefined && ca === undefined) {
      return { dns };
    }
    if (
      dns === undefined &&
      typeof host === "string" &&
      typeof port === "number" &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535
    ) {
      if (ca === undefined) {
        return { host, port };
      }
      if (typeof ca === "string" && ca.length > 0) {
        return { host, port, ca };
      }
    }
  }
  throw new Error(`Invalid network probe target ${name}`);
}

function isApiReply(statusCode: number | undefined, body: string): boolean {
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    isRecord(result) &&
    ((statusCode === 200 && typeof result.gitVersion === "string") ||
      (statusCode === 401 &&
        result.kind === "Status" &&
        result.reason === "Unauthorized" &&
        result.code === 401))
  );
}

function probeApi({ host, port, ca }: ApiTarget): Promise<void> {
  return new Promise((resolve, reject: (reason: unknown) => void) => {
    const request = get(
      {
        hostname: host,
        port,
        path: "/version",
        servername: "kubernetes.default.svc",
        ca,
        agent: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("error", reject);
        response.once("end", () => {
          if (isApiReply(response.statusCode, body)) {
            resolve();
          } else {
            reject(
              Object.assign(new Error("Expected Kubernetes response"), {
                code: "INVALID_API_RESPONSE",
              }),
            );
          }
        });
      },
    );
    const deadline = setTimeout(
      () => request.destroy(Object.assign(new Error(), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
    request.once("close", () => clearTimeout(deadline));
    request.once("error", reject);
  });
}

function probeTcp({ host, port }: TcpTarget): Promise<void> {
  return new Promise((resolve, reject: (reason: unknown) => void) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(Object.assign(new Error(), { code: "ETIMEDOUT" }));
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

// DNS uses the Pod's real resolver, and TCP destinations are live listeners.
// Reporting transport errors as data keeps kubectl, image, and script failures fatal.
async function probe(target: NetworkProbeTarget): Promise<string> {
  try {
    if (target.dns !== undefined) {
      await new Resolver({ timeout: timeoutMs, tries: 1 }).resolve4(target.dns);
    } else if (target.ca !== undefined) {
      await probeApi(target);
    } else {
      await probeTcp(target);
    }
    return "connected";
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    return `Unexpected probe error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// inlineProbeCommand supplies the script argument before the encoded targets.
const encodedTargets = process.argv[2];
if (encodedTargets === undefined) {
  throw new Error("Expected network probe targets");
}
const input: unknown = JSON.parse(encodedTargets);
if (!isRecord(input)) {
  throw new Error("Expected named network probe targets");
}
const targets = Object.entries(input).map(([name, value]): [string, NetworkProbeTarget] => [
  name,
  parseTarget(value, name),
]);
const results = await Promise.all(
  targets.map(async ([name, target]): Promise<[string, string]> => [name, await probe(target)]),
);
console.log(JSON.stringify(Object.fromEntries(results)));
