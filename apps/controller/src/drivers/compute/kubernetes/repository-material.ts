/// <reference lib="es2024.string" />

import type { V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import type {
  AgentRevision,
  RepositoryCredentialRuntimeBinding,
  RepositoryCredentialSessionFiles,
} from "@openclaw-enterprise/contracts";
import type { RepositoryCredentialClientConfiguration } from "../../repo/credentials/client-contracts.ts";
import {
  hasControlCharacter,
  normalizePushRefAllowlist,
} from "../../repo/credentials/client-contracts.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
  REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
} from "./repository-material-init.ts";
import { SETUP_WRAPPER_COMMAND } from "./runtime-entrypoints.ts";

export const REPOSITORY_MATERIAL_LABEL = "openclaw.dev/repository-material";
export const REPOSITORY_MATERIAL_GENERATION = "openclaw.dev/repository-material-generation";
export const REPOSITORY_MATERIAL_ROOT = "/run/oce/repository-credentials";
export const REPOSITORY_MATERIAL_KEYS = {
  bearer: "bearer",
  "client.json": "client.json",
  gitconfig: "gitconfig",
  "gh/hosts.yml": "gh-hosts.yml",
  "gh/config.yml": "gh-config.yml",
  "ca.pem": "ca.pem",
} as const;

const limits = {
  bearer: 256,
  "client.json": 16 * 1024,
  gitconfig: 16 * 1024,
  "gh/hosts.yml": 16 * 1024,
  "gh/config.yml": 16 * 1024,
  "ca.pem": 64 * 1024,
};
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/;
const gitconfig =
  "[credential]\n\thelper =\n\tuseHttpPath = true\n[http]\n\tfollowRedirects = false\n\tsslVerify = true\n";
const ghConfiguration = "version: 1\nprompt: disabled\ngit_protocol: https\n";

interface RepositoryMaterialIdentity {
  readonly repositoryRef: string;
  readonly sessionId: string;
  readonly deadlineWallMs: number;
  readonly secretName: string;
  readonly directory: string;
}

export interface NewRepositoryMaterialBinding extends RepositoryMaterialIdentity {
  readonly kind: "new";
  readonly files: RepositoryCredentialSessionFiles;
  readonly client: RepositoryCredentialClientConfiguration;
}

interface RetainedRepositoryMaterialBinding extends RepositoryMaterialIdentity {
  readonly kind: "retained";
  readonly files?: never;
  readonly client?: never;
}

export type RepositoryMaterialBinding =
  NewRepositoryMaterialBinding | RetainedRepositoryMaterialBinding;

export interface ResolvedRepositoryMaterialBinding extends RepositoryMaterialIdentity {
  readonly kind: "new" | "retained";
  readonly files: RepositoryCredentialSessionFiles;
  readonly client: RepositoryCredentialClientConfiguration;
}

export interface RepositoryMaterialSpec {
  readonly generation: string;
  readonly bindings: readonly RepositoryMaterialBinding[];
}

export interface ResolvedRepositoryMaterialSpec {
  readonly generation: string;
  readonly bindings: readonly ResolvedRepositoryMaterialBinding[];
}

export function repositoryMaterialCurrent(spec: {
  readonly bindings: readonly Pick<RepositoryMaterialBinding, "deadlineWallMs">[];
}): boolean {
  const now = Date.now();
  return (
    spec.bindings.length > 0 &&
    spec.bindings.every(
      ({ deadlineWallMs }) => Number.isSafeInteger(deadlineWallMs) && deadlineWallMs > now,
    )
  );
}

function invalid(): never {
  throw new Error("Repository credential material is invalid.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function repositoryMaterialSecretName(
  revision: Pick<AgentRevision, "namespaceId" | "agentId" | "id">,
  binding: { readonly repositoryRef: string; readonly sessionId: string },
): string {
  return `oce-repository-${digest([revision.namespaceId, revision.agentId, revision.id, binding.repositoryRef, binding.sessionId]).slice(0, 48)}`;
}

function clientField(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    hasControlCharacter(value)
  ) {
    return invalid();
  }
  return value;
}

function validateClient(value: unknown): RepositoryCredentialClientConfiguration {
  const input = record(value);
  const hasPolicy = Object.hasOwn(input, "pushRefAllowlist");
  if (Object.keys(input).length !== (hasPolicy ? 7 : 6)) {
    return invalid();
  }
  const client: RepositoryCredentialClientConfiguration = {
    gatewayOrigin: clientField(input.gatewayOrigin),
    gitRemote: clientField(input.gitRemote),
    gitUsername: clientField(input.gitUsername),
    canonicalApiHost: clientField(input.canonicalApiHost),
    apiHost: clientField(input.apiHost),
    repository: clientField(input.repository),
    ...(hasPolicy ? { pushRefAllowlist: normalizePushRefAllowlist(input.pushRefAllowlist) } : {}),
  };
  let origin: URL;
  let remote: URL;
  try {
    origin = new URL(client.gatewayOrigin);
    remote = new URL(client.gitRemote);
  } catch {
    return invalid();
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== client.gatewayOrigin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    remote.origin !== origin.origin ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash ||
    !/^\/[A-Za-z0-9._/-]+\.git$/.test(remote.pathname) ||
    remote.pathname.includes("..") ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(client.gitUsername) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(client.apiHost) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(client.canonicalApiHost) ||
    client.apiHost !== origin.hostname ||
    !/^[A-Za-z0-9._/-]{1,512}$/.test(client.repository)
  ) {
    return invalid();
  }
  return Object.freeze(client);
}

