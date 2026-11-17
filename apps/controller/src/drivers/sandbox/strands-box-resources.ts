import type { KubernetesObject } from "@kubernetes/client-node";
import type { SandboxHarnessContext } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { sha256Hex } from "@openclaw-enterprise/utils";
import { posix } from "node:path";
import { harnessWorkspacePreparationScript } from "../compute/kubernetes/index.ts";
import {
  NATIVE_HOOK_CREDENTIAL_DIRECTORY,
  RUNTIME_WRAPPER_COMMAND,
  splitBoxWorkspaceLaunch,
} from "../compute/kubernetes/runtime-entrypoints.ts";
import {
  WORKSPACE_SETUP_RUNTIME,
  workspaceSetupVerifier,
} from "../compute/workspace-setup-runtime.ts";
import { nodeProgramArguments } from "../compute/node-program.ts";
import type { StrandsBoxOptions } from "./strands-box.ts";

const PRIVATE = [
  ".codex",
  NATIVE_HOOK_CREDENTIAL_DIRECTORY,
  ".openclaw",
  ".cache",
  ".local",
  "openclaw-runtime-assets",
  "tmp",
  "workspace",
].map((part) => `/home/node/${part}`);
export const STRANDS_STATUS_PORT = 18791;
const ROOT = "/etc/strands-box";
function refuse(): never {
  throw new SandboxRevisionUnsupportedError(
    "SANDBOX_HARNESS_UNSUPPORTED",
    "Strands Box cannot preserve these prepared workload requirements.",
  );
}
function absolute(path: string): void {
  if (!path.startsWith("/") || posix.normalize(path) !== path || path === "/") {
    refuse();
  }
}
function relative(path: string): void {
  if (
    path.startsWith("/") ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => ["", ".", ".."].includes(part))
  ) {
    refuse();
  }
}

function grantRoots(paths: readonly string[]): string[] {
  return [...new Set(paths)].filter(
    (path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}

export function strandsBoxService(
  context: SandboxHarnessContext,
  name: string,
  labels: Readonly<Record<string, string>>,
  hash: string,
  diagnostic: boolean,
) {
  const entry = context.requirements.environment.find(({ name }) => name === "APP_SERVER_PORT");
  const port = entry && "value" in entry ? Number(entry.value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === STRANDS_STATUS_PORT) {
    refuse();
  }
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      namespace: context.namespace.name,
      name: diagnostic ? `${name}-status` : name,
      labels: { ...context.requirements.labels, ...labels },
      annotations: { "openclaw.dev/strands-box-input-sha256": hash },
    },
    spec: {
      selector: labels,
      ports: diagnostic
        ? [{ name: "readiness", port: STRANDS_STATUS_PORT, targetPort: STRANDS_STATUS_PORT }]
        : [{ name: "harness", port, targetPort: port }],
      // Only the controller's held-failure read uses the unready route.
      ...(diagnostic ? { publishNotReadyAddresses: true } : {}),
    },
  };
}

