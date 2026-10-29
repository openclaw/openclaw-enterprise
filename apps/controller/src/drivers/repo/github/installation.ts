import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { SandboxRepositoryRecipientUnverifiedError } from "@openclaw-enterprise/occ";
import type { GitHubRepositoryCredentialBackendDefinition } from "@openclaw-enterprise/contracts";
import {
  rejectNativeRepositoryPath,
  closed,
  nonempty,
  object,
  openShellRepositoryConfiguration,
} from "../../../composition/installation-fields.ts";
import type { SelectedDriverConfiguration } from "../../../composition/installation-config.ts";
import type { PreparedRepositoryGitConfiguration } from "../../../backends/repository-credentials/prepared-git-owner.ts";
import { preparedGitHubConfiguration } from "./credentials/prepared-configuration.ts";
import type { GitHubRepositoryRegistry } from "./credentials/registry.ts";

function nativeRepositorySenderConfiguration(input: unknown) {
  const native = object(input, "repository.nativeSender");
  closed(native, ["controlSocket", "publicCaPath"], "repository.nativeSender");
  const configuration = {
    controlSocket: nonempty(native.controlSocket, "repository.nativeSender.controlSocket"),
    publicCaPath: nonempty(native.publicCaPath, "repository.nativeSender.publicCaPath"),
  };
  for (const field of ["controlSocket", "publicCaPath"] as const) {
    const path = configuration[field];
    if (!isAbsolute(path) || resolve(path) !== path || /\p{Cc}/u.test(path)) {
      rejectNativeRepositoryPath(
        field === "publicCaPath" ? "public-ca-format" : "control-socket-format",
      );
    }
    if (field === "controlSocket" && Buffer.byteLength(path, "utf8") > 103) {
      rejectNativeRepositoryPath("control-socket-length");
    }
  }
  return configuration;
}

/** Interpret the existing public GitHub selection at its Repo owner. */
export function githubRepositoryConfiguration(input: unknown, mode: "development" | "production") {
  if (input === undefined) {
    return undefined;
  }
  const selection = object(input, "repository");
  closed(
    selection,
    ["id", "configuration", "preparedGitHub", "openShell", "nativeSender"],
    "repository",
  );
  const nativeSender =
    selection.nativeSender === undefined
      ? undefined
      : nativeRepositorySenderConfiguration(selection.nativeSender);
  return {
    selection,
    nativeSender,
    prepared:
      selection.preparedGitHub === undefined
        ? undefined
        : (preparedGitHubConfiguration(
            selection.preparedGitHub,
            true,
          ) as PreparedRepositoryGitConfiguration),
    transport: openShellRepositoryConfiguration(selection.openShell, mode),
  };
}

/** Repo selects one supported delivery capability, before composition binds its transport. */
export function selectGitHubRepositoryDelivery(
  repository: ReturnType<typeof githubRepositoryConfiguration>,
  input: {
    externalProxy: boolean;
    bundledProxy: boolean;
    sandbox: boolean;
    bundledSandbox: boolean;
    openShellBackend: boolean;
    kubernetes: boolean;
  },
): "native" | "protected" | undefined {
  if (!repository) {
    return undefined;
  }
  const { nativeSender, prepared, transport, selection } = repository;
  const external = input.externalProxy && !!prepared && !transport;
  if (
    nativeSender &&
    (!prepared || input.sandbox || input.bundledProxy || input.externalProxy || transport)
  ) {
    throw new Error(
      "repository.nativeSender requires prepared GitHub custody without a Sandbox or Credential Proxy; protected Git cannot fall back to native delivery.",
    );
  }
  if (!nativeSender && !external && !(transport && input.bundledProxy)) {
    throw new Error(
      "repository requires explicitly selected protected Git delivery and prepared GitHub custody.",
    );
  }
  const policy = object(selection.configuration, "repository.configuration");
  if (external && (policy.controlSocket !== undefined || policy.publicCaPath !== undefined)) {
    throw new Error("Protected repository Git does not accept native broker configuration.");
  }
  if (!input.kubernetes || (input.sandbox && !transport && !external)) {
    if (input.openShellBackend && input.bundledSandbox) {
      throw new SandboxRepositoryRecipientUnverifiedError();
    }
    throw new Error(
      "repository requires the bundled Kubernetes Compute Driver and a supported Git delivery selection.",
    );
  }
  return nativeSender ? "native" : "protected";
}

/** No key bytes or raw registry cross into generic installed-Driver identity composition. */
export function githubRepositoryAuthorityIdentity(
  selection: SelectedDriverConfiguration,
  backend: GitHubRepositoryCredentialBackendDefinition,
  registry: GitHubRepositoryRegistry,
  configuration: ReturnType<typeof githubRepositoryConfiguration>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ selection, backend, registry, configuration }, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")))
          : value,
      ),
    )
    .digest("hex");
}
