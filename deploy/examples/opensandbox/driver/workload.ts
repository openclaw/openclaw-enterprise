import { X509Certificate } from "node:crypto";
import type {
  V1Container,
  V1EnvVar,
  V1PodTemplateSpec,
  V1Volume,
  V1VolumeMount,
} from "@kubernetes/client-node";
import type { ErrorDetail, SandboxHarnessContext } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

export interface DriverConfiguration {
  readonly codexSeccompProfile?: string;
  readonly modelSenderCaPem?: string;
}

export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    codexSeccompProfile: { type: "string", minLength: 1, maxLength: 255 },
    modelSenderCaPem: { type: "string", minLength: 1, maxLength: 8192 },
  },
});

export function validateConfiguration(
  configuration: Readonly<DriverConfiguration>,
): readonly ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  const profile = configuration.codexSeccompProfile;
  if (
    profile !== undefined &&
    !profile.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(part))
  ) {
    errors.push({
      code: "INVALID_VALUE",
      path: "/codexSeccompProfile",
      message: "Use the reviewed node-local Codex seccomp profile path without traversal.",
    });
  }
  const pem = configuration.modelSenderCaPem;
  if (pem !== undefined) {
    const invalid = () =>
      errors.push({
        code: "INVALID_VALUE",
        path: "/modelSenderCaPem",
        message:
          "Use a single public PEM certificate for the model sender's certificate authority.",
      });
    if (
      !/^-----BEGIN CERTIFICATE-----\r?\n(?:[a-zA-Z0-9+/=]+\r?\n)+-----END CERTIFICATE-----$/u.test(
        pem.trim(),
      )
    ) {
      invalid();
    } else {
      try {
        if (!new X509Certificate(pem).ca) {
          invalid();
        }
      } catch {
        invalid();
      }
    }
  }
  return errors;
}

export const TRANSPORT_PORT = 18_790;
const STATUS_PORT = 18_791;
const HOME_PATH = "/home/node";
const FILE_DIRECTORY = "/etc/openclaw/plugin-runtime";
const WORKSPACE_CLAIM = "workspace";
const SECURITY_CONTEXT = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};

const runtimeFiles = {
  "runtime.json": "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
  "config.toml": "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
} as const;

function unsupported(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
}

function baseProcess(name: string, image: string): V1Container {
  return {
    name,
    image,
    imagePullPolicy: "IfNotPresent",
    securityContext: SECURITY_CONTEXT,
  };
}

function appendRuntimeFiles(
  context: SandboxHarnessContext,
  env: V1EnvVar[],
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of context.requirements.files) {
    if (
      (file.name !== "runtime.json" && file.name !== "config.toml") ||
      file.environmentVariable !== runtimeFiles[file.name] ||
      Object.hasOwn(files, file.name) ||
      Buffer.byteLength(file.content, "utf8") > 48 * 1024
    ) {
      unsupported("OpenSandbox received unsupported Codex runtime files.");
    }
    // The supported runtime files carry admitted model endpoint configuration. Plugin
    // installation or credential delivery needs its own admission and network policy.
    if (file.name === "runtime.json") {
      const manifest = asRecord(JSON.parse(file.content));
      const selections = asRecord(manifest?.selections);
      if (
        manifest?.kind !== "codex" ||
        selections === undefined ||
        Object.values(selections).some((selection) => asRecord(selection)?.enabled !== false) ||
        manifest.egressEnrollment !== undefined ||
        manifest.repositoryBrokerNetworkPolicy !== undefined
      ) {
        unsupported("OpenSandbox supports ordinary Codex runtime files without enabled plugins.");
      }
    }
    files[file.name] = file.content;
    env.push({ name: file.environmentVariable, value: `${FILE_DIRECTORY}/${file.name}` });
  }
  if (context.requirements.files.length !== 0 && context.requirements.files.length !== 2) {
    unsupported("OpenSandbox requires both admitted Codex runtime files.");
  }
  return files;
}

const prepareDirectories = String.raw`
const { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const { files, directories, senderCa, enrollNode } = JSON.parse(process.argv[1]);
function ensurePrivateDirectory(path) {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined && (!existing.isDirectory() || existing.uid !== process.getuid())) {
    throw new Error("The workspace or private state contains an invalid directory.");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
for (const path of directories) ensurePrivateDirectory(path);
if (enrollNode) {
  // Read both keys from one kubelet projection. After pairing, the retained
  // node identity must reconnect without presenting the spent setup code.
  const snapshot = require("node:fs").realpathSync("/node-enrollment/..data");
  const device = snapshot + "/device";
  if (require("node:fs").existsSync(device)) {
    if (!/^[a-f0-9]{64}$/.test(readFileSync(device, "utf8"))) {
      throw new Error("Invalid recorded workspace device.");
    }
  } else {
    const code = readFileSync(snapshot + "/code", "utf8");
    if (!code || Buffer.byteLength(code) > 65536) throw new Error("Missing workspace setup.");
    writeFileSync("/node-start/code", code, { mode: 0o600, flag: "wx" });
  }
}
for (const [name, content] of Object.entries(files)) {
  const path = "/runtime-files/" + name;
  if (dirname(path) !== "/runtime-files") throw new Error("Invalid runtime file name.");
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
}
if (senderCa !== undefined) {
  const systemCa = readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8");
  writeFileSync("/runtime-files/model-sender-ca.pem", systemCa + "\n" + senderCa + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
`;

