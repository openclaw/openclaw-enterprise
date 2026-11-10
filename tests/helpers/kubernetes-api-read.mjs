// Answers `kubectl get ... -o json` from the API server in this process. Real
// k3d tests read the cluster hundreds of times per file, most often in loops
// that wait for a Pod, a Deployment or an endpoint; each read used to start a
// kubectl process (about 0.1 CPU-s). Here a read is one request on a kept-alive
// HTTPS connection, and the answer is the text kubectl prints: the object, or a
// `List` whose items carry their apiVersion and kind, without managedFields,
// with sorted keys and Go's escaping. A read retries what kubectl's client
// retries (a dropped connection, 429 and 5xx answers with Retry-After), and a
// failure reads like kubectl's (`Error from server (NotFound): ...` on stderr;
// transport failures as "Unable to connect to the server"), so callers that
// match kubectl's errors or retry its transient failures behave the same.
//
// Only plain reads are served: one resource kind, an optional name, and the
// namespace, label selector, field selector, all-namespaces and request-timeout
// flags. Anything else, a kind discovery does not list, and a kubeconfig whose
// credentials are not embedded client certificates or a bearer token, returns
// undefined, and the caller runs kubectl.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Agent, request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
// A request that sends nothing for this long is dropped, and so is discovery.
const requestTimeoutMs = 60_000;
// The API server closes idle connections after about 90 s; close ours first.
const idleConnectionMs = 30_000;
// kubectl's client retries a read this many times.
const maxRetries = 10;
// A kind discovery did not list is looked up again at most this often.
const rediscoveryMs = 30_000;

// One reader per kubeconfig content and context, so a rewritten kubeconfig
// gets new credentials.
const readers = new Map();

async function readerFor({ kubeconfigPath, kubernetesContext }) {
  // Embedded credentials only, as k3d writes them. Anything else (a kubeconfig
  // that names certificate files, or none at all, as for a stand-in kubectl) is
  // kubectl's, without spending a kubectl run to find out.
  const text =
    kubeconfigPath === undefined ? "" : await readFile(kubeconfigPath, "utf8").catch(() => "");
  if (!text.includes("certificate-authority-data")) {
    return undefined;
  }
  const key = `${kubeconfigPath}\0${kubernetesContext}\0${text}`;
  if (!readers.has(key)) {
    // A kubeconfig kubectl could not read this time is tried again on the
    // next read; any other failure to set up a reader leaves the reads to kubectl.
    readers.set(
      key,
      createReader(kubeconfigPath, kubernetesContext).catch((error) => {
        if (error?.unreadConfiguration) {
          readers.delete(key);
        }
        return undefined;
      }),
    );
  }
  return readers.get(key);
}

// Parses the arguments of a `kubectl get` this module can answer, or returns undefined.
export function plainGet(args) {
  if (args[0] !== "get") {
    return undefined;
  }
  const positional = [];
  const options = {
    output: undefined,
    namespace: undefined,
    allNamespaces: false,
    timeoutMs: undefined,
  };
  const query = new URLSearchParams();
  for (let index = 1; index < args.length; index += 1) {
    const argument = String(args[index]);
    const [flag, inline] = argument.startsWith("--") ? argument.split(/=(.*)/s, 2) : [argument];
    const value = () => (inline !== undefined ? inline : String(args[(index += 1)] ?? ""));
    if (flag === "-o" || flag === "--output") {
      options.output = value();
    } else if (argument.startsWith("-o=")) {
      options.output = argument.slice(3);
    } else if (flag === "-n" || flag === "--namespace") {
      options.namespace = value();
      if (options.namespace === "") {
        return undefined;
      }
    } else if (flag === "-l" || flag === "--selector") {
      query.set("labelSelector", value());
    } else if (flag === "--field-selector") {
      query.set("fieldSelector", value());
    } else if (flag === "-A" || flag === "--all-namespaces") {
      if (inline !== undefined && inline !== "true") {
        return undefined;
      }
      options.allNamespaces = true;
    } else if (flag === "--request-timeout") {
      // kubectl's duration: a number of seconds, or one unit (ms, s, m); 0 is no timeout.
      const duration = /^(\d+)(ms|s|m)?$/.exec(value());
      if (duration === null) {
        return undefined;
      }
      const milliseconds = Number(duration[1]) * { ms: 1, s: 1000, m: 60_000 }[duration[2] ?? "s"];
      options.timeoutMs = milliseconds === 0 ? undefined : milliseconds;
    } else if (argument.startsWith("-")) {
      return undefined;
    } else {
      positional.push(argument);
    }
  }
  const [kind, name, ...rest] = positional;
  if (
    options.output !== "json" ||
    kind === undefined ||
    kind.includes(",") ||
    kind.includes("/") ||
    rest.length > 0 ||
    (name !== undefined && (options.allNamespaces || query.size > 0))
  ) {
    return undefined;
  }
  return { kind, name, query, ...options };
}

