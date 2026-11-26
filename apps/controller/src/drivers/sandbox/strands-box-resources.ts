import type { KubernetesObject } from "@kubernetes/client-node";
import type { SandboxHarnessContext } from "@openclaw-enterprise/contracts";
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
import { resolverEgress } from "../kubernetes/network-policy.ts";
import {
  OPENAI_RESPONSES,
  STOCK_BOX_PROFILE,
  receiverEndpointPermits,
  refuse,
  responsesRoute,
  stockModelKey,
} from "./strands-box-model.ts";
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
const SHARED_IMAGE_PATHS = [
  "usr/local/bin/node",
  "usr/bin/env",
  "usr/bin/tini",
  "usr/lib/aarch64-linux-gnu",
  "app",
  "opt/oce",
  "etc/ssl/certs",
  "usr/share/zoneinfo",
];
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
  dns: Parameters<typeof resolverEgress>[0],
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
  const modelKey = stockModelKey(context, options);
  if (
    modelKey &&
    (!roles ||
      literal("CODEX_LOGIN_MODE") !== "api_key" ||
      literal("CODEX_HOME") !== "/home/node/.codex" ||
      workspacePath !== "/home/node/workspace")
  ) {
    refuse();
  }
  const model = literal("OPENCLAW_HARNESS_MODEL");
  if (modelKey && (!model || !/^(?:openai|codex)\/[a-zA-Z0-9._:-]{1,256}$/u.test(model))) {
    refuse();
  }
  const environment: Record<string, string> = {};
  const secretEnvironment: Record<string, string> = {};
  const volumes: Record<string, unknown>[] = [
    { name: "inputs", configMap: { name } },
    { name: "listener-identity", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
    modelKey
      ? { name: "stock-control", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } }
      : { name: "shared-runtime", emptyDir: { sizeLimit: "4Gi" } },
    { name: "private-home", emptyDir: { sizeLimit: "2Gi" } },
    { name: "box-state", emptyDir: { sizeLimit: "256Mi" } },
    { name: "temporary", emptyDir: { sizeLimit: "64Mi" } },
  ];
  if (modelKey) {
    // Pinning follows listener initialization. Mount the optional directory
    // (no subPath) so the listener sees the immutable receipt once created.
    volumes.push({
      name: "listener-receipt",
      configMap: {
        name: `${name}-listener`,
        optional: true,
        items: [{ key: "certificate", path: "certificate" }],
      },
    });
  }
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
    if (modelKey && entry.name === OPENAI_RESPONSES.key) {
      // Box supplies the child environment entry through its credential proxy.
      continue;
    }
    if (
      roles &&
      [
        "OPENCLAW_NODE_SETUP_CODE",
        "OPENCLAW_NODE_STATE_DIR",
        "OPENCLAW_NODE_DISPLAY_NAME",
        "OPENCLAW_WORKSPACE_BOOTSTRAP",
      ].includes(entry.name)
    ) {
      continue;
    }
    if (entry.name === "APP_SERVER_TOKEN") {
      // The supervisor receives only its verifier. The inner relay generates
      // an independent credential for its private native hop.
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
    if (
      modelKey &&
      ![
        "/home/node/workspace",
        "/home/node/.openclaw-node",
        "/home/node/.codex/generated_images",
        "/home/node/.codex/sessions",
      ].includes(mount.mountPath)
    ) {
      refuse();
    }
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
    if (roles && mount.mountPath === statePath) {
      continue;
    }
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
    ...(modelKey && { stockTransport: true }),
    // The split workspace node needs Gateway egress, but the nested Agent needs no tunnel.
    ...(gateway && !modelKey ? { gateway } : {}),
    command: roles ? roles.codex : r.command.slice(workloadStart),
    revisionId: context.revision.id,
    statusPort: STRANDS_STATUS_PORT,
    ...(roles && { workspaceOutcome: "/run/oce-workspace/outcome.sock" }),
    environment,
    secretEnvironment,
    workspace,
    privateDirectories: PRIVATE,
  };
  data["workload.json"] = JSON.stringify(manifest);
  const route = modelKey ? responsesRoute() : undefined;
  const policy = route ? [route.policy] : receiverEndpointPermits(options.policy.network);
  const shellWorkspace = workspace.replace(/^\/home\/node(?=\/)/u, "~");
  policy.push(
    '@id("workspace_shell")\npermit (principal, action == Box::Action::"shell:exec", resource);',
    `@id("workspace_files")\npermit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write", Box::Action::"fs:delete"], resource)\nwhen { context.input.path == ${JSON.stringify(shellWorkspace)} || context.input.path like ${JSON.stringify(`${shellWorkspace}/*`)} };`,
    '@id("dev_null")\npermit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)\nwhen { context.input.path == "/dev/null" };',
  );
  data["policy.dw"] = policy.join("\n");
  // File subPath projections avoid the atomic symlink generation directory that
  // the Box config protection masks. Secret references remain private files.
  const launchMode = modelKey ? "" : "[experimental-features]\ncontainer-agent = true\n";
  data["box.toml"] =
    `name = "${name.slice(0, 32)}"\nbox_dir = "/run/strands-box/state"\npolicy = "${ROOT}/policy.dw"\n${launchMode}[agent]\ncommand = ["/usr/local/bin/node", "--jitless", "/opt/oce/strands-box/inner.mjs", "${ROOT}/workload.json"]\nworkspace = ${JSON.stringify(workspace)}\n[agent.filesystem]\nread = ${JSON.stringify(grantRoots(read))}\nwrite = ${JSON.stringify(grantRoots(write))}\nexec = ["/usr/bin/tini", "/usr/bin/env", "/usr/local/bin/node", "/usr/lib/aarch64-linux-gnu", "/app/node_modules", "/opt/oce/runtime"]\n`;
  if (route) {
    data["box.toml"] += route.egress;
  }
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
      name: "initialize-listener",
      image: r.image,
      command: [
        "node",
        "/opt/oce/strands-box/initialize-listener.mjs",
        `${name}.${context.namespace.name}.svc`,
        `${name}-status.${context.namespace.name}.svc`,
      ],
      env: [{ name: "POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } }],
      volumeMounts: [{ name: "listener-identity", mountPath: "/run/strands-listener" }],
      terminationMessagePath: "/dev/termination-log",
      terminationMessagePolicy: "File",
      securityContext,
    },
  ];
  if (!modelKey) {
    initContainers.push({
      name: "prepare-shared-runtime",
      image: r.image,
      imagePullPolicy: "IfNotPresent",
      securityContext,
      command: [
        "/bin/bash",
        "-euo",
        "pipefail",
        "-c",
        // An init-container retry can reuse the Pod's emptyDir. Publish only a complete tree.
        `cd /shared-runtime
if test -d image; then exit 0; fi
if test -d preparing; then
  find preparing -type d -exec chmod u+rwx {} +
  rm -rf -- preparing
fi
mkdir preparing
chmod g-s preparing
tar -C / -cf - -- "$@" | tar -C preparing --no-same-owner --delay-directory-restore -xf -
mv -T preparing image`,
        "prepare",
        ...SHARED_IMAGE_PATHS,
      ],
      volumeMounts: [{ name: "shared-runtime", mountPath: "/shared-runtime" }],
    });
  }
  initContainers.push({
    name: "initialize-workspace-directories",
    image: r.image,
    command: ["/usr/bin/tini", "-s", "--", "node", "-e", ...nodeProgramArguments(initialize)],
    volumeMounts: initMounts,
    securityContext,
  });
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
  // Only the two-container receiver needs shared executable identities.
  const workloadMounts = [
    ...mounts.filter((mount) => !roles || mount.mountPath !== statePath),
    ...(modelKey
      ? [{ name: "stock-control", mountPath: "/run/strands-stock", readOnly: true }]
      : SHARED_IMAGE_PATHS.map((path) => ({
          name: "shared-runtime",
          mountPath: `/${path}`,
          subPath: `image/${path}`,
          readOnly: true,
        }))),
  ];
  if (roles && enrollment && "valueFrom" in enrollment) {
    const setup = enrollment.valueFrom.secretKeyRef;
    volumes.push(
      { name: "workspace-outcome", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
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
        { name: "workspace-outcome", mountPath: "/run/oce-workspace" },
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
            'const s=require("node:net").connect("/run/oce-workspace/outcome.sock");s.on("error",()=>process.exit(1));s.resume();',
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
        resolverEgress(dns),
        ...cidrs.map(({ cidr, port: targetPort }) => ({
          to: [{ ipBlock: { cidr } }],
          ports: [{ protocol: "TCP", port: targetPort }],
        })),
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
      ...(modelKey && { runtimeClassName: "oce-strands-box" }),
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
            ...(modelKey
              ? [
                  {
                    name: "inputs",
                    mountPath: `${ROOT}/workload.json`,
                    subPath: "workload.json",
                    readOnly: true,
                  },
                  { name: "stock-control", mountPath: "/run/strands-stock" },
                  { name: "listener-receipt", mountPath: "/run/strands-receipt", readOnly: true },
                ]
              : workloadMounts),
            ...(roles
              ? [{ name: "workspace-outcome", mountPath: "/run/oce-workspace", readOnly: true }]
              : []),
            { name: "listener-identity", mountPath: "/run/strands-listener" },
          ],
          securityContext,
          readinessProbe: {
            exec: {
              command: [
                "/usr/local/bin/node",
                "--jitless",
                "/opt/oce/strands-box/readiness.mjs",
                "/run/strands-listener/probe.sock",
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
          command: modelKey
            ? ["/usr/local/bin/node", "--jitless", "/opt/oce/strands-box/stock-launch.mjs"]
            : [
                "/opt/strands-box/strands-box-contain-trampoline",
                "--receive-container",
                "/run/strands-box/state/private/container.sock",
              ],
          ...(modelKey && {
            env: [{ name: OPENAI_RESPONSES.launcherKey, valueFrom: { secretKeyRef: modelKey } }],
          }),
          volumeMounts: workloadMounts,
          securityContext: {
            ...securityContext,
            // The released launcher mounts private procfs in a nested PID namespace.
            ...(modelKey && {
              procMount: "Unmasked",
              appArmorProfile: { type: "Localhost", localhostProfile: STOCK_BOX_PROFILE },
            }),
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
  return [configMap, service, diagnosticService, network, deployment];
}
