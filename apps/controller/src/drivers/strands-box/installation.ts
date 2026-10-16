import { createHash, createPrivateKey, createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isIPv4 } from "node:net";
import { observePinnedStrandsContainer, pinnedStrandsContainer } from "./pinned-container.ts";
import { exactStrandsPodAdmission } from "./admission.ts";
import { exactStrandsNetworkFence } from "./network-policy.ts";
import { reconcileStrandsExecutionBearer } from "./execution-bearer.ts";
import { harnessWorkspacePreparationScript } from "../compute/kubernetes/index.ts";
import type {
  ProxyPlan,
  EgressInstallation,
  EgressRef,
  SandboxHarnessContext,
} from "@openclaw-enterprise/contracts";
import { publicCaBundle } from "@openclaw-enterprise/utils";
import { ExecutionKubernetes, hash, owner, type Resource } from "./kubernetes.ts";
import {
  NETWORK_PROFILE_LABEL,
  PROVIDER_FENCED_NETWORK_PROFILE,
} from "../compute/kubernetes/resources/network.ts";
import type { StrandsBoxOptions } from "../../backends/strands-box.ts";

const clientIdentity = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  readOnlyRootFilesystem: true,
};
const security = (id: number) => ({
  runAsUser: id,
  runAsGroup: id,
  runAsNonRoot: true,
  fsGroup: id,
  seccompProfile: { type: "RuntimeDefault" },
});
const b64 = (value: string) => Buffer.from(value).toString("base64");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** The digest survives JSONB reordering of an admitted plan. Arrays retain wire order. */
function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

type ComputeWorkload = {
  nodeSelector: Readonly<Record<string, string>>;
  resources?: unknown;
  codexSeccompProfile?: string;
};

interface Installed {
  instanceId: string;
  sandboxId: string;
  policyHash: string;
  peerKeyId: string;
  interceptCaSha256: string;
  bearerSha256: string;
  signature: string;
}

export function strandsHarnessPreparationCommand(workspacePaths: readonly string[]) {
  // Kubelet can create .codex as root when mounting its nested sessions and generated-images PVC subpaths.
  // Create HOME and the parent first, as the actual Harness uid. Keep the volume root and existing files untouched.
  const script =
    `const {mkdirSync,chmodSync} = require("node:fs");
const [home,tmp] = process.argv.slice(1);
for (const path of [home, home + "/.codex", tmp]) {
  mkdirSync(path, {recursive:true,mode:0o700});
  chmodSync(path, 0o700);
}
` + harnessWorkspacePreparationScript(workspacePaths);
  return ["node", "-e", script, "/runtime-state/home", "/runtime-temporary/tmp"];
}

/** One execution, one sender, one private history volume. No workload-controlled selectors or URLs. */
export class StrandsInstallation {
  readonly id: string;
  readonly name: string;
  readonly policy: string;
  readonly policyHash: string;
  private readonly senderEgress: unknown[];
  private readonly ca: string;
  readonly workloadLabels: Record<string, string>;
  private readonly senderLabels: Record<string, string>;

  private kube: ExecutionKubernetes;
  readonly namespace: string;
  readonly plan: ProxyPlan;
  readonly options: StrandsBoxOptions;
  readonly signal: AbortSignal;