// kubectl's stdout for `args`, read from the API server, or undefined when
// kubectl has to answer (see the top of this file). Throws as kubectl fails.
// `timeoutMs` bounds the read as --request-timeout does; the shorter of the two applies.
export async function kubectlGetJson(selection, args, { signal, timeoutMs } = {}) {
  const get = plainGet(args);
  if (get === undefined) {
    return undefined;
  }
  const reader = await raceSignal(readerFor(selection), signal);
  if (reader === undefined) {
    return undefined;
  }
  const { namespace: defaultNamespace, read, resolve } = reader;
  // A kind discovery does not know, or discovery that failed, is kubectl's to answer.
  const resource = await raceSignal(
    resolve(get.kind).catch(() => undefined),
    signal,
  );
  if (resource === undefined) {
    return undefined;
  }
  const namespace =
    resource.namespaced && !get.allNamespaces ? (get.namespace ?? defaultNamespace) : undefined;
  const path =
    `${resource.prefix}/${namespace === undefined ? "" : `namespaces/${encodeURIComponent(namespace)}/`}` +
    `${resource.plural}${get.name === undefined ? "" : `/${encodeURIComponent(get.name)}`}` +
    `${get.query.size > 0 ? `?${get.query}` : ""}`;
  const limits = [timeoutMs, get.timeoutMs].filter((limit) => limit !== undefined);
  const options = { signal, timeoutMs: limits.length > 0 ? Math.min(...limits) : undefined };
  const notFound = (error) => /^Error from server \(NotFound\)/.test(error?.stderr ?? "");
  const startedAt = Date.now();
  const body = await read(path, args, options).catch(async (error) => {
    // A named object kubectl does not find, outside the default Namespace: when
    // its Namespace is missing too, kubectl reports that instead. Any other
    // answer to that second read leaves the first error, as in kubectl.
    if (
      namespace !== undefined &&
      namespace !== "default" &&
      get.name !== undefined &&
      notFound(error)
    ) {
      // Within what is left of the read's timeout, as one kubectl run.
      const timeLeft =
        options.timeoutMs === undefined
          ? undefined
          : Math.max(1, options.timeoutMs - (Date.now() - startedAt));
      await read(`/api/v1/namespaces/${encodeURIComponent(namespace)}`, args, {
        signal,
        timeoutMs: timeLeft,
      }).catch((namespaceError) => {
        if (signal?.aborted || notFound(namespaceError)) {
          throw namespaceError;
        }
      });
    }
    throw error;
  });
  if (get.name !== undefined) {
    return printed(withoutManagedFields(body));
  }
  return printed({
    apiVersion: "v1",
    items: (body.items ?? []).map((item) => ({
      apiVersion: resource.groupVersion,
      kind: resource.kind,
      ...withoutManagedFields(item),
    })),
    kind: "List",
    metadata: { resourceVersion: "" },
  });
}

