import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { get } from "node:http";
import { basename, dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const NAMESPACE = "openclaw.dev/namespace";
const AGENT = "openclaw.dev/agent";
const REVISION = "openclaw.dev/revision";
const ROLE = "openclaw.dev/workload-role";
const BOX_COMPONENT = "box.openclaw.dev/component";
const BOX_EXECUTION = "box.openclaw.dev/execution";
const BOX_REQUIREMENTS = "box.openclaw.dev/requirements-sha256";
const SHA256 = /^[a-f0-9]{64}$/;
const LABEL_VALUE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export interface HostConfig {
  readonly kubeContext: string;
  readonly namespace: string;
  readonly namespaceId: string;
  readonly namespaceUid: string;
  readonly agentId: string;
  readonly hostSocketPath: string;
  readonly hostUid?: number;
  readonly previousRevisionId: string;
  readonly driverId: string;
  readonly implementation: string;
}

export type HostObservation =
  | { readonly state: "pending" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly generationSha256: string };

interface HostStatus {
  readonly executionId: string;
  readonly requirementsDigest: string;
  readonly observation: HostObservation;
}

type ObjectFields = Record<string, unknown>;

function object(value: unknown): ObjectFields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw Error("WARM_RETRY_OBSERVATION_INVALID");
  }
  return value as ObjectFields;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function namesIn(fields: readonly string[], expected: string): boolean {
  return fields.length === 1 && fields[0] === expected;
}

function isPrivate(stat: BigIntStats, mode: bigint, uid: bigint): boolean {
  return stat.uid === uid && (stat.mode & 0o7777n) === mode;
}

async function readSocket(
  socketPath: string,
  timeout: number,
): Promise<{ status: number; body: unknown }> {
  try {
    return await new Promise((resolve, reject) => {
      get(
        { socketPath, path: "/v1/execution", agent: false, signal: AbortSignal.timeout(timeout) },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("error", reject);
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32768) {
              response.destroy(Error("WARM_RETRY_HOST_RESPONSE_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              if (
                response.statusCode === undefined ||
                !["application/json", "application/json; charset=utf-8"].includes(
                  response.headers["content-type"] ?? "",
                )
              ) {
                throw Error("WARM_RETRY_HOST_RESPONSE_INVALID");
              }
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              resolve({ status: response.statusCode, body });
            } catch (error) {
              reject(error);
            }
          });
        },
      ).on("error", reject);
    });
  } catch {
    throw Error("WARM_RETRY_HOST_UNAVAILABLE");
  }
}

export class Host {
  private readonly config: HostConfig;
  private readonly hostUid: bigint;
  private readonly remaining: () => number;

  constructor(config: HostConfig, remaining: () => number = () => Infinity) {
    const processUid = process.getuid?.();
    const hostUid = config.hostUid ?? processUid;
    if (
      processUid === undefined ||
      hostUid === undefined ||
      !Number.isSafeInteger(hostUid) ||
      hostUid < 1 ||
      hostUid > 0xfffffffe ||
      (processUid !== 0 && hostUid !== processUid) ||
      !config.kubeContext ||
      config.kubeContext.length > 256 ||
      config.kubeContext.startsWith("-") ||
      /[\x00-\x1f\x7f]/.test(config.kubeContext) ||
      !DNS_LABEL.test(config.namespace) ||
      !UUID.test(config.namespaceUid) ||
      !LABEL_VALUE.test(config.namespaceId) ||
      !LABEL_VALUE.test(config.agentId) ||
      !LABEL_VALUE.test(config.previousRevisionId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.driverId) ||
      !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(
        config.implementation,
      ) ||
      !isAbsolute(config.hostSocketPath) ||
      Buffer.byteLength(config.hostSocketPath) > 107 ||
      basename(config.hostSocketPath) !== "control.sock" ||
      basename(dirname(config.hostSocketPath)) !== "worker-control"
    ) {
      throw Error("WARM_RETRY_HOST_CONFIG_INVALID");
    }
    this.config = { ...config };
    this.remaining = remaining;
    this.hostUid = BigInt(hostUid);
  }

  async preflight(): Promise<string> {
    // The empty Host response binds the socket, not its configuration. The
    // operator must already have checked the held profile and Worker mount.
    const fingerprint = await this.socketFingerprint(true);
    await this.execution(fingerprint);
    await this.namespace();
    if ((await this.workloads()).length !== 0) {
      throw Error("WARM_RETRY_AGENT_WORKLOAD_REMAINS");
    }
    await this.namespace();
    await this.execution(fingerprint);
    return fingerprint;
  }