export function repositorySessionFiles(
  binding: Pick<RepositoryCredentialRuntimeBinding, "sessionId" | "deadlineWallMs">,
  value: unknown,
): {
  readonly files: RepositoryCredentialSessionFiles;
  readonly client: RepositoryCredentialClientConfiguration;
} {
  const files = record(value);
  const keys = Object.keys(files);
  if (
    typeof binding.sessionId !== "string" ||
    !sessionPattern.test(binding.sessionId) ||
    !Number.isSafeInteger(binding.deadlineWallMs) ||
    binding.deadlineWallMs <= Date.now() ||
    keys.length < 5 ||
    keys.length > 6 ||
    keys.some((key) => !Object.hasOwn(REPOSITORY_MATERIAL_KEYS, key)) ||
    Object.keys(REPOSITORY_MATERIAL_KEYS).some(
      (key) => key !== "ca.pem" && !Object.hasOwn(files, key),
    )
  ) {
    return invalid();
  }
  for (const key of keys) {
    const content = files[key];
    if (
      typeof content !== "string" ||
      content.length === 0 ||
      content.includes("\0") ||
      Buffer.byteLength(content, "utf8") > limits[key as keyof typeof limits] ||
      !content.isWellFormed()
    ) {
      return invalid();
    }
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(files.bearer as string)) {
    return invalid();
  }
  let document: Record<string, unknown>;
  try {
    document = record(JSON.parse(files["client.json"] as string));
  } catch {
    return invalid();
  }
  if (
    Object.keys(document).length !== 4 ||
    document.sessionId !== binding.sessionId ||
    document.deadlineWallMs !== binding.deadlineWallMs ||
    document.hasPublicCa !== Object.hasOwn(files, "ca.pem")
  ) {
    return invalid();
  }
  const client = validateClient(document.client);
  const hosts = `${JSON.stringify(client.canonicalApiHost)}:\n  api_host: ${JSON.stringify(client.apiHost)}\n  git_protocol: https\n  oauth_token: ${JSON.stringify(files.bearer)}\n`;
  if (
    files.gitconfig !== gitconfig ||
    files["gh/config.yml"] !== ghConfiguration ||
    files["gh/hosts.yml"] !== hosts
  ) {
    return invalid();
  }
  return { files: Object.freeze({ ...files }) as RepositoryCredentialSessionFiles, client };
}

export function repositoryMaterialSpec(
  revision: AgentRevision,
  bindings: readonly RepositoryCredentialRuntimeBinding[] | undefined,
): RepositoryMaterialSpec | undefined {
  const admitted = revision.repositoryCredentials;
  if (admitted === undefined) {
    if (bindings !== undefined && (!Array.isArray(bindings) || bindings.length !== 0)) {
      return invalid();
    }
    return undefined;
  }
  if (
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    bindings.length > 16 ||
    !Array.isArray(admitted.bindings) ||
    admitted.bindings.length !== bindings.length ||
    !Number.isSafeInteger(admitted.deadlineWallMs) ||
    admitted.deadlineWallMs <= Date.now()
  ) {
    return invalid();
  }
  const references = new Set(admitted.bindings.map((binding) => binding.repositoryRef));
  const sessions = new Set<string>();
  if (references.size !== bindings.length) {
    return invalid();
  }
  const materialBindings = bindings
    .map((binding): RepositoryMaterialBinding => {
      const input = record(binding);
      const hasAdmissionId = Object.hasOwn(input, "admissionId");
      const expectedKeys =
        binding.kind === "new"
          ? ["kind", "repositoryRef", "sessionId", "deadlineWallMs", "files"]
          : ["kind", "repositoryRef", "sessionId", "deadlineWallMs"];
      if (hasAdmissionId) {
        expectedKeys.push("admissionId");
      }
      if (
        Object.keys(input).length !== expectedKeys.length ||
        expectedKeys.some((key) => !Object.hasOwn(input, key)) ||
        (hasAdmissionId &&
          (typeof binding.admissionId !== "string" || !refPattern.test(binding.admissionId))) ||
        typeof binding.repositoryRef !== "string" ||
        !refPattern.test(binding.repositoryRef) ||
        !references.delete(binding.repositoryRef) ||
        typeof binding.sessionId !== "string" ||
        !sessionPattern.test(binding.sessionId) ||
        sessions.has(binding.sessionId) ||
        (binding.kind !== "new" && binding.kind !== "retained") ||
        !Number.isSafeInteger(binding.deadlineWallMs) ||
        binding.deadlineWallMs <= Date.now() ||
        binding.deadlineWallMs > admitted.deadlineWallMs
      ) {
        return invalid();
      }
      sessions.add(binding.sessionId);
      const identity = {
        repositoryRef: binding.repositoryRef,
        sessionId: binding.sessionId,
        deadlineWallMs: binding.deadlineWallMs,
        secretName: repositoryMaterialSecretName(revision, binding),
        directory: `${REPOSITORY_MATERIAL_ROOT}/sessions/${digest([binding.repositoryRef, binding.sessionId])}`,
      };
      if (binding.kind === "new") {
        return Object.freeze({
          ...identity,
          kind: "new",
          ...repositorySessionFiles(binding, binding.files),
        });
      }
      return Object.freeze({ ...identity, kind: "retained" });
    })
    .sort((left, right) =>
      left.repositoryRef < right.repositoryRef
        ? -1
        : left.repositoryRef > right.repositoryRef
          ? 1
          : 0,
    );
  return Object.freeze({
    generation: digest(
      materialBindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId]),
    ),
    bindings: Object.freeze(materialBindings),
  });
}