// Waits for `promise`, or rejects with the signal's AbortError first.
function raceSignal(promise, signal) {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    promise.catch(() => {});
    throw signal.reason;
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

// An API object as kubectl prints it: its own metadata.managedFields left out
// (only the object's, not a field of the same name deeper in it).
function withoutManagedFields(object) {
  if (object?.metadata?.managedFields === undefined) {
    return object;
  }
  const { managedFields: _managedFields, ...metadata } = object.metadata;
  return { ...object, metadata };
}

// The text `kubectl get -o json` prints for an object: Go's json.MarshalIndent
// of it with four spaces (keys sorted; <, >, & and the line separators
// escaped), and a newline.
function printed(object) {
  const sorted = (value) => {
    if (Array.isArray(value)) {
      return value.map((entry) => sorted(entry));
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sorted(value[key]);
    }
    return result;
  };
  const escapes = {
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };
  return `${JSON.stringify(sorted(object), null, 4).replace(/[<>&\u2028\u2029]/g, (character) => escapes[character])}\n`;
}

// A kubectl-shaped failure: execFile's error for a command that exited 1.
function kubectlError(args, stderr) {
  return Object.assign(new Error(`Command failed: kubectl ${args.join(" ")}\n${stderr}`), {
    code: 1,
    stdout: "",
    stderr,
  });
}

// What kubectl prints for an answer that is not a Kubernetes Status, as its
// client turns the HTTP code into one.
function unstructuredStatus(statusCode, text) {
  const known = {
    400: ["BadRequest", "the server rejected our request for an unknown reason"],
    401: ["Unauthorized", "the server has asked for the client to provide credentials"],
    403: ["Forbidden", "the server does not allow access to the requested resource"],
    404: ["NotFound", "the server could not find the requested resource"],
    405: ["MethodNotAllowed", "the server does not allow this method on the requested resource"],
    409: ["Conflict", "the server reported a conflict"],
    410: ["Expired", "the server reported the request has expired"],
    413: ["RequestEntityTooLarge", "the server has rejected the request because it is too large"],
    415: ["UnsupportedMediaType", "the server responded with the status code 415"],
    422: ["Invalid", "the server rejected our request due to an error in our request"],
    429: [
      "TooManyRequests",
      "the server has received too many requests and has asked us to try again later",
    ],
    500: [
      "InternalError",
      `an error on the server (${JSON.stringify(text.trim().slice(0, 1024))}) has prevented the request from succeeding`,
    ],
    503: ["ServiceUnavailable", "the server is currently unable to handle the request"],
    504: [
      "Timeout",
      "the server was unable to return a response in the time allotted, but may still be processing the request",
    ],
  };
  const [reason, message] =
    known[statusCode] ??
    (statusCode >= 500
      ? known[500]
      : [
          "Unknown",
          `the server responded with the status code ${statusCode} but did not return more information`,
        ]);
  return { reason, message };
}

async function createReader(kubeconfigPath, kubernetesContext) {
  let stdout;
  try {
    ({ stdout } = await execute(
      "kubectl",
      [
        "--kubeconfig",
        kubeconfigPath,
        "--context",
        kubernetesContext,
        "config",
        "view",
        "--minify",
        "--flatten",
        "-o",
        "json",
      ],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
    ));
  } catch (error) {
    throw Object.assign(new Error("kubectl config view failed", { cause: error }), {
      unreadConfiguration: true,
    });
  }
  const configuration = JSON.parse(stdout);
  const cluster = configuration.clusters?.[0]?.cluster ?? {};
  const user = configuration.users?.[0]?.user ?? {};
  const context = configuration.contexts?.[0]?.context ?? {};
  const decode = (value) => (value === undefined ? undefined : Buffer.from(value, "base64"));
  const server = cluster.server === undefined ? undefined : new URL(cluster.server);
  const certificate = decode(user["client-certificate-data"]);
  const key = decode(user["client-key-data"]);
  const token = user.token;
  if (
    server?.protocol !== "https:" ||
    cluster["certificate-authority-data"] === undefined ||
    Object.keys(cluster).some(
      (name) => !["server", "certificate-authority-data", "tls-server-name"].includes(name),
    ) ||
    ((certificate === undefined || key === undefined) && token === undefined) ||
    Object.keys(user).some(
      (name) => !["client-certificate-data", "client-key-data", "token"].includes(name),
    )
  ) {
    return undefined;
  }
  const agent = new Agent({
    keepAlive: true,
    timeout: idleConnectionMs,
    ca: decode(cluster["certificate-authority-data"]),
    cert: certificate,
    key,
    servername: cluster["tls-server-name"],
  });
  const base = server.pathname.replace(/\/$/, "");

  // One GET: { statusCode, headers, text }, or a rejection for the transport.
  const exchange = (path, { signal, deadlineAt }) =>
    new Promise((resolve, reject) => {
      const call = request(
        {
          agent,
          protocol: server.protocol,
          hostname: server.hostname.replace(/^\[(.*)\]$/, "$1"),
          port: server.port,
          path: `${base}${path}`,
          method: "GET",
          headers: {
            accept: "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          signal,
          timeout: requestTimeoutMs,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", (error) =>
            reject(Object.assign(error, { reused: call.reusedSocket })),
          );
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      // A timeout settles the read first, so the reset it causes mid-body is
      // not taken for a dropped connection and retried.
      const timedOut = (message) => {
        const error = Object.assign(new Error(message), { code: "ETIMEDOUT" });
        reject(error);
        call.destroy(error);
      };
      call.on("timeout", () => timedOut("i/o timeout"));
      const deadline =
        deadlineAt === undefined
          ? undefined
          : setTimeout(
              () => timedOut("context deadline exceeded (Client.Timeout exceeded)"),
              Math.max(0, deadlineAt - Date.now()),
            );
      call.on("close", () => clearTimeout(deadline));
      call.on("error", (error) => reject(Object.assign(error, { reused: call.reusedSocket })));
      call.end();
    });

  // A GET as kubectl's client makes it: retried on a dropped connection and on
  // a 429 or 5xx with Retry-After, within the read's timeout.
  const read = async (path, args, { signal, timeoutMs } = {}) => {
    signal?.throwIfAborted();
    const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const left = () => (deadlineAt === undefined ? Infinity : deadlineAt - Date.now());
    for (let attempt = 0; ; attempt += 1) {
      let answer;
      try {
        // A retry waits only within the read's timeout, and none starts after it.
        if (attempt > 0 && left() <= 0) {
          throw Object.assign(new Error("context deadline exceeded (Client.Timeout exceeded)"), {
            code: "ETIMEDOUT",
          });
        }
        answer = await exchange(path, { signal, deadlineAt });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw error;
        }
        const dropped =
          ["ECONNRESET", "EPIPE"].includes(error.code) || /socket hang up/.test(error.message);
        if (dropped && attempt < maxRetries && left() > 0) {
          // A kept-alive connection the server closed is retried at once.
          if (!error.reused) {
            await delay(Math.min(1_000, left()), undefined, { signal });
          }
          continue;
        }
        throw kubectlError(
          args,
          `Unable to connect to the server: ${error.code ?? ""} ${error.message}\n`,
        );
      }
      const { statusCode, headers, text } = answer;
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (statusCode >= 200 && statusCode < 300 && body !== undefined) {
        return body;
      }
      const retryAfter = Number(headers["retry-after"]);
      const pause = Math.min(retryAfter, 10) * 1000;
      if (
        (statusCode === 429 || statusCode >= 500) &&
        Number.isInteger(retryAfter) &&
        attempt < maxRetries &&
        pause < left()
      ) {
        await delay(pause, undefined, { signal });
        continue;
      }
      // kubectl prints an API Status as "Error from server (Reason): message".
      const status = body?.kind === "Status" ? body : unstructuredStatus(statusCode, text);
      throw kubectlError(
        args,
        status.reason
          ? `Error from server (${status.reason}): ${status.message}\n`
          : `Error from server: ${status.message}\n`,
      );
    }
  };

  // Discovery, shared by every caller of this reader and bounded by its own
  // deadline, not a caller's: core resources first, then each API group's
  // preferred version, the order kubectl resolves a resource name in.
  const discover = async () => {
    const discovery = ["discovery"];
    const options = { timeoutMs: requestTimeoutMs };
    const resources = [];
    const add = (prefix, groupVersion, group, list) => {
      for (const entry of list.resources ?? []) {
        if (!entry.name.includes("/") && entry.verbs?.includes("get")) {
          resources.push({ ...entry, prefix, groupVersion, group, plural: entry.name });
        }
      }
    };
    add("/api/v1", "v1", "", await read("/api/v1", discovery, options));
    const groups = await read("/apis", discovery, options);
    // An unavailable aggregated API leaves out its group, as kubectl does.
    const lists = await Promise.all(
      (groups.groups ?? []).map(async ({ name, preferredVersion }) => ({
        name,
        groupVersion: preferredVersion.groupVersion,
        list: await read(`/apis/${preferredVersion.groupVersion}`, discovery, options).catch(
          () => ({}),
        ),
      })),
    );
    for (const { name, groupVersion, list } of lists) {
      add(`/apis/${groupVersion}`, groupVersion, name, list);
    }
    return resources;
  };
  let discovered;
  let discoveredAt = 0;
  const rediscover = () => {
    discoveredAt = Date.now();
    discovered = discover();
    // A failed discovery is tried again by the next read.
    discovered.catch(() => (discoveredAt = 0));
    return discovered;
  };
  const find = (resources, kind) => {
    const lower = kind.toLowerCase();
    const dot = lower.indexOf(".");
    const name = dot === -1 ? lower : lower.slice(0, dot);
    const group = dot === -1 ? undefined : lower.slice(dot + 1);
    return resources.find(
      (entry) =>
        (group === undefined || entry.group === group) &&
        (entry.plural === name ||
          entry.singularName === name ||
          entry.kind.toLowerCase() === name ||
          entry.shortNames?.includes(name)),
    );
  };
  const resolve = async (kind) => {
    if (discovered === undefined || discoveredAt === 0) {
      rediscover();
    }
    const found = find(await discovered, kind);
    // A kind registered since (a CRD a test installed) is looked up again, now and then.
    if (found === undefined && Date.now() - discoveredAt >= rediscoveryMs) {
      return find(await rediscover(), kind);
    }
    return found;
  };
  return { namespace: context.namespace ?? "default", read, resolve };
}