  async observe(revisionId: string, fingerprint: string): Promise<HostObservation> {
    if (
      !LABEL_VALUE.test(revisionId) ||
      revisionId === this.config.previousRevisionId ||
      !SHA256.test(fingerprint)
    ) {
      throw Error("WARM_RETRY_OBSERVATION_IDENTITY_INVALID");
    }
    await this.namespace();
    const host = await this.execution(fingerprint, revisionId);
    if (host?.observation.state === "failed") {
      return host.observation;
    }
    const workloads = await this.workloads();
    const gateway: boolean[] = [];
    const relay: boolean[] = [];
    for (const workload of workloads) {
      const metadata = object(workload.metadata);
      const labels = object(metadata.labels);
      // The Gateway Deployment carries its revision on the Pod template; relay
      // Deployments and both kinds of Pod carry it in their own labels.
      if (workload.kind === "Deployment") {
        const template = object(object(workload.spec).template);
        const podLabels = object(object(template.metadata).labels);
        if (
          podLabels[NAMESPACE] !== this.config.namespaceId ||
          podLabels[AGENT] !== this.config.agentId ||
          podLabels[REVISION] !== revisionId ||
          (labels[REVISION] !== undefined && labels[REVISION] !== revisionId)
        ) {
          throw Error("WARM_RETRY_WORKLOAD_OWNER_CHANGED");
        }
        continue;
      }
      if (labels[REVISION] !== revisionId) {
        throw Error("WARM_RETRY_WORKLOAD_OWNER_CHANGED");
      }
      const status = workload.status === undefined ? {} : object(workload.status);
      const conditions = status.conditions ?? [];
      if (!Array.isArray(conditions)) {
        throw Error("WARM_RETRY_OBSERVATION_INVALID");
      }
      const ready = conditions.map(object).filter((condition) => condition.type === "Ready");
      if (ready.length > 1) {
        throw Error("WARM_RETRY_OBSERVATION_INVALID");
      }
      const serving =
        metadata.deletionTimestamp === undefined &&
        status.phase === "Running" &&
        ready[0]?.status === "True";
      if (labels[ROLE] === "gateway") {
        gateway.push(serving);
      } else if (labels[ROLE] === "agent" && labels[BOX_COMPONENT] === "harness-relay") {
        if (host !== undefined) {
          const annotations = object(metadata.annotations);
          if (
            annotations[BOX_EXECUTION] !== host.executionId ||
            annotations[BOX_REQUIREMENTS] !== host.requirementsDigest
          ) {
            throw Error("WARM_RETRY_WORKLOAD_OWNER_CHANGED");
          }
        }
        relay.push(serving);
      } else {
        throw Error("WARM_RETRY_WORKLOAD_OWNER_CHANGED");
      }
    }
    if (
      host?.observation.state !== "ready" ||
      gateway.length !== 1 ||
      gateway[0] !== true ||
      relay.length !== 1 ||
      relay[0] !== true
    ) {
      return { state: "pending" };
    }
    await this.namespace();
    const after = await this.execution(fingerprint, revisionId);
    if (
      after?.executionId !== host.executionId ||
      after.requirementsDigest !== host.requirementsDigest ||
      after.observation.state === "pending" ||
      (after.observation.state === "ready" &&
        after.observation.generationSha256 !== host.observation.generationSha256)
    ) {
      throw Error("WARM_RETRY_HOST_CHANGED");
    }
    return after.observation;
  }

  private async socketFingerprint(fresh = false): Promise<string> {
    const { hostSocketPath } = this.config;
    const directory = dirname(hostSocketPath);
    const runtime = dirname(directory);
    try {
      const [socket, exported, parent] = await Promise.all(
        [hostSocketPath, directory, runtime].map((path) => lstat(path, { bigint: true })),
      );
      if (
        socket === undefined ||
        exported === undefined ||
        parent === undefined ||
        !socket.isSocket() ||
        !isPrivate(socket, 0o600n, this.hostUid) ||
        !exported.isDirectory() ||
        !isPrivate(exported, 0o700n, this.hostUid) ||
        !parent.isDirectory() ||
        !isPrivate(parent, 0o700n, this.hostUid) ||
        (await realpath(hostSocketPath)) !== hostSocketPath ||
        !namesIn(await readdir(directory), "control.sock") ||
        (fresh && !namesIn(await readdir(runtime), "worker-control"))
      ) {
        throw Error("WARM_RETRY_HOST_SOCKET_INVALID");
      }
      // Runtime state files can change directory timestamps after deployment.
      return createHash("sha256")
        .update(
          [
            parent.dev,
            parent.ino,
            exported.dev,
            exported.ino,
            socket.dev,
            socket.ino,
            socket.ctimeNs,
          ].join(":"),
        )
        .digest("hex");
    } catch {
      throw Error("WARM_RETRY_HOST_SOCKET_INVALID");
    }
  }