  constructor(
    kube: ExecutionKubernetes,
    namespace: string,
    plan: ProxyPlan,
    options: StrandsBoxOptions,
    signal: AbortSignal,
  ) {
    this.kube = kube;
    this.namespace = namespace;
    this.plan = plan;
    this.options = options;
    this.signal = signal;
    const execution = plan.execution;
    this.id = execution.executionId;
    if (
      !/^[a-zA-Z0-9][-a-zA-Z0-9.]{0,62}$/.test(this.id) ||
      plan.routes.length > 8 ||
      new Set(plan.routes.map((r) => json(r.binding.binding))).size > 1 ||
      plan.routes.some((r) => !isDeepStrictEqual(r.binding.execution, execution))
    ) {
      throw new Error("Invalid Strands execution or route scope.");
    }
    this.name = "oce-strands-" + digest(json(execution)).slice(0, 24);
    this.workloadLabels = { [owner]: this.id, "openclaw.dev/strands-role": "workload" };
    this.senderLabels = { [owner]: this.id, "openclaw.dev/strands-role": "sender" };
    const routes = plan.routes.map(({ origin, path, method, deadlineMs }) => {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        !path.startsWith("/") ||
        /[?#]/.test(path) ||
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 ||
        deadlineMs > 30_000
      ) {
        throw new Error("Strands requires bounded exact HTTPS routes.");
      }
      const host = url.hostname;
      return {
        host,
        port: Number(url.port || 443),
        path,
        method,
        deadlineMs,
        ...options.originOverrides?.[host],
      };
    });
    const authority = new URL(options.authorityUri);
    const endpoints = [
      { ip: authority.hostname, port: Number(authority.port || 443) },
      ...routes.map((r) => ({ ip: r.connectIp, port: r.port })),
    ];
    this.senderEgress = endpoints.map(({ ip, port }) => {
      if (!ip || !isIPv4(ip)) {
        throw new Error(
          "Strands requires a qualified fixed IPv4 endpoint for the authority and every origin.",
        );
      }
      return { to: [{ ipBlock: { cidr: ip + "/32" } }], ports: [{ protocol: "TCP", port }] };
    });
    this.ca = publicCaBundle(readFileSync(options.authorityCaPath, "utf8"));
    this.policy = json({
      version: 2,
      senderImage: options.gatewayImage,
      plan,
      routes,
      dogwoodPolicy: readFileSync(options.dogwoodPolicyPath, "utf8"),
      authority: {
        uri: options.authorityUri,
        audience: options.audience,
        issuer: options.issuer,
        keyId: options.keyId,
        caSha256: digest(this.ca),
      },
    });
    this.policyHash = digest(this.policy);
  }

  ref() {
    return {
      resourceName: this.name,
      namespaceName: this.namespace,
      agentId: this.plan.execution.agentId,
      revisionId: this.plan.execution.revisionId,
    };
  }

  private metadata(suffix: string, labels: Record<string, string> = { [owner]: this.id }) {
    return {
      name: this.name + suffix,
      namespace: this.namespace,
      labels,
      annotations: { [hash]: this.policyHash },
    };
  }

  private proxy(suffix: string, port: number, path: string) {
    return this.kube.path(this.namespace, "Pod", this.name + suffix + ":" + port) + "/proxy" + path;
  }

  private async read(kind: string, suffix: string): Promise<Resource> {
    const r = await this.kube.read(this.namespace, kind, this.name + suffix, this.signal);
    if (
      !r ||
      !r.metadata.uid ||
      r.metadata.deletionTimestamp ||
      r.metadata.labels?.[owner] !== this.id ||
      r.metadata.annotations?.[hash] !== this.policyHash
    ) {
      throw new Error("Missing or replaced Strands " + kind);
    }
    return r;
  }

