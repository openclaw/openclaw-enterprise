import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { CoordinationV1Api, V1MicroTime, type KubeConfig } from "@kubernetes/client-node";
import {
  ClusterResources,
  PLURALS,
  statusCode,
  type Resource,
  type ResourceKind,
} from "./cluster.ts";
import { OPERATOR_GROUP, OPERATOR_VERSION } from "./crds.ts";
import { AgentReconciler, ReconcilePending } from "./reconciler.ts";
import { EnterpriseRequestError } from "./enterprise-client.ts";

interface OperatorOptions {
  readonly configuration: KubeConfig;
  readonly namespace: string;
  readonly sourceClusterId: string;
  readonly leaseName: string;
  readonly identity?: string;
  readonly healthPort?: number;
}

/** Namespace-scoped controller; Agent effects use authenticated Enterprise APIs. */
export class KubernetesAgentOperator {
  private readonly cluster: ClusterResources;
  private readonly coordination: CoordinationV1Api;
  private readonly identity: string;
  private readonly pending = new Map<
    string,
    { kind: ResourceKind; name: string; due: number; attempt: number }
  >();
  private readonly seen = new Map<string, string>();
  private readonly watches = new Set<AbortController>();
  private readonly restartTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private readonly shutdown = new AbortController();
  private health: Server | undefined;
  private epoch: AbortController | undefined;
  private reconciler: AgentReconciler | undefined;
  private namespaceUid = "";
  private lastRenewed = 0;
  private lastContact = 0;
  private renewing = false;
  private processing = false;

  private readonly options: OperatorOptions;
  constructor(options: OperatorOptions) {
    this.options = options;

    this.cluster = new ClusterResources(options.configuration, options.namespace);
    this.coordination = options.configuration.makeApiClient(CoordinationV1Api);
    this.identity = options.identity ?? randomUUID();
  }

  private leading(): boolean {
    return (
      this.epoch !== undefined &&
      !this.epoch.signal.aborted &&
      Date.now() - this.lastRenewed < 20_000 &&
      !this.shutdown.signal.aborted
    );
  }