  private async execution(
    fingerprint: string,
    revisionId?: string,
  ): Promise<HostStatus | undefined> {
    if ((await this.socketFingerprint()) !== fingerprint) {
      throw Error("WARM_RETRY_HOST_CHANGED");
    }
    const { status, body } = await readSocket(
      this.config.hostSocketPath,
      Math.min(5000, this.remaining()),
    );
    if ((await this.socketFingerprint(revisionId === undefined)) !== fingerprint) {
      throw Error("WARM_RETRY_HOST_CHANGED");
    }
    const view = object(body);
    if (status === 404 && view.error === "execution_absent") {
      return undefined;
    }
    if (status !== 200) {
      throw Error("WARM_RETRY_HOST_UNAVAILABLE");
    }
    if (revisionId === undefined) {
      throw Error("WARM_RETRY_HOST_OCCUPIED");
    }
    const owner = object(view.owner);
    if (
      owner.namespaceName !== this.config.namespace ||
      owner.namespaceId !== this.config.namespaceId ||
      owner.agentId !== this.config.agentId ||
      owner.revisionId !== revisionId ||
      owner.driverId !== this.config.driverId ||
      owner.implementation !== this.config.implementation
    ) {
      throw Error("WARM_RETRY_HOST_OWNER_CHANGED");
    }
    if (
      !matches(view.executionId, /^[A-Za-z0-9_.:-]{1,128}$/) ||
      !matches(view.requirementsDigest, SHA256)
    ) {
      throw Error("WARM_RETRY_OBSERVATION_INVALID");
    }
    if (
      view.repositoryRecipient !== undefined ||
      view.protectedStartup !== undefined ||
      view.harnessModel !== undefined
    ) {
      throw Error("WARM_RETRY_HOST_PROFILE_REFUSED");
    }
    let observation: HostObservation;
    if (view.state === "starting") {
      observation = { state: "pending" };
    } else if (view.state === "failed") {
      observation = { state: "failed" };
    } else if (
      view.state === "running" &&
      view.workspaceNodeMode === "file-only-v1" &&
      matches(view.generationSha256, SHA256)
    ) {
      observation = { state: "ready", generationSha256: view.generationSha256 };
    } else {
      throw Error("WARM_RETRY_OBSERVATION_INVALID");
    }
    return {
      executionId: view.executionId,
      requirementsDigest: view.requirementsDigest,
      observation,
    };
  }

  private async kubectl(args: readonly string[]): Promise<ObjectFields> {
    const timeout = Math.min(7500, this.remaining());
    try {
      const result = await execute(
        "kubectl",
        [
          "--context",
          this.config.kubeContext,
          "--namespace",
          this.config.namespace,
          "--request-timeout=5s",
          "get",
          ...args,
          "-o",
          "json",
        ],
        { timeout, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" },
      );
      return object(JSON.parse(result.stdout) as unknown);
    } catch {
      throw Error("WARM_RETRY_KUBERNETES_UNAVAILABLE");
    }
  }

  private async namespace(): Promise<void> {
    const resource = await this.kubectl(["namespace", this.config.namespace]);
    const metadata = object(resource.metadata);
    if (
      resource.apiVersion !== "v1" ||
      resource.kind !== "Namespace" ||
      metadata.name !== this.config.namespace ||
      metadata.uid !== this.config.namespaceUid ||
      metadata.deletionTimestamp !== undefined ||
      object(metadata.labels)[NAMESPACE] !== this.config.namespaceId ||
      object(metadata.annotations)["openclaw.dev/namespace-id"] !== this.config.namespaceId ||
      object(resource.status).phase !== "Active"
    ) {
      throw Error("WARM_RETRY_NAMESPACE_CHANGED");
    }
  }

  private async workloads(): Promise<ObjectFields[]> {
    const list = await this.kubectl([
      "pods,deployments",
      "--selector",
      AGENT + "=" + this.config.agentId,
    ]);
    const meta = object(list.metadata);
    if (
      list.apiVersion !== "v1" ||
      list.kind !== "List" ||
      !Array.isArray(list.items) ||
      (meta.continue !== undefined && meta.continue !== "") ||
      (meta.remainingItemCount !== undefined && meta.remainingItemCount !== 0)
    ) {
      throw Error("WARM_RETRY_OBSERVATION_INVALID");
    }
    const items = list.items.map(object);
    for (const item of items) {
      const metadata = object(item.metadata);
      const labels = object(metadata.labels);
      if (
        !(
          (item.kind === "Pod" && item.apiVersion === "v1") ||
          (item.kind === "Deployment" && item.apiVersion === "apps/v1")
        ) ||
        metadata.namespace !== this.config.namespace ||
        !matches(metadata.name, /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/) ||
        !matches(metadata.uid, UUID) ||
        labels[NAMESPACE] !== this.config.namespaceId ||
        labels[AGENT] !== this.config.agentId
      ) {
        throw Error("WARM_RETRY_WORKLOAD_OWNER_CHANGED");
      }
    }
    return items;
  }
}