  private senderPolicy() {
    return {
      podSelector: { matchLabels: this.senderLabels },
      policyTypes: ["Ingress", "Egress"],
      egress: this.senderEgress,
      ingress: [
        {
          from: [{ podSelector: { matchLabels: this.workloadLabels } }],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    };
  }
  private workloadPolicy() {
    return {
      podSelector: { matchLabels: this.workloadLabels },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [{ podSelector: { matchLabels: this.senderLabels } }],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    };
  }

  private async installSender(
    controlEgress: unknown,
    nodeSelector: ComputeWorkload["nodeSelector"],
  ) {
    const config = {
      sandboxId: this.id,
      authorityUri: this.options.authorityUri,
      audience: this.options.audience,
      authorityCaPath: "/config/authority.pem",
      exchangeSeedPath: "/config/exchange-seed",
      bearerPath: "/identity/bearer",
      policyPath: "/config/policy.json",
      stateDir: "/state",
      listen: "0.0.0.0:8080",
      probeListen: "0.0.0.0:8081",
    };
    const ensure = (kind: string, body: Resource) =>
      this.kube.ensure(this.namespace, kind, body, this.signal);
    // A controller-owned immutable Secret pins the per-execution key and any *exact* Compute enrollment egress.
    const seed = randomBytes(32);
    const privateConfig = await ensure("Secret", {
      metadata: this.metadata("-config"),
      immutable: true,
      data: {
        "exchange-seed": seed.toString("base64"),
        "policy.json": b64(this.policy),
        "config.json": b64(json(config)),
        "authority.pem": b64(this.ca),
      },
    });
    seed.fill(0);
    const data = privateConfig.data ?? {};
    const policy = Buffer.from(data["policy.json"] ?? "", "base64").toString();
    if (policy !== this.policy || privateConfig.immutable !== true) {
      throw new Error("Stale Strands sender configuration.");
    }
    const installedSeed = Buffer.from(data["exchange-seed"] ?? "", "base64");
    const key = createPublicKey(
      createPrivateKey({
        format: "der",
        type: "pkcs8",
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), installedSeed]),
      }),
    );
    installedSeed.fill(0);
    const peerKeyId = key.export({ format: "jwk" }).x;
    if (!peerKeyId) {
      throw new Error("Missing registered Strands exchange key.");
    }
    // The API needs the public key and an admission fence, never the worker's sender seed or JWT.
    const publicConfig = {
      peerKeyId,
      policyHash: this.policyHash,
      privateConfigUid: privateConfig.metadata.uid!,
      controlEgress: json(controlEgress ?? []),
    };
    const registration = await ensure("ConfigMap", {
      metadata: this.metadata("-registration"),
      immutable: true,
      data: publicConfig,
    });
    if (registration.immutable !== true || !isDeepStrictEqual(registration.data, publicConfig)) {
      throw new Error(
        "Strands registration no longer matches the installed sender key and policy.",
      );
    }
    await ensure("NetworkPolicy", { metadata: this.metadata("-in"), spec: this.senderPolicy() });
    await ensure("NetworkPolicy", { metadata: this.metadata("-out"), spec: this.workloadPolicy() });
    await ensure("Secret", { metadata: this.metadata("-identity"), data: { bearer: "" } });
    await ensure("PersistentVolumeClaim", {
      metadata: this.metadata("-history"),
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: this.options.storageClassName,
        resources: { requests: { storage: "64Mi" } },
      },
    });
    const service = await ensure("Service", {
      metadata: this.metadata("-proxy"),
      spec: {
        selector: this.senderLabels,
        ports: [{ protocol: "TCP", port: 8080, targetPort: 8080 }],
      },
    });
    await this.installPod("-sender", this.senderLabels, {
      restartPolicy: "OnFailure",
      nodeSelector,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: security(65532),
      volumes: [
        { name: "config", secret: { secretName: this.name + "-config", defaultMode: 0o440 } },
        { name: "identity", secret: { secretName: this.name + "-identity", defaultMode: 0o440 } },
        { name: "state", persistentVolumeClaim: { claimName: this.name + "-history" } },
      ],
      containers: [
        {
          name: "sender",
          image: this.options.gatewayImage,
          args: ["/config/config.json"],
          securityContext: clientIdentity,
          volumeMounts: [
            { name: "config", mountPath: "/config", readOnly: true },
            { name: "identity", mountPath: "/identity", readOnly: true },
            { name: "state", mountPath: "/state" },
          ],
          resources: {
            requests: { cpu: "50m", memory: "128Mi" },
            limits: { cpu: "2", memory: "512Mi" },
          },
        },
      ],
    });
    if (typeof service.spec?.clusterIP !== "string" || service.spec.clusterIP === "None") {
      throw new Error("Strands sender requires a private ClusterIP.");
    }
    return service.spec.clusterIP;
  }

  private async observe(registration: Resource) {
    // An unbound volume, unscheduled Pod, or image pull is not an installation observation.
    const proof = await observePinnedStrandsContainer(
      () => this.read("Pod", "-sender"),
      "sender",
      this.options.gatewayImage,
      () => this.proveSender(registration),
    );
    return proof && { ...proof.observation, running: proof.running };
  }

  private async proveSender(registration: Resource) {
    const peerKeyId = registration.data?.peerKeyId;
    if (
      registration.immutable !== true ||
      registration.data?.policyHash !== this.policyHash ||
      !peerKeyId
    ) {
      throw new Error("Strands sender registration differs from the immutable admission.");
    }
    const key = createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x: peerKeyId },
    });
    const challenge = randomBytes(32).toString("hex");
    const { text, status: probeStatus } = await this.kube.text(
      this.proxy("-sender", 8081, "/installed?challenge=" + challenge),
      this.signal,
      { allow: [502, 503, 504] },
    );
    if (probeStatus !== 200) {
      return undefined;
    }
    const observed = JSON.parse(text) as Installed;
    const { sandboxId, instanceId, policyHash, interceptCaSha256, bearerSha256, signature } =
      observed;
    if (
      observed.peerKeyId !== peerKeyId ||
      sandboxId !== this.id ||
      policyHash !== this.policyHash ||
      !/^[\da-f-]{36}$/.test(instanceId) ||
      !/^[\da-f]{64}$/.test(interceptCaSha256) ||
      !verify(
        null,
        Buffer.from(
          JSON.stringify([
            "oce-strands-box-installation-v1",
            challenge,
            sandboxId,
            policyHash,
            instanceId,
            peerKeyId,
            interceptCaSha256,
            bearerSha256,
          ]),
        ),
        key,
        Buffer.from(signature, "base64url"),
      )
    ) {
      throw new Error(
        "Strands sender did not prove the exact installed policy, identity and TLS endpoint.",
      );
    }
    return observed;
  }

  /** Provision and renew only during reconciliation, never from resolve or authorize-send. */
  async provision(context: SandboxHarnessContext) {
    const { requirements: q } = context;
    const wiring = q.proxyWiring;
    if (
      !wiring ||
      !isDeepStrictEqual(wiring.plan, this.plan) ||
      wiring.configuration.policyHash !== this.policyHash ||
      q.credentialAttachments.length ||
      q.labels[NETWORK_PROFILE_LABEL] !== PROVIDER_FENCED_NETWORK_PROFILE
    ) {
      throw new Error(
        "Strands requires the admitted protected workload and refuses legacy credential delivery.",
      );
    }
    if (await this.isRetired()) {
      throw new Error(
        "Strands execution was retired; deploy a new revision instead of restoring its grant.",
      );
    }
    const ref = { ...this.ref(), proxyWiring: wiring };
    // Both the untrusted workload and the trusted sender must be placed only on the Compute-qualified nodes.
    const compute = wiring.configuration.computeWorkload as ComputeWorkload | undefined;
    if (!compute?.nodeSelector || !Object.keys(compute.nodeSelector).length) {
      throw new Error(
        "Strands requires an explicit Compute selector for qualified execution nodes.",
      );
    }
    const proxyIp = await this.installSender(
      wiring.configuration.computeControlEgress,
      compute.nodeSelector,
    );
    const installed = await this.observe(await this.read("ConfigMap", "-registration"));
    if (!installed) {
      return ref;
    } // Reconciliation observes boot and delayed PVC or Secret projection.
    const identity = await this.read("Secret", "-identity");
    const publicIdentity = await reconcileStrandsExecutionBearer(
      identity,
      installed,
      this.options,
      (replacement) =>
        this.kube.text(
          this.kube.path(this.namespace, "Secret", identity.metadata.name),
          this.signal,
          { method: "PUT", body: JSON.stringify(replacement) },
        ),
    );
    if (!publicIdentity) {
      return ref;
    }
    // A crash between Secret replacement and publishing that live projected commitment is repaired by maintenance.
    // The API's installation verification fails closed on any projection/recording gap.
    const evidence = await this.kube.ensure(
      this.namespace,
      "ConfigMap",
      {
        metadata: this.metadata("-enrollment"),
        data: publicIdentity,
      },
      this.signal,
    );
    if (!isDeepStrictEqual(publicIdentity, evidence.data)) {
      await this.kube.text(
        this.kube.path(this.namespace, "ConfigMap", evidence.metadata.name),
        this.signal,
        {
          method: "PATCH",
          headers: { "content-type": "application/merge-patch+json" },
          body: JSON.stringify({
            metadata: {
              uid: evidence.metadata.uid,
              resourceVersion: evidence.metadata.resourceVersion,
            },
            data: publicIdentity,
          }),
        },
      );
    }
    const { text: ca } = await this.kube.text(this.proxy("-sender", 8081, "/ca.pem"), this.signal);
    if (digest(ca) !== installed.interceptCaSha256) {
      throw new Error("Strands sender changed its interception root.");
    }
    await this.workload(context, proxyIp, publicCaBundle(ca), compute);
    return ref;
  }

  private async workload(
    { requirements: q }: SandboxHarnessContext,
    ip: string,
    ca: string,
    compute: ComputeWorkload,
  ) {
    const caPath = "/run/oce-strands/intercept.pem";
    const data: Record<string, string> = { "intercept.pem": ca };
    const env = q.files.map(({ name, content, environmentVariable }) => {
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(name) || Object.hasOwn(data, name)) {
        throw new Error("Strands workload file name conflicts with its admitted configuration.");
      }
      data[name] = content;
      return { name: environmentVariable, value: "/run/oce-strands/" + name };
    });
    const client = await this.kube.ensure(
      this.namespace,
      "ConfigMap",
      {
        metadata: this.metadata("-client"),
        immutable: true,
        data,
      },
      this.signal,
    );
    if (!isDeepStrictEqual(client.data, data)) {
      throw new Error("Strands workload configuration changed; redeploy.");
    }
    const proxy = "http://" + ip + ":8080";
    const workspaceGateway = this.options.workspaceGateway;
    const noProxy = [
      "localhost",
      "127.0.0.1",
      ...(workspaceGateway ? [workspaceGateway.hostname] : []),
    ].join(",");
    const injected = Object.entries({
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      SSL_CERT_FILE: caPath,
      REQUESTS_CA_BUNDLE: caPath,
      GIT_SSL_CAINFO: caPath,
      NODE_EXTRA_CA_CERTS: caPath,
      OPENCLAW_EGRESS_KUBERNETES_ENROLLMENT: "1",
    }).map(([name, value]) => ({ name, value }));
    const identity = q.workloadIdentity;
    const identityVolume = identity
      ? [
          {
            name: "workload-identity",
            projected: {
              sources: [
                {
                  serviceAccountToken: {
                    audience: identity.token.audience,
                    expirationSeconds: identity.token.expirationSeconds,
                    path: identity.token.path,
                  },
                },
              ],
            },
          },
        ]
      : [];
    // Carry the same Compute-selected execution nodes, resource bounds and optional localhost seccomp profile.
    const resources = compute.resources ?? {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "2", memory: "4Gi" },
    };
    const workloadSecurity = compute.codexSeccompProfile
      ? {
          ...clientIdentity,
          seccompProfile: { type: "Localhost", localhostProfile: compute.codexSeccompProfile },
        }
      : clientIdentity;
    // Preserve Compute's private HOME and uid-1000 workspace subpath preparation. The init
    // container gets only this Agent's claim, not source material, sender identity or state.
    const claims = [...new Set(q.workspaceMounts.map((m) => m.claimName))];
    const workspace = q.workspaceMounts.map((m) => {
      if (!/^[a-zA-Z\d][a-zA-Z\d_-]{0,126}$/.test(m.subPath)) {
        throw new Error("Unsafe Strands workspace subpath.");
      }
      return { ...m, name: "work-" + claims.indexOf(m.claimName) };
    });
    const initContainers = [
      {
        name: "prepare-workspace",
        image: q.image,
        securityContext: workloadSecurity,
        resources,
        command: strandsHarnessPreparationCommand(
          workspace.map((m) => "/mnt/" + m.name + "/" + m.subPath),
        ),
        volumeMounts: [
          { name: "home", mountPath: "/runtime-state" },
          { name: "tmp", mountPath: "/runtime-temporary" },
          ...claims.map((_claim, i) => ({ name: "work-" + i, mountPath: "/mnt/work-" + i })),
        ],
      },
    ];
    await this.installPod(
      "",
      { ...q.labels, ...this.workloadLabels },
      {
        restartPolicy: "OnFailure",
        nodeSelector: compute.nodeSelector,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        serviceAccountName: identity?.serviceAccountName,
        initContainers,
        hostAliases: workspaceGateway
          ? [{ ip: workspaceGateway.address, hostnames: [workspaceGateway.hostname] }]
          : undefined,
        securityContext: security(1000),
        volumes: [
          { name: "strands-client", configMap: { name: client.metadata.name } },
          { name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
          { name: "home", emptyDir: { sizeLimit: "2Gi" } },
          ...identityVolume,
          ...claims.map((claimName, i) => ({
            name: "work-" + i,
            persistentVolumeClaim: { claimName },
          })),
        ],
        containers: [
          {
            name: "agent",
            image: q.image,
            command: [...q.command],
            env: [
              ...q.environment.filter((e) => !injected.some((i) => i.name === e.name)),
              ...env,
              ...injected,
            ],
            securityContext: workloadSecurity,
            resources,
            volumeMounts: [
              { name: "strands-client", mountPath: "/run/oce-strands", readOnly: true },
              { name: "tmp", mountPath: "/tmp", subPath: "tmp" },
              { name: "home", mountPath: "/home/node", subPath: "home" },
              ...(identity
                ? [
                    {
                      name: "workload-identity",
                      mountPath: identity.token.mountPath,
                      readOnly: true,
                    },
                  ]
                : []),
              ...workspace.map((m) => ({
                name: m.name,
                mountPath: m.mountPath,
                subPath: m.subPath,
                readOnly: m.readOnly,
              })),
            ],
            readinessProbe: { httpGet: { port: 18791, path: "/readyz" }, periodSeconds: 2 },
          },
        ],
      },
    );
  }

  private async installPod(
    suffix: string,
    labels: Record<string, string>,
    spec: Record<string, unknown>,
  ) {
    const seal = await this.kube.ensure(
      this.namespace,
      "ConfigMap",
      {
        metadata: this.metadata(suffix + "-admission"),
        immutable: true,
        data: { pod: json({ labels, spec }) },
      },
      this.signal,
    );
    if (seal.data?.pod !== json({ labels, spec }) || seal.immutable !== true) {
      throw new Error("Strands Pod admission changed.");
    }
    const pod = await this.kube.ensure(
      this.namespace,
      "Pod",
      { metadata: this.metadata(suffix, labels), spec },
      this.signal,
    );
    if (!exactStrandsPodAdmission(spec, pod.spec ?? {})) {
      throw new Error("Strands Pod security shape changed during admission.");
    }
  }

  private async fence(
    config: Resource,
    installed: Installed & {
      running: NonNullable<ReturnType<typeof pinnedStrandsContainer>>;
    },
  ) {
    const [pods, policies, client, history] = await Promise.all([
      this.kube.list(this.namespace, "Pod", this.signal),
      this.kube.list(this.namespace, "NetworkPolicy", this.signal),
      this.read("ConfigMap", "-client"),
      this.read("PersistentVolumeClaim", "-history"),
    ]);
    const service = await this.read("Service", "-proxy");
    if (
      service.spec?.type !== "ClusterIP" ||
      !isDeepStrictEqual(service.spec?.selector, this.senderLabels) ||
      !isDeepStrictEqual(service.spec?.ports, [{ protocol: "TCP", port: 8080, targetPort: 8080 }])
    ) {
      return undefined;
    }
    const ca = client.data?.["intercept.pem"] ?? "";
    if (digest(ca) !== installed.interceptCaSha256 || !history.spec?.volumeName) {
      return undefined;
    }
    const control = JSON.parse(config.data?.controlEgress ?? "[]");
    const ids: unknown[] = [
      config.metadata.uid,
      client.metadata.uid,
      history.metadata.uid,
      history.spec.volumeName,
    ];
    for (const [name, labels, expected] of [
      [this.name, this.workloadLabels, this.workloadPolicy()],
      [this.name + "-sender", this.senderLabels, this.senderPolicy()],
    ] as const) {
      const matched = pods.filter((p) =>
        Object.entries(labels).every(([k, v]) => p.metadata.labels?.[k] === v),
      );
      const suffix = name === this.name ? "" : "-sender";
      const seal = await this.read("ConfigMap", suffix + "-admission");
      if (!seal.data?.pod || seal.immutable !== true) {
        return undefined;
      }
      const { spec, labels: admittedLabels } = JSON.parse(seal.data.pod);
      const pod = matched[0];
      if (
        !pod ||
        !exactStrandsPodAdmission(spec, pod.spec ?? {}) ||
        !isDeepStrictEqual(pod.metadata.labels, admittedLabels)
      ) {
        return undefined;
      }
      if (suffix) {
        // exactStrandsPodAdmission has just matched the seal's spec to this live spec. Require it
        // to match the current sender image too, and bind this container identity into configurationId.
        const running = pinnedStrandsContainer(pod, "sender", this.options.gatewayImage);
        if (!isDeepStrictEqual(running, installed.running)) {
          return undefined;
        }
        ids.push(running);
      } else {
        const env = spec.containers[0].env;
        if (
          env.find((v: { name: string }) => v.name === "HTTPS_PROXY")?.value !==
          "http://" + service.spec?.clusterIP + ":8080"
        ) {
          return undefined;
        }
      }
      ids.push(service.metadata.uid, seal.metadata.uid);
      const meta = pod.metadata;
      if (
        matched.length !== 1 ||
        meta?.name !== name ||
        !meta.uid ||
        meta.deletionTimestamp ||
        meta.annotations?.[hash] !== this.policyHash
      ) {
        return undefined;
      }
      ids.push(meta.uid);
      const fenceUid = exactStrandsNetworkFence(
        policies,
        meta.labels!,
        expected,
        this.id,
        this.policyHash,
        control,
      );
      if (!fenceUid) {
        return undefined;
      }
      ids.push(fenceUid);
    }
    return digest(json(ids));
  }

  private isRetired() {
    return this.kube.read(this.namespace, "ConfigMap", this.name + "-retired", this.signal);
  }

  async installation(sender: EgressRef): Promise<EgressInstallation | undefined> {
    if (await this.isRetired()) {
      return undefined;
    }
    const workload = await this.kube.read(this.namespace, "Pod", this.name, this.signal);
    if (!workload || workload.metadata.deletionTimestamp) {
      return undefined;
    }
    const [config, identity] = await Promise.all([
      this.read("ConfigMap", "-registration"),
      this.read("ConfigMap", "-enrollment"),
    ]);
    const installed = await this.observe(config);
    const evidence = identity.data;
    if (
      !installed ||
      !evidence ||
      !(Number(evidence.expiresAt) > Date.now() + 3000) ||
      installed.bearerSha256 !== evidence.bearerSha256 ||
      installed.peerKeyId !== evidence.peerKeyId ||
      installed.instanceId !== evidence.instanceId
    ) {
      return undefined;
    }
    const fence = await this.fence(config, installed);
    if (!fence) {
      return undefined;
    }
    const { instanceId, peerKeyId, interceptCaSha256 } = installed;
    return {
      plan: this.plan,
      sender,
      sandboxId: this.id,
      installedAt: new Date().toISOString(),
      enforcement: {
        instanceId,
        peerKeyId,
        policyHash: this.policyHash,
        authorityScope: "execution",
        configurationId: digest(
          json([this.policyHash, instanceId, peerKeyId, interceptCaSha256, fence]),
        ),
      },
    };
  }

  /** Kubernetes consumes Authorization. Carry the Harness bearer on its own header, never the API credential. */
  async harness(path: string, token: string, port: number, body?: unknown) {
    return this.kube.text(this.proxy("", port, path), this.signal, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      allow: [400, 404, 409, 410, 502, 503],
      headers: { "x-oce-enrollment-proof": token },
    });
  }

  async remove(options?: { readonly retainHistory: true }): Promise<boolean> {
    // Compute serializes reconciliation and withdrawal. Persist a nonsecret, immutable retirement
    // marker first, so stale maintenance fails closed instead of recreating an empty attempt budget.
    // Namespace deletion collects the marker. This is whole-execution retirement, not live policy reduction.
    // Retirement is scoped to this exact execution, independent of the currently approved sender
    // image. Continue even an older policy-stamped retirement; never need to reauthorize it to stop it.
    const retired =
      (await this.isRetired()) ??
      (await this.kube.ensure(
        this.namespace,
        "ConfigMap",
        {
          metadata: {
            name: this.name + "-retired",
            namespace: this.namespace,
            labels: { [owner]: this.id },
          },
          immutable: true,
          data: { retired: this.id },
        },
        this.signal,
      ));
    if (
      !retired.metadata.uid ||
      retired.metadata.deletionTimestamp ||
      retired.metadata.labels?.[owner] !== this.id ||
      !retired.immutable ||
      retired.data?.retired !== this.id
    ) {
      throw new Error("Strands could not confirm its execution retirement marker.");
    }
    // Stop the only sender first. Keep the network fence and persistent history until both Pods are gone.
    for (const [kind, suffix] of [
      ["Pod", "-sender"],
      ["Pod", ""],
      ["Service", "-proxy"],
      ["ConfigMap", "-client"],
      ["ConfigMap", "-admission"],
      ["ConfigMap", "-sender-admission"],
      ["Secret", "-identity"],
      ["ConfigMap", "-enrollment"],
      ["ConfigMap", "-registration"],
      ["NetworkPolicy", "-in"],
      ["NetworkPolicy", "-out"],
      ["PersistentVolumeClaim", "-history"],
      ["Secret", "-config"],
    ]) {
      if (kind === "PersistentVolumeClaim" && options?.retainHistory) {
        // Last-binding withdrawal preserves attempt history. Only explicit revision cleanup releases it.
        continue;
      }
      const name = this.name + suffix;
      const resource = await this.kube.read(this.namespace, kind!, name, this.signal);
      if (!resource) {
        continue;
      }
      if (resource.metadata.labels?.[owner] !== this.id || !resource.metadata.uid) {
        throw new Error("Strands refuses foreign execution cleanup.");
      }
      if (!resource.metadata.deletionTimestamp) {
        await this.kube.remove(this.namespace, resource, this.signal);
      }
      if (kind === "Pod" && (await this.kube.read(this.namespace, kind, name, this.signal))) {
        return false;
      }
    }
    return true;
  }
}