/** Prepared revision inputs drive projections; Box config contains no Secret values. */
export function strandsBoxResources(
  context: SandboxHarnessContext,
  options: StrandsBoxOptions,
  name: string,
  labels: Readonly<Record<string, string>>,
  hash: string,
  transportHash: string,
  gateway:
    | {
        readonly host: string;
        readonly port: number;
        readonly egress: Readonly<Record<string, unknown>>;
      }
    | undefined,
  cidrs: readonly { readonly cidr: string; readonly port: number }[],
): readonly KubernetesObject[] {
  const r = context.requirements;
  // Keep Compute's exact init options with the supervisor. Only the original
  // workload and its arguments cross the Box boundary.
  const workloadStart = RUNTIME_WRAPPER_COMMAND.indexOf("--") + 1;
  if (
    r.credentialAttachments.length ||
    !["api_key", "codex_pat"].includes(r.loginMode) ||
    !r.image ||
    RUNTIME_WRAPPER_COMMAND[0] !== "/usr/bin/tini" ||
    workloadStart === 0 ||
    r.command.length <= RUNTIME_WRAPPER_COMMAND.length ||
    !RUNTIME_WRAPPER_COMMAND.every((part, index) => r.command[index] === part)
  ) {
    refuse();
  }
  const service = strandsBoxService(context, name, labels, hash, false);
  const diagnosticService = strandsBoxService(context, name, labels, hash, true);
  const { metadata } = service;
  const transport = r.environment.find((entry) => entry.name === "APP_SERVER_TOKEN");
  if (!transport || !("valueFrom" in transport)) {
    refuse();
  }
  const enrollment = r.environment.find((entry) => entry.name === "OPENCLAW_NODE_SETUP_CODE");
  const verifier = r.workspaceSetup
    ? workspaceSetupVerifier(
        {
          ...r.workspaceSetup,
          namespaceId: context.namespace.id,
          agentId: context.revision.agentId,
        },
        { environment: "OPENCLAW_WORKSPACE_DIR" },
      )
    : "";
  const roles = enrollment && splitBoxWorkspaceLaunch(r.command, verifier);
  const literal = (key: string) => {
    const item = r.environment.find((entry) => entry.name === key);
    return item && "value" in item ? item.value : undefined;
  };
  const statePath = literal("OPENCLAW_NODE_STATE_DIR");
  const workspacePath = literal("OPENCLAW_WORKSPACE_DIR");
  if (
    enrollment &&
    (!roles ||
      !("valueFrom" in enrollment) ||
      statePath !== "/home/node/.openclaw-node" ||
      !workspacePath ||
      !r.workspaceMounts.some((mount) => mount.mountPath === statePath && !mount.readOnly))
  ) {
    refuse();
  }
  const probeKey = transport.valueFrom.secretKeyRef;
  const environment: Record<string, string> = {};
  const secretEnvironment: Record<string, string> = {};
  const volumes: Record<string, unknown>[] = [
    { name: "inputs", configMap: { name } },
    {
      name: "probe-auth",
      secret: {
        secretName: probeKey.name,
        items: [{ key: probeKey.key, path: "token" }],
        defaultMode: 0o440,
      },
    },
    { name: "private-home", emptyDir: { sizeLimit: "2Gi" } },
    { name: "box-state", emptyDir: { sizeLimit: "256Mi" } },
    { name: "temporary", emptyDir: { sizeLimit: "64Mi" } },
  ];
  const mounts: Record<string, unknown>[] = [
    { name: "private-home", mountPath: "/home/node" },
    { name: "box-state", mountPath: "/run/strands-box" },
    { name: "temporary", mountPath: "/tmp" },
    ...["box.toml", "policy.dw", "workload.json"].map((file) => ({
      name: "inputs",
      mountPath: `${ROOT}/${file}`,
      subPath: file,
      readOnly: true,
    })),
  ];
  const read = ["/app", "/opt/oce", `${ROOT}/workload.json`, "/etc/ssl/certs", ...PRIVATE];
  const write = [...PRIVATE];
  const data: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [index, entry] of r.environment.entries()) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name) ||
      seen.has(entry.name) ||
      /^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(entry.name)
    ) {
      refuse();
    }
    seen.add(entry.name);
    if (
      roles &&
      [
        "OPENCLAW_NODE_SETUP_CODE",
        "OPENCLAW_NODE_STATE_DIR",
        "OPENCLAW_NODE_DISPLAY_NAME",
        "OPENCLAW_WORKSPACE_BOOTSTRAP",
      ].includes(entry.name)
    )
      continue;
    if (entry.name === "APP_SERVER_TOKEN") {
      // Only the trusted readiness client presents the bearer. Codex accepts
      // its verifier, as it does on Compute's verifier-delivery path.
      environment.APP_TOKEN_SHA = transportHash;
      continue;
    }
    if (entry.name === "APP_TOKEN_SHA") {
      refuse();
    }
    if ("value" in entry) {
      environment[entry.name] = entry.value;
    } else {
      const path = `/run/strands-secrets/env-${index}`;
      volumes.push({
        name: `env-${index}`,
        secret: {
          secretName: entry.valueFrom.secretKeyRef.name,
          items: [{ key: entry.valueFrom.secretKeyRef.key, path: "value" }],
        },
      });
      mounts.push({ name: `env-${index}`, mountPath: path, readOnly: true });
      secretEnvironment[entry.name] = `${path}/value`;
      read.push(path);
    }
  }
  if (environment.HOME !== undefined && environment.HOME !== "/home/node") {
    refuse();
  }
  const port = service.spec.ports[0]!.port;
  if (!/^[a-f0-9]{64}$/u.test(transportHash ?? "")) {
    refuse();
  }
  const claims = new Map<string, { name: string; paths: string[] }>();
  for (const mount of r.workspaceMounts) {
    absolute(mount.mountPath);
    relative(mount.subPath);
    if (!mount.mountPath.startsWith("/home/node/") || typeof mount.readOnly !== "boolean") {
      refuse();
    }
    let claim = claims.get(mount.claimName);
    if (!claim) {
      claim = { name: `workspace-${sha256Hex(mount.claimName, 12)}`, paths: [] };
      claims.set(mount.claimName, claim);
      volumes.push({ name: claim.name, persistentVolumeClaim: { claimName: mount.claimName } });
    }
    claim.paths.push(`/claims/${claim.name}/${mount.subPath}`);
    mounts.push({
      name: claim.name,
      subPath: mount.subPath,
      mountPath: mount.mountPath,
      readOnly: mount.readOnly,
    });
    if (roles && mount.mountPath === statePath) continue;
    read.push(mount.mountPath);
    if (!mount.readOnly) {
      write.push(mount.mountPath);
    }
  }
  for (const file of r.files) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(file.name) ||
      seen.has(file.environmentVariable) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(file.environmentVariable)
    ) {
      refuse();
    }
    const key = `file-${file.name}`;
    data[key] = file.content;
    environment[file.environmentVariable] = `/run/strands-files/${file.name}`;
    mounts.push({
      name: "inputs",
      mountPath: environment[file.environmentVariable],
      subPath: key,
      readOnly: true,
    });
    read.push(`/run/strands-files/${file.name}`);
    seen.add(file.environmentVariable);
  }
  const identity = r.workloadIdentity;
  if (identity) {
    absolute(identity.token.mountPath);
    relative(identity.token.path);
    if (identity.token.readOnly !== true) {
      refuse();
    }
    volumes.push({
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
    });
    mounts.push({ name: "workload-identity", mountPath: identity.token.mountPath, readOnly: true });
    read.push(identity.token.mountPath);
  }
  const workspace = environment.OPENCLAW_WORKSPACE_DIR ?? "/home/node/workspace";
  if (!r.workspaceMounts.some((mount) => mount.mountPath === workspace && !mount.readOnly)) {
    refuse();
  }
  const manifest = {
    port,
    transportHash,
    ...(gateway ? { gateway } : {}),
    command: roles ? roles.codex : r.command.slice(workloadStart),
    revisionId: context.revision.id,
    statusPort: STRANDS_STATUS_PORT,
    environment,
    secretEnvironment,
    workspace,
    privateDirectories: PRIVATE,
  };
  data["workload.json"] = JSON.stringify(manifest);
  const policy = options.policy.network.endpoints.flatMap((endpoint, index) =>
    endpoint.ports.map(
      (allowedPort) =>
        `// Installation-approved destination, including its HTTP authorization.\n@id("connect_${index}_${allowedPort}")\npermit (principal, action == Box::Action::"net:connect", resource)\nwhen { context.input.host == ${JSON.stringify(endpoint.host)} && context.input.port == ${allowedPort} };\n@id("request_${index}_${allowedPort}")\npermit (principal, action == Box::Action::"http:request", resource)\nwhen { context.input.host == ${JSON.stringify(endpoint.host)} && context.input.port == ${allowedPort} };`,
    ),
  );
  const shellWorkspace = workspace.replace(/^\/home\/node(?=\/)/u, "~");
  policy.push(
    '@id("workspace_shell")\npermit (principal, action == Box::Action::"shell:exec", resource);',
    `@id("workspace_files")\npermit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write", Box::Action::"fs:delete"], resource)\nwhen { context.input.path == ${JSON.stringify(shellWorkspace)} || context.input.path like ${JSON.stringify(`${shellWorkspace}/*`)} };`,
    '@id("dev_null")\npermit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)\nwhen { context.input.path == "/dev/null" };',
  );
  data["policy.dw"] = policy.join("\n");
  // File subPath projections avoid the atomic symlink generation directory that
  // the Box config protection masks. Secret references remain private files.
  data["box.toml"] =
    `name = "${name.slice(0, 32)}"\nbox_dir = "/run/strands-box/state"\npolicy = "${ROOT}/policy.dw"\n[experimental-features]\ncontainer-agent = true\n[agent]\ncommand = ["/usr/local/bin/node", "--jitless", "/opt/oce/strands-box/inner.mjs", "${ROOT}/workload.json"]\nworkspace = ${JSON.stringify(workspace)}\n[agent.filesystem]\nread = ${JSON.stringify(grantRoots(read))}\nwrite = ${JSON.stringify(grantRoots(write))}\nexec = ["/usr/bin/tini", "/usr/bin/env", "/usr/local/bin/node", "/usr/lib/aarch64-linux-gnu", "/app/node_modules", "/opt/oce/runtime"]\n`;
  const securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  const initMounts = [
    ...(roles ? [{ name: "node-scratch", mountPath: "/node-scratch" }] : []),
    { name: "private-home", mountPath: "/home/node" },
    { name: "temporary", mountPath: "/tmp" },
    ...[...claims.values()].map((claim) => ({
      name: claim.name,
      mountPath: `/claims/${claim.name}`,
    })),
  ];
  const initialize = `const fs=require("node:fs"); for(const path of ${JSON.stringify(roles ? [...PRIVATE, "/node-scratch/home", "/node-scratch/tmp"] : PRIVATE)}) fs.mkdirSync(path,{recursive:true,mode:0o700});\n${harnessWorkspacePreparationScript([...claims.values()].flatMap((claim) => claim.paths))}`;
  const initContainers: Record<string, unknown>[] = [
    {
      name: "initialize-workspace-directories",
      image: r.image,
      command: ["/usr/bin/tini", "-s", "--", "node", "-e", ...nodeProgramArguments(initialize)],
      volumeMounts: initMounts,
      securityContext,
    },
  ];
  if (r.workspaceSetup) {
    const setup = r.workspaceSetup.secretKeyRef;
    volumes.push({
      name: "workspace-setup",
      secret: { secretName: setup.name, items: [{ key: setup.key, path: "setup.json" }] },
    });
    initContainers.push({
      name: "initialize-workspace",
      image: r.image,
      command: [
        "/usr/bin/tini",
        "-s",
        "--",
        "node",
        "-e",
        ...nodeProgramArguments(WORKSPACE_SETUP_RUNTIME),
      ],
      env: [
        { name: "HOME", value: "/home/node" },
        { name: "OPENCLAW_WORKSPACE_DIR", value: workspace },
        { name: "OPENCLAW_WORKSPACE_SETUP_PATH", value: "/run/workspace-setup/setup.json" },
      ],
      volumeMounts: [
        ...mounts.filter(
          (mount) =>
            mount.name === "private-home" ||
            mount.name === "temporary" ||
            [...claims.values()].some((claim) => claim.name === mount.name),
        ),
        { name: "workspace-setup", mountPath: "/run/workspace-setup", readOnly: true },
      ],
      securityContext,
    });
  }
  const workloadMounts = mounts.filter((mount) => !roles || mount.mountPath !== statePath);
  if (roles && enrollment && "valueFrom" in enrollment) {
    const setup = enrollment.valueFrom.secretKeyRef;
    volumes.push(
      { name: "node-scratch", emptyDir: { sizeLimit: "1Gi" } },
      {
        name: "node-enrollment",
        secret: {
          secretName: setup.name,
          optional: true,
          items: [{ key: setup.key, path: "code" }],
          defaultMode: 0o440,
        },
      },
    );
    const fileEnvironment = new Set([
      "HOME",
      "PATH",
      "OPENCLAW_NODE_STATE_DIR",
      "OPENCLAW_NODE_DISPLAY_NAME",
      "OPENCLAW_NODE_CA_PEM",
      "OPENCLAW_WORKSPACE_BOOTSTRAP",
      "OPENCLAW_WORKSPACE_DIR",
    ]);
    initContainers.push({
      name: "workspace-node",
      restartPolicy: "Always",
      image: r.image,
      command: roles.fileNode,
      env: [
        ...r.environment.filter((entry) => fileEnvironment.has(entry.name) && "value" in entry),
        { name: "OPENCLAW_NODE_SETUP_PATH", value: "/run/node-enrollment/code" },
      ],
      volumeMounts: [
        { name: "node-scratch", subPath: "home", mountPath: "/home/node" },
        { name: "node-scratch", subPath: "tmp", mountPath: "/tmp" },
        { name: "node-enrollment", mountPath: "/run/node-enrollment", readOnly: true },
        ...mounts.filter(
          (mount) => mount.mountPath === statePath || mount.mountPath === workspacePath,
        ),
      ],
      securityContext,
      startupProbe: {
        exec: {
          command: [
            "node",
            "-e",
            'const s=require("node:net").connect("/tmp/oce-file-baseline.sock");s.on("error",()=>process.exit(1));s.on("connect",()=>s.end());',
          ],
        },
        periodSeconds: 5,
        timeoutSeconds: 3,
        failureThreshold: 180,
      },
      resources: {
        requests: { cpu: "100m", memory: "256Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
    });
  }
  const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata, immutable: true, data };
  const network = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata,
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  "openclaw.dev/namespace": context.namespace.id,
                  "openclaw.dev/agent": context.revision.agentId,
                  "openclaw.dev/workload-role": "gateway",
                },
              },
            },
          ],
          ports: [{ protocol: "TCP", port }],
        },
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": options.kubernetes.controlPlanePeer.namespace,
                },
              },
              podSelector: { matchLabels: options.kubernetes.controlPlanePeer.podLabels },
            },
          ],
          ports: [{ protocol: "TCP", port: STRANDS_STATUS_PORT }],
        },
      ],
      egress: [
        ...(gateway ? [gateway.egress] : []),
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        ...cidrs.map(({ cidr, port: targetPort }) => ({
          to: [{ ipBlock: { cidr } }],
          ports: [{ protocol: "TCP", port: targetPort }],
        })),
      ],
    },
  };
  const workerEgress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      ...metadata,
      namespace: options.kubernetes.controlPlanePeer.namespace,
      name: name + "-readiness",
    },
    spec: {
      podSelector: { matchLabels: options.kubernetes.controlPlanePeer.podLabels },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": context.namespace.name },
              },
              podSelector: { matchLabels: labels },
            },
          ],
          ports: [{ protocol: "TCP", port: STRANDS_STATUS_PORT }],
        },
      ],
    },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata,
    spec: {
      enableServiceLinks: false,
      hostUsers: false,
      shareProcessNamespace: false,
      automountServiceAccountToken: false,
      ...(identity ? { serviceAccountName: identity.serviceAccountName } : {}),
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 20,
      nodeSelector: options.kubernetes.nodeSelector,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes,
      initContainers,
      containers: [
        {
          name: "agent",
          image: r.image,
          command: [
            ...r.command.slice(0, workloadStart),
            "node",
            "/opt/oce/strands-box/outer.mjs",
            `${ROOT}/workload.json`,
          ],
          env: [{ name: "HOME", value: "/home/node" }],
          volumeMounts: [
            ...workloadMounts,
            { name: "probe-auth", mountPath: "/run/strands-box-probe", readOnly: true },
          ],
          securityContext,
          readinessProbe: {
            exec: {
              command: [
                "/usr/local/bin/node",
                "--jitless",
                "/opt/oce/strands-box/readiness.mjs",
                "/run/strands-box-probe/token",
                String(port),
              ],
            },
            periodSeconds: 5,
            timeoutSeconds: 6,
            failureThreshold: 1,
          },
          resources: {
            requests: { cpu: "250m", memory: "1Gi" },
            limits: { cpu: "2", memory: "4Gi" },
          },
        },
        {
          name: "box-workload",
          image: r.image,
          command: [
            "/opt/strands-box/strands-box-contain-trampoline",
            "--receive-container",
            "/run/strands-box/state/private/container.sock",
          ],
          volumeMounts: workloadMounts,
          securityContext: {
            ...securityContext,
            seccompProfile: {
              type: "Localhost",
              localhostProfile: options.kubernetes.seccompProfile,
            },
          },
          resources: {
            requests: { cpu: "250m", memory: "1Gi" },
            limits: { cpu: "2", memory: "4Gi" },
          },
        },
      ],
    },
  };
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata,
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels: metadata.labels, annotations: metadata.annotations },
        spec: { ...pod.spec, restartPolicy: "Always" },
      },
    },
  };
  return [configMap, service, diagnosticService, network, workerEgress, deployment];
}