  private enqueue(kind: ResourceKind, name: string, attempt = 0): void {
    const key = `${kind}/${name}`;
    const due =
      Date.now() + (attempt === 0 ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    const previous = this.pending.get(key);
    if (previous === undefined || due < previous.due) {
      this.pending.set(key, { kind, name, due, attempt });
    }
  }

  private observe(resource: Resource): void {
    const key = `${resource.kind}/${resource.metadata.name}`;
    const identity = JSON.stringify([
      resource.metadata.uid,
      resource.metadata.generation,
      resource.metadata.deletionTimestamp,
      resource.metadata.finalizers,
    ]);
    // Ignore status-only changes, including this controller's own observations.
    if (this.seen.get(key) !== identity) {
      this.seen.set(key, identity);
      this.enqueue(resource.kind, resource.metadata.name);
    }
  }

  private async renew(): Promise<void> {
    if (this.renewing || this.shutdown.signal.aborted) {
      return;
    }
    this.renewing = true;
    let acquired = false;
    const name = this.options.leaseName;
    const namespace = this.options.namespace;
    try {
      let lease;
      try {
        lease = await this.coordination.readNamespacedLease({ name, namespace });
      } catch (error) {
        if (statusCode(error) !== 404) {
          throw error;
        }
      }
      if (lease === undefined) {
        await this.coordination.createNamespacedLease({
          namespace,
          body: {
            metadata: { name, labels: { "app.kubernetes.io/managed-by": "oce-operator" } },
            spec: {
              holderIdentity: this.identity,
              leaseDurationSeconds: 30,
              renewTime: new V1MicroTime(),
            },
          },
        });
        acquired = true;
        this.lastContact = Date.now();
      } else if (lease.metadata?.labels?.["app.kubernetes.io/managed-by"] === "oce-operator") {
        this.lastContact = Date.now();
        // The SDK returns MicroTime as its wire string. Preserve its required
        // microsecond format on writes and parse either representation on reads.
        const renewedAt = Date.parse(String(lease.spec?.renewTime ?? ""));
        const expires =
          (Number.isFinite(renewedAt) ? renewedAt : 0) +
          (lease.spec?.leaseDurationSeconds ?? 30) * 1000;
        if (lease.spec?.holderIdentity === this.identity || Date.now() > expires) {
          await this.coordination.replaceNamespacedLease({
            name,
            namespace,
            body: {
              ...lease,
              spec: {
                ...lease.spec,
                holderIdentity: this.identity,
                leaseDurationSeconds: 30,
                renewTime: new V1MicroTime(),
              },
            },
          });
          acquired = true;
        }
      }
    } catch (error) {
      acquired = false;
      process.stderr.write(
        `${JSON.stringify({ event: "operator.lease_unavailable", status: statusCode(error) ?? 0 })}\n`,
      );
    } finally {
      this.renewing = false;
    }
    if (!acquired || this.shutdown.signal.aborted) {
      this.epoch?.abort();
      return;
    }
    this.lastRenewed = Date.now();
    if (this.epoch === undefined || this.epoch.signal.aborted) {
      this.epoch = new AbortController();
      this.reconciler = new AgentReconciler(
        this.cluster,
        this.options.sourceClusterId,
        this.namespaceUid,
        this.epoch.signal,
      );
      await this.resync();
    }
  }

  private async resync(): Promise<void> {
    if (!this.leading()) {
      return;
    }
    for (const kind of Object.keys(PLURALS) as ResourceKind[]) {
      for (const resource of (await this.cluster.list(kind)).items) {
        this.enqueue(kind, resource.metadata.name);
      }
    }
  }

  private restartWatch(kind: ResourceKind): void {
    if (!this.shutdown.signal.aborted) {
      const timer = setTimeout(() => {
        this.restartTimers.delete(timer);
        void this.watch(kind);
      }, 5000);
      this.restartTimers.add(timer);
    }
  }

  private async watch(kind: ResourceKind): Promise<void> {
    if (this.shutdown.signal.aborted) {
      return;
    }
    try {
      const listed = await this.cluster.list(kind);
      for (const resource of listed.items) {
        this.observe(resource);
      }
      const subscription: { controller?: AbortController; ended: boolean } = { ended: false };
      const controller = await this.cluster.watch.watch(
        `/apis/${OPERATOR_GROUP}/${OPERATOR_VERSION}/namespaces/${this.options.namespace}/${PLURALS[kind]}`,
        { resourceVersion: listed.metadata.resourceVersion, allowWatchBookmarks: true },
        (phase: string, resource: Resource) => {
          if (phase === "ADDED" || phase === "MODIFIED") {
            this.observe(resource);
          }
          if (phase === "DELETED") {
            const key = `${kind}/${resource.metadata.name}`;
            this.seen.delete(key);
            this.pending.delete(key);
          }
        },
        () => {
          subscription.ended = true;
          if (subscription.controller !== undefined) {
            this.watches.delete(subscription.controller);
          }
          this.restartWatch(kind);
        },
      );
      subscription.controller = controller;
      if (subscription.ended || this.shutdown.signal.aborted) {
        controller.abort();
      } else {
        this.watches.add(controller);
      }
    } catch {
      this.restartWatch(kind);
    }
  }

  private async process(): Promise<void> {
    if (!this.leading()) {
      this.epoch?.abort();
      return;
    }
    if (this.processing || this.reconciler === undefined) {
      return;
    }
    const next = Array.from(this.pending.entries()).find(([, task]) => task.due <= Date.now());
    if (next === undefined) {
      return;
    }
    const [key, task] = next;
    this.pending.delete(key);
    this.processing = true;
    let resource: Resource | undefined;
    try {
      resource = await this.cluster.get(task.kind, task.name);
      await this.reconciler.reconcile(resource);
    } catch (error) {
      if (resource === undefined && statusCode(error) === 404) {
        this.seen.delete(key);
        return;
      }
      this.enqueue(task.kind, task.name, task.attempt + 1);
      if (resource !== undefined && this.leading()) {
        let reason = "DependencyUnavailable";
        let message = "Reconciliation could not complete; inspect the authorized dependency.";
        let ready: "False" | "Unknown" = "Unknown";
        if (error instanceof ReconcilePending) {
          reason = error.reason;
          message = error.message;
          if (
            [
              "InstallationMismatch",
              "NamespaceNotApproved",
              "OwnershipConflict",
              "ExecutionModeMismatch",
              "DeploymentFailed",
            ].includes(reason)
          ) {
            ready = "False";
          }
        } else if (error instanceof EnterpriseRequestError) {
          if (error.status === 403 || error.status === 401) {
            reason = "AuthorizationDenied";
          } else if (error.status === 409) {
            reason = "EnterpriseConflict";
          } else {
            reason = "EnterpriseUnavailable";
          }
          message = error.message;
          if ([400, 401, 403, 409, 422].includes(error.status)) {
            ready = "False";
          }
        }
        try {
          await this.reconciler.report(resource, {}, ready, reason, message);
        } catch (statusError) {
          process.stderr.write(
            `${JSON.stringify({ event: "operator.status_unavailable", kind: task.kind, status: statusCode(statusError) ?? 0 })}\n`,
          );
          // A conflicting status is retried from a fresh object, never overwritten.
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private every(milliseconds: number, work: () => Promise<void>): void {
    this.timers.add(
      setInterval(() => {
        void work().catch(() => undefined);
      }, milliseconds),
    );
  }

  async start(): Promise<void> {
    this.namespaceUid = await this.cluster.namespaceUid();
    this.health = createServer((request, reply) => {
      // A healthy standby is ready too, so rolling updates cannot deadlock on the leader Lease.
      const ready =
        request.url === "/healthz" ||
        (request.url === "/readyz" &&
          !this.shutdown.signal.aborted &&
          Date.now() - this.lastContact < 20_000);
      reply.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
      reply.end(ready ? "ok\n" : "not ready\n");
    });
    await new Promise<void>((resolve, reject) => {
      this.health!.once("error", reject);
      this.health!.listen(this.options.healthPort ?? 8080, "0.0.0.0", resolve);
    });
    for (const kind of Object.keys(PLURALS) as ResourceKind[]) {
      void this.watch(kind);
    }
    await this.renew();
    this.every(10_000, () => this.renew());
    this.every(250, () => this.process());
    this.every(30_000, () => this.resync());
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    this.epoch?.abort();
    for (const watch of this.watches) {
      watch.abort();
    }
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    for (const timer of this.restartTimers) {
      clearTimeout(timer);
    }
    if (this.health !== undefined) {
      await new Promise<void>((resolve) => this.health!.close(() => resolve()));
    }
  }
}
