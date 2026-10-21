// Answers `kubectl get ... -o json` from the API server in this process. Real
// k3d tests read the cluster hundreds of times per file, most often in loops
// that wait for a Pod, a Deployment or an endpoint; each read used to start a
// kubectl process (about 0.1 CPU-s). Here a read is one request on a kept-alive
// HTTPS connection. The answer is the JSON kubectl prints: the object itself,
// or a `List` whose items carry their apiVersion and kind. A failure reads like
// kubectl's (`Error from server (NotFound): ...` on stderr; transport failures
// as "Unable to connect to the server"), so callers that match kubectl's errors
// or retry its transient failures behave the same.
//
// Only plain reads are served: one resource kind, an optional name, and the
// namespace, label selector, field selector, all-namespaces and request-timeout
// flags. Anything
// else, and a kubeconfig whose credentials are not a client certificate or a
// bearer token, returns undefined, and the caller runs kubectl.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Agent, request } from "node:https";
import { promisify } from "node:util";

const execute = promisify(execFile);
const requestTimeoutMs = 60_000;

// One reader per kubeconfig and context.
const readers = new Map();

function readerFor({ kubeconfigPath, kubernetesContext }) {
  const key = `${kubeconfigPath}\0${kubernetesContext}`;
  if (!readers.has(key)) {
    readers.set(key, createReader(kubeconfigPath, kubernetesContext));
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
  const reader = await readerFor(selection);
  if (reader === undefined) {
    return undefined;
  }
  // A kind discovery does not know, or discovery that failed, is kubectl's to answer.
  const resource = await reader.resolve(get.kind, signal).catch((error) => {
    if (error?.name === "AbortError") {
      throw error;
    }
    return undefined;
  });
  if (resource === undefined) {
    return undefined;
  }
  const namespace =
    resource.namespaced && !get.allNamespaces ? (get.namespace ?? reader.namespace) : undefined;
  const path =
    `${resource.prefix}/${namespace === undefined ? "" : `namespaces/${encodeURIComponent(namespace)}/`}` +
    `${resource.plural}${get.name === undefined ? "" : `/${encodeURIComponent(get.name)}`}` +
    `${get.query.size > 0 ? `?${get.query}` : ""}`;
  const limits = [timeoutMs, get.timeoutMs].filter((limit) => limit !== undefined);
  const body = await reader.read(path, args, {
    signal,
    timeoutMs: limits.length > 0 ? Math.min(...limits) : undefined,
  });
  if (get.name !== undefined) {
    return `${JSON.stringify(body, null, 4)}\n`;
  }
  const list = {
    apiVersion: "v1",
    items: (body.items ?? []).map((item) => ({
      apiVersion: resource.groupVersion,
      kind: resource.kind,
      ...item,
    })),
    kind: "List",
    metadata: { resourceVersion: "" },
  };
  return `${JSON.stringify(list, null, 4)}\n`;
}

// A kubectl-shaped failure: execFile's error for a command that exited 1.
function kubectlError(args, stderr) {
  return Object.assign(new Error(`Command failed: kubectl ${args.join(" ")}\n${stderr}`), {
    code: 1,
    stdout: "",
    stderr,
  });
}

async function createReader(kubeconfigPath, kubernetesContext) {
  // Embedded credentials only, as k3d writes them. Anything else (a kubeconfig
  // that names certificate files, or none at all, as for a stand-in kubectl) is
  // kubectl's, without spending a kubectl run to find out.
  const text = await readFile(kubeconfigPath ?? "", "utf8").catch(() => "");
  if (!text.includes("certificate-authority-data")) {
    return undefined;
  }
  let configuration;
  try {
    const { stdout } = await execute(
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
      { maxBuffer: 4 * 1024 * 1024 },
    );
    configuration = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const cluster = configuration.clusters?.[0]?.cluster;
  const user = configuration.users?.[0]?.user ?? {};
  const context = configuration.contexts?.[0]?.context ?? {};
  const decode = (value) => (value === undefined ? undefined : Buffer.from(value, "base64"));
  const server = cluster?.server === undefined ? undefined : new URL(cluster.server);
  const certificate = decode(user["client-certificate-data"]);
  const key = decode(user["client-key-data"]);
  const token = user.token;
  if (
    server?.protocol !== "https:" ||
    cluster["certificate-authority-data"] === undefined ||
    ((certificate === undefined || key === undefined) && token === undefined) ||
    Object.keys(user).some(
      (name) => !["client-certificate-data", "client-key-data", "token"].includes(name),
    )
  ) {
    return undefined;
  }
  const agent = new Agent({
    keepAlive: true,
    ca: decode(cluster["certificate-authority-data"]),
    cert: certificate,
    key,
    servername: cluster["tls-server-name"],
  });
  const base = server.pathname.replace(/\/$/, "");

  const read = (path, args, { signal, timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const unreachable = (error) =>
        reject(
          kubectlError(
            args,
            `Unable to connect to the server: ${error.code ?? ""} ${error.message}\n`,
          ),
        );
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
          response.on("error", unreachable);
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            if (response.statusCode >= 200 && response.statusCode < 300 && body !== undefined) {
              resolve(body);
              return;
            }
            // kubectl prints the API's Status as "Error from server (Reason): message".
            const reason = body?.reason ?? `HTTP ${response.statusCode}`;
            const message = body?.message ?? text.trim();
            reject(kubectlError(args, `Error from server (${reason}): ${message}\n`));
          });
        },
      );
      call.on("timeout", () =>
        call.destroy(Object.assign(new Error("i/o timeout"), { code: "ETIMEDOUT" })),
      );
      const deadline =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () =>
                call.destroy(
                  Object.assign(
                    new Error(`context deadline exceeded (Client.Timeout ${timeoutMs} ms)`),
                    { code: "ETIMEDOUT" },
                  ),
                ),
              timeoutMs,
            );
      call.on("close", () => clearTimeout(deadline));
      call.on("error", (error) =>
        error.name === "AbortError" ? reject(error) : unreachable(error),
      );
      call.end();
    });

  // Discovery, read once per reader: core resources first, then each API group's
  // preferred version, the order kubectl resolves a resource name in.
  let discovered;
  const discover = async (signal) => {
    const discovery = ["discovery"];
    const resources = [];
    const add = (prefix, groupVersion, group, list) => {
      for (const entry of list.resources ?? []) {
        if (!entry.name.includes("/") && entry.verbs?.includes("get")) {
          resources.push({ ...entry, prefix, groupVersion, group, plural: entry.name });
        }
      }
    };
    add("/api/v1", "v1", "", await read("/api/v1", discovery, { signal }));
    const groups = await read("/apis", discovery, { signal });
    // An unavailable aggregated API leaves out its group, as kubectl does.
    const lists = await Promise.all(
      (groups.groups ?? []).map(async ({ name, preferredVersion }) => ({
        name,
        groupVersion: preferredVersion.groupVersion,
        list: await read(`/apis/${preferredVersion.groupVersion}`, discovery, { signal }).catch(
          (error) => {
            if (error?.name === "AbortError") {
              throw error;
            }
            return {};
          },
        ),
      })),
    );
    for (const { name, groupVersion, list } of lists) {
      add(`/apis/${groupVersion}`, groupVersion, name, list);
    }
    return resources;
  };
  const resolve = async (kind, signal) => {
    discovered ??= discover(signal).catch((error) => {
      discovered = undefined;
      throw error;
    });
    const resources = await discovered;
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
  return { namespace: context.namespace ?? "default", read, resolve };
}