export function repositoryMaterialFromSecret(
  binding: RepositoryMaterialBinding,
  secret: unknown,
): ResolvedRepositoryMaterialBinding {
  const object = record(secret);
  if (object.immutable !== true || object.type !== "Opaque") {
    return invalid();
  }
  const data = record(object.data);
  const files: Record<string, string> = {};
  const reverse = new Map<string, string>(
    Object.entries(REPOSITORY_MATERIAL_KEYS).map(([file, key]) => [key, file]),
  );
  for (const [key, value] of Object.entries(data)) {
    const file = reverse.get(key);
    if (
      file === undefined ||
      typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
      return invalid();
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) {
      return invalid();
    }
    try {
      files[file] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return invalid();
    }
  }
  const validated = repositorySessionFiles(binding, files);
  if (binding.files !== undefined && !isDeepStrictEqual(binding.files, validated.files)) {
    return invalid();
  }
  return Object.freeze({ ...binding, ...validated });
}

export function repositoryMaterialDeployment(spec: ResolvedRepositoryMaterialSpec, image: string) {
  const manifest = {
    version: 1,
    generation: spec.generation,
    bindings: spec.bindings.map((binding) => {
      if (binding.client === undefined || binding.files === undefined) {
        return invalid();
      }
      return {
        repositoryRef: binding.repositoryRef,
        sessionId: binding.sessionId,
        deadlineWallMs: binding.deadlineWallMs,
        directory: binding.directory,
        client: binding.client,
      };
    }),
  };
  const volumes: V1Volume[] = [
    {
      name: "repository-material-projection",
      projected: {
        defaultMode: 0o440,
        sources: spec.bindings.map((binding) => ({
          secret: {
            name: binding.secretName,
            optional: false,
            // Secret data is an unordered map; projection items are part of the Pod template.
            items: Object.keys(binding.files)
              .sort()
              .map((file) => ({
                key: REPOSITORY_MATERIAL_KEYS[file as keyof typeof REPOSITORY_MATERIAL_KEYS],
                path: `${binding.directory.slice(binding.directory.lastIndexOf("/") + 1)}/${file}`,
              })),
          },
        })),
      },
    },
    { name: "repository-material-private", emptyDir: { medium: "Memory", sizeLimit: "4Mi" } },
  ];
  const volumeMounts: V1VolumeMount[] = [
    {
      name: "repository-material-private",
      mountPath: REPOSITORY_MATERIAL_ROOT,
      subPath: "private",
      readOnly: true,
    },
  ];
  return {
    volumes,
    volumeMounts,
    initContainers: [
      {
        name: "prepare-repository-material",
        image,
        imagePullPolicy: "IfNotPresent",
        command: [...SETUP_WRAPPER_COMMAND],
        args: [
          REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
          JSON.stringify({
            sourceRoot: "/run/oce/repository-projection",
            targetRoot: "/run/oce/repository-output/private",
            manifest,
          }),
        ],
        volumeMounts: [
          {
            name: "repository-material-projection",
            mountPath: "/run/oce/repository-projection",
            readOnly: true,
          },
          { name: "repository-material-private", mountPath: "/run/oce/repository-output" },
        ],
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
      },
      {
        name: "prepare-repository-native-git",
        image,
        imagePullPolicy: "IfNotPresent",
        command: [...SETUP_WRAPPER_COMMAND],
        args: [REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT, REPOSITORY_MATERIAL_ROOT],
        // The material init creates this owner-only subPath. Mount it directly so
        // native client custody checks never traverse the fsGroup-writable root.
        volumeMounts: volumeMounts.map((mount) => ({ ...mount, readOnly: false })),
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
      },
    ],
  };
}