export function harnessTemplate(
  context: SandboxHarnessContext,
  labels: Readonly<Record<string, string>>,
  configuration: Readonly<DriverConfiguration>,
): V1PodTemplateSpec {
  const { requirements, revision } = context;
  if (
    revision.harness.id !== "codex" ||
    revision.harness.mode !== "dedicated" ||
    revision.executionAdmission.mode !== "unprotected" ||
    revision.credentialDeployment !== undefined ||
    revision.egressPlan !== undefined ||
    revision.repositoryCredentials !== undefined ||
    requirements.proxyWiring !== undefined ||
    requirements.credentialAttachments.length !== 0 ||
    requirements.workspaceSetup !== undefined ||
    requirements.loginMode !== "api_key"
  ) {
    unsupported(
      "OpenSandbox supports ordinary API-key dedicated Codex without protected credentials or initial file setup.",
    );
  }
  const [command, ...args] = requirements.command;
  if (!command || !/^.+@sha256:[a-f0-9]{64}$/u.test(requirements.image)) {
    unsupported("OpenSandbox requires a digest-pinned image and an explicit Harness command.");
  }
  const workspacePaths = new Map(
    requirements.retainedDirectories.map((directory) => [directory.path, directory.name]),
  );
  const claim = requirements.workspaceMounts[0]?.claimName;
  if (
    !claim ||
    workspacePaths.size !== requirements.retainedDirectories.length ||
    requirements.workspaceMounts.length !== workspacePaths.size ||
    new Set(requirements.workspaceMounts.map(({ mountPath }) => mountPath)).size !==
      workspacePaths.size ||
    new Set(requirements.workspaceMounts.map(({ subPath }) => subPath)).size !==
      workspacePaths.size ||
    requirements.workspaceMounts.some(
      ({ claimName, mountPath, subPath, readOnly }) =>
        claimName !== claim ||
        workspacePaths.get(mountPath) !== subPath ||
        !/^([a-z0-9][a-z0-9-]*)$/u.test(subPath) ||
        ![
          "/home/node/workspace",
          "/home/node/.codex/generated_images",
          "/home/node/.codex/sessions",
          "/home/node/.openclaw-node",
        ].includes(mountPath) ||
        readOnly,
    )
  ) {
    unsupported(
      "OpenSandbox requires the retained directories on one Compute-owned workspace claim.",
    );
  }

  const env: V1EnvVar[] = requirements.environment.map((variable) =>
    "valueFrom" in variable
      ? {
          name: variable.name,
          valueFrom: { secretKeyRef: { ...variable.valueFrom.secretKeyRef, optional: false } },
        }
      : { name: variable.name, value: variable.value },
  );
  for (const name of ["APP_SERVER_TOKEN", "OPENAI_API_KEY", "OPENCLAW_NODE_SETUP_CODE"]) {
    const input = env.find((entry) => entry.name === name);
    if (input !== undefined && input.valueFrom?.secretKeyRef === undefined) {
      unsupported("OpenSandbox requires Kubernetes Secret references for Harness credentials.");
    }
  }
  if (
    !env.some(({ name, valueFrom }) => name === "APP_SERVER_TOKEN" && valueFrom?.secretKeyRef) ||
    !env.some(({ name, value }) => name === "APP_SERVER_PORT" && value === String(TRANSPORT_PORT))
  ) {
    unsupported("OpenSandbox requires the admitted Codex transport Secret and port.");
  }

  // Check the original inputs before removing the setup Secret from the environment.
  const files = appendRuntimeFiles(context, env);
  const names = new Set(env.map(({ name }) => name));
  if (names.size !== env.length) {
    unsupported("OpenSandbox received duplicate runtime environment inputs.");
  }
  const enrollment = env.find((entry) => entry.name === "OPENCLAW_NODE_SETUP_CODE");
  const setup = enrollment?.valueFrom?.secretKeyRef;
  if (enrollment) {
    env.splice(env.indexOf(enrollment), 1);
  }
  const senderCa = configuration.modelSenderCaPem?.trim();
  for (const input of [
    ...(setup ? [{ name: "OPENCLAW_NODE_SETUP_PATH", value: "/node-start/code" }] : []),
    ...(senderCa === undefined
      ? []
      : [
          { name: "SSL_CERT_FILE", value: `${FILE_DIRECTORY}/model-sender-ca.pem` },
          { name: "NODE_EXTRA_CA_CERTS", value: `${FILE_DIRECTORY}/model-sender-ca.pem` },
        ]),
    { name: "OPENCLAW_AGENT_REVISION_ID", value: revision.id },
    { name: "OPENCLAW_RUNTIME_STATUS_CONTAINER", value: "agent" },
    { name: "OPENCLAW_RUNTIME_STATUS_PORT", value: String(STATUS_PORT) },
    { name: "OPENCLAW_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
  ]) {
    if (names.has(input.name)) {
      unsupported("OpenSandbox received a conflicting runtime status setting.");
    }
    env.push(input);
  }

  const volumes: V1Volume[] = [
    { name: WORKSPACE_CLAIM, persistentVolumeClaim: { claimName: claim } },
    { name: "runtime-home", emptyDir: { sizeLimit: "2Gi" } },
    { name: "runtime-tmp", emptyDir: { sizeLimit: "64Mi" } },
  ];
  const volumeMounts: V1VolumeMount[] = [
    { name: "runtime-home", mountPath: HOME_PATH, subPath: "home" },
    { name: "runtime-tmp", mountPath: "/tmp", subPath: "tmp" },
    ...requirements.workspaceMounts.map((mount) => ({
      name: WORKSPACE_CLAIM,
      subPath: mount.subPath,
      mountPath: mount.mountPath,
      readOnly: mount.readOnly,
    })),
  ];
  const prepareMounts: V1VolumeMount[] = [
    { name: WORKSPACE_CLAIM, mountPath: "/workspace-claim" },
    { name: "runtime-home", mountPath: "/runtime-home" },
    { name: "runtime-tmp", mountPath: "/runtime-tmp" },
  ];
  if (setup) {
    if (!setup.name || setup.key !== "setupCode") {
      unsupported("OpenSandbox requires the Agent workspace setup Secret.");
    }
    volumes.push(
      {
        name: "node-enrollment",
        secret: {
          secretName: setup.name,
          optional: true,
          defaultMode: 0o440,
          items: [
            { key: setup.key, path: "code" },
            { key: "deviceId", path: "device" },
          ],
        },
      },
      { name: "node-start", emptyDir: { medium: "Memory", sizeLimit: "128Ki" } },
    );
    prepareMounts.push(
      { name: "node-enrollment", mountPath: "/node-enrollment", readOnly: true },
      { name: "node-start", mountPath: "/node-start" },
    );
    volumeMounts.push({ name: "node-start", mountPath: "/node-start", readOnly: true });
  }
  const directories = [
    "/runtime-home/home",
    "/runtime-home/home/.codex",
    "/runtime-tmp/tmp",
    ...requirements.workspaceMounts.map(({ subPath }) => `/workspace-claim/${subPath}`),
  ];
  if (requirements.files.length > 0 || senderCa !== undefined) {
    volumes.push({ name: "runtime-files", emptyDir: { sizeLimit: "1Mi" } });
    volumeMounts.push({ name: "runtime-files", mountPath: FILE_DIRECTORY, readOnly: true });
    prepareMounts.push({ name: "runtime-files", mountPath: "/runtime-files" });
  }
  const identity = requirements.workloadIdentity;
  if (identity !== undefined) {
    if (
      identity.token.readOnly !== true ||
      identity.token.mountPath !== "/var/run/secrets/openclaw/service-principal"
    ) {
      unsupported("OpenSandbox cannot preserve the admitted workload identity projection.");
    }
    const { audience, expirationSeconds, path } = identity.token;
    volumes.push({
      name: "service-principal",
      projected: { sources: [{ serviceAccountToken: { audience, expirationSeconds, path } }] },
    });
    volumeMounts.push({
      name: "service-principal",
      mountPath: identity.token.mountPath,
      readOnly: true,
    });
  }
  return {
    metadata: { labels: { ...labels } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      ...(identity === undefined ? {} : { serviceAccountName: identity.serviceAccountName }),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes,
      initContainers: [
        {
          ...baseProcess("prepare-workspace", requirements.image),
          command: ["/usr/bin/tini", "--", "node", "-e"],
          args: [
            prepareDirectories,
            JSON.stringify({ directories, files, senderCa, enrollNode: setup !== undefined }),
          ],
          volumeMounts: prepareMounts,
        },
      ],
      containers: [
        {
          ...baseProcess("agent", requirements.image),
          command: [command],
          args,
          env,
          volumeMounts,
          ports: [
            { name: "websocket", containerPort: TRANSPORT_PORT },
            { name: "plugin-status", containerPort: STATUS_PORT },
          ],
          // The OCE runtime's readyz performs an authenticated app-server upgrade.
          readinessProbe: {
            httpGet: { path: "/readyz", port: "plugin-status" },
            periodSeconds: 2,
            timeoutSeconds: 3,
          },
          ...(configuration.codexSeccompProfile === undefined
            ? {}
            : {
                securityContext: {
                  ...SECURITY_CONTEXT,
                  seccompProfile: {
                    type: "Localhost",
                    localhostProfile: configuration.codexSeccompProfile,
                  },
                },
              }),
        },
      ],
    },
  };
}
