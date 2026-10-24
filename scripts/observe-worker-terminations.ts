import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

// Operator-side observer: credentials and raw API responses never enter OTLP.
type ObjectValue = Record<string, unknown>;
type Fields = Record<string, string | number>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const exec = promisify(execFile);

async function main() {
  const [context, namespace, release, outputPath, ...extra] = process.argv.slice(2);
  if (!context || !identifier(namespace) || !identifier(release) || !outputPath || extra.length) {
    throw new Error("usage");
  }
  if (["?", "*", "[", "]", "{", "}"].some((symbol) => outputPath.includes(symbol))) {
    throw new Error("private-file");
  }
  const releaseNamespace = namespace;
  const directory = dirname(resolve(outputPath));
  const owner = await lstat(directory);
  if (
    !owner.isDirectory() ||
    owner.uid !== process.getuid?.() ||
    (owner.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error("private-directory");
  }
  const output = await open(
    resolve(outputPath),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const file = await output.stat();
  if (
    !file.isFile() ||
    file.uid !== owner.uid ||
    (file.mode & 0o777) !== 0o600 ||
    file.nlink !== 1
  ) {
    await output.close();
    throw new Error("private-file");
  }
  const labels = {
    "app.kubernetes.io/name": "openclaw-enterprise",
    "app.kubernetes.io/instance": release,
    "app.kubernetes.io/component": "worker",
  };
  const query = new URLSearchParams({
    labelSelector: Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(","),
  });
  const path = `/api/v1/namespaces/${namespace}/pods`;
  const args = ["--context", context];
  const states = new Map<
    string,
    { count: number | undefined; lastCount: number | undefined; seen: Map<string, number> }
  >();

  async function send(event: string, fields: Fields) {
    if ((await output.stat()).size >= 64 * 1024 * 1024) {
      throw new Error("capacity");
    }
    await output.writeFile(
      JSON.stringify({ stream: "oce.worker-terminations.v1", event, fields }) + "\n",
    );
    await output.sync();
  }

  async function observe(value: unknown, deleted = false) {
    const pod = object(value);
    const metadata = object(pod.metadata);
    const podLabels = object(metadata.labels);
    if (
      (pod.kind !== undefined && pod.kind !== "Pod") ||
      metadata.namespace !== namespace ||
      !Object.entries(labels).every(([key, expected]) => podLabels[key] === expected)
    ) {
      return;
    }
    const uid = metadata.uid;
    if (
      typeof uid !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(uid) ||
      !identifier(metadata.name)
    ) {
      return;
    }
    const spec = object(pod.spec);
    const normal = array(spec.containers).some((v) => object(v).name === "worker");
    const sidecar = array(spec.initContainers).some(
      (v) => object(v).name === "worker" && object(v).restartPolicy === "Always",
    );
    if (!normal && !sidecar) {
      return;
    }
    const status = object(pod.status);
    const container = object(
      array(normal ? status.containerStatuses : status.initContainerStatuses).find(
        (v) => object(v).name === "worker",
      ),
    );
    const count = integer(container.restartCount) ? container.restartCount : undefined;
    const prior = states.get(uid);
    if (!prior && states.size >= 1024) {
      throw new Error("capacity");
    }
    const reset = count !== undefined && prior?.lastCount !== undefined && count < prior.lastCount;
    const seen = reset ? new Map<string, number>() : (prior?.seen ?? new Map<string, number>());
    const previouslySeen = [...seen.values()];
    const identity: Fields = {
      "k8s.namespace.name": releaseNamespace,
      "k8s.pod.name": metadata.name,
      "k8s.pod.uid": uid,
      "k8s.container.name": "worker",
      "oce.container.kind": normal ? "container" : "restartable-init",
    };
    const retained = new Set(previouslySeen);
    for (const [state, incarnation] of [
      [object(container.lastState), count === undefined || count === 0 ? undefined : count - 1],
      [object(container.state), count],
    ] as const) {
      const terminated = object(state.terminated);
      if (
        incarnation === undefined ||
        typeof terminated.exitCode !== "number" ||
        !Number.isInteger(terminated.exitCode) ||
        terminated.exitCode < -2147483648 ||
        terminated.exitCode > 2147483647 ||
        typeof terminated.finishedAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(terminated.finishedAt)
      ) {
        continue;
      }
      const fields: Fields = {
        ...identity,
        "oce.restart.incarnation": incarnation,
        "oce.termination.exit_code": terminated.exitCode,
        "oce.termination.finished_at": terminated.finishedAt,
      };
      // Never borrow containerID/imageID from the replacement ContainerStatus.
      if (
        typeof terminated.containerID === "string" &&
        /^(containerd|cri-o|docker):\/\/[a-f0-9]{64}$/.test(terminated.containerID)
      ) {
        fields["oce.termination.container_id"] = terminated.containerID;
      }
      if (
        typeof terminated.reason === "string" &&
        [
          "Completed",
          "Error",
          "OOMKilled",
          "ContainerCannotRun",
          "StartError",
          "ContainerStatusUnknown",
        ].includes(terminated.reason)
      ) {
        fields["oce.termination.reason"] = terminated.reason;
      }
      if (integer(terminated.signal) && terminated.signal > 0 && terminated.signal <= 127) {
        fields["oce.termination.signal"] = terminated.signal;
      }
      const id = createHash("sha256")
        .update(
          JSON.stringify([uid, "worker", incarnation, terminated.finishedAt, terminated.exitCode]),
        )
        .digest("hex");
      retained.add(incarnation);
      if (!seen.has(id)) {
        await send("worker.termination.observed", { ...fields, "oce.observation.id": id });
        seen.set(id, incarnation);
      }
    }
    if (!prior || prior.count !== count) {
      const missing =
        count === undefined || reset
          ? undefined
          : Math.max(
              0,
              count -
                (prior?.lastCount ?? 0) -
                [...retained].filter((n) => n >= (prior?.lastCount ?? 0) && n < count).length,
            );
      await send("worker.observation.coverage", {
        ...identity,
        "oce.observation.state":
          count === undefined
            ? "unavailable"
            : reset
              ? "counter-reset"
              : prior
                ? "changed"
                : "baseline",
        ...(count === undefined ? {} : { "k8s.container.restart_count": count }),
        ...(missing === undefined ? {} : { "oce.observation.missing_terminations_min": missing }),
      });
    }
    // Keep enough recent IDs for current -> lastState deduplication, bounded per Pod.
    while (seen.size > 4) {
      seen.delete(seen.keys().next().value!);
    }
    states.set(uid, { count, lastCount: count ?? prior?.lastCount, seen });
    if (deleted) {
      states.delete(uid);
    }
  }

  const { stdout } = await exec(
    "kubectl",
    [...args, "--request-timeout=30s", "get", "--raw", `${path}?${query}&limit=500`],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const list = object(JSON.parse(stdout));
  const metadata = object(list.metadata);
  if (
    list.kind !== "PodList" ||
    !Array.isArray(list.items) ||
    metadata.continue ||
    typeof metadata.resourceVersion !== "string" ||
    metadata.resourceVersion.length === 0 ||
    metadata.resourceVersion.length > 256
  ) {
    throw new Error("list");
  }
  for (const pod of list.items) {
    await observe(pod);
  }
  query.set("watch", "true");
  query.set("resourceVersion", metadata.resourceVersion);
  const child = spawn(
    "kubectl",
    [...args, "--request-timeout=0", "get", "--raw", `${path}?${query}`],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let spawnFailed = false;
  child.on("error", () => {
    spawnFailed = true;
  });
  const stop = () => child.kill();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    child.stdout.setEncoding("utf8");
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += chunk;
      if (pending.length > 8 * 1024 * 1024) {
        throw new Error("capacity");
      }
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) {
          continue;
        }
        const event = object(JSON.parse(line));
        if (!["ADDED", "MODIFIED", "DELETED"].includes(String(event.type))) {
          throw new Error("watch");
        }
        await observe(event.object, event.type === "DELETED");
      }
    }
    throw new Error(spawnFailed ? "kubectl" : "watch-ended");
  } finally {
    stop();
    await output.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

main().catch((error: unknown) => {
  // API errors and subprocess stderr may contain credentials or raw payloads.
  const codes = [
    "usage",
    "private-directory",
    "private-file",
    "capacity",
    "list",
    "kubectl",
    "watch",
    "watch-ended",
  ];
  const code =
    error instanceof Error && codes.includes(error.message) ? error.message : "read-or-transport";
  process.stderr.write(
    `Worker observation stopped (${code}); coverage is incomplete. Check context, Pod read access, private output file and command arguments.\n`,
  );
  process.exitCode = 1;
});
