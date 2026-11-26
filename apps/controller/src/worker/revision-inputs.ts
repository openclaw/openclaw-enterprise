import {
  assertExecutionReleaseAllowed,
  credentialSourceMatchesSnapshot,
  isNativeStagedRepositoryRevision,
  isSecretHarnessAuth,
  normalizeSecretBindings,
  type AgentRevision,
  type ComputeDriver,
  type ComputeRevisionContext,
  type StoredCredentialSource as CredentialSource,
  type CredentialSourceSnapshot,
  type LegacyEgressProxyDriver,
  type ResolvedHarnessAuth,
  type Secret,
  type SecretBindings,
  type SecretEnvironmentProjection,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  type PlatformReadView,
  type PostgresPlatformState,
} from "@openclaw-enterprise/occ";
import { isDeepStrictEqual } from "node:util";
import { revisionEgressReceipts } from "./revision-egress-receipts.ts";

export const UNSUPPORTED_REPOSITORY_POLICY_PLACEMENT = "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED";

function refuseRevisionInputs(code: string) {
  return { result: { outcome: "permanent", code } } as const;
}

export function revisionSecretBindings(
  revision: Readonly<AgentRevision>,
):
  | { readonly bindings: SecretBindings }
  | { readonly result: ReturnType<typeof refuseRevisionInputs>["result"] } {
  try {
    return { bindings: normalizeSecretBindings(revision.secretBindings) };
  } catch {
    return refuseRevisionInputs("INVALID_SECRET_BINDINGS");
  }
}

export function revisionHarnessSourceId(revision: Readonly<AgentRevision>): string | undefined {
  return revision.harnessAuth.method === "credential_source"
    ? revision.harnessAuth.sourceId
    : undefined;
}

export function validateExecutionAdmission(
  compute: ComputeDriver,
  revision: AgentRevision,
  credentialDeliveryRef?: NonNullable<AgentRevision["credentialDeployment"]>["driver"],
): void {
  if (
    revision.executionAdmission.mode === "standalone" &&
    (credentialDeliveryRef === undefined ||
      !isDeepStrictEqual(revision.credentialDeployment?.driver, credentialDeliveryRef))
  ) {
    throw new DependencyUnavailableError("The staged credential Driver registration changed.");
  }
  if (compute.validateExecutionAdmission === undefined) {
    assertExecutionReleaseAllowed(revision);
  } else {
    compute.validateExecutionAdmission(revision, "stored");
  }
}

export async function validateRepositoryNetworkPolicy(
  compute: ComputeDriver,
  revision: AgentRevision,
): Promise<void> {
  if (revision.sandboxPolicy?.repositoryNetworkPolicy !== undefined) {
    if (revision.executionAdmission.mode === "standalone") {
      if (!isNativeStagedRepositoryRevision(revision) || !compute.validateRepositoryCredentials) {
        throw new DependencyUnavailableError(
          "The staged revision has no supported native Repository binding.",
        );
      }
      compute.validateRepositoryCredentials(revision.harness, revision.sandboxDriverId);
      return;
    }
    if (compute.validateProtectedRepositoryNetworkPolicy === undefined) {
      throw new DependencyUnavailableError(
        "The selected Compute cannot enforce this repository network policy.",
      );
    }
    await compute.validateProtectedRepositoryNetworkPolicy(revision);
  }
}

function projectableSecretBackend(ref: Secret["backendRef"]): boolean {
  return (
    ref.namespaceName.trim().length > 0 &&
    ref.name.trim().length > 0 &&
    ref.key.trim().length > 0 &&
    ref.uid.trim().length > 0
  );
}

export async function resolveRevisionCredentialSource(
  state: Pick<PostgresPlatformState, "read">,
  revision: Readonly<AgentRevision>,
  snapshot: CredentialSourceSnapshot,
  view?: PlatformReadView,
) {
  const { namespaceId, id: revisionId } = revision;
  const { sourceId } = snapshot;
  const loadSource = async (readView: PlatformReadView) => {
    const withdrawal = await readView.credentialSources.findCredentialWithdrawal(
      namespaceId,
      revisionId,
      sourceId,
    );
    if (withdrawal !== undefined) {
      return { source: undefined, withdrawal };
    }
    const source = await readView.credentialSources.findCredentialSource(namespaceId, sourceId);
    return {
      source:
        source?.state === "ready" && credentialSourceMatchesSnapshot(source, snapshot)
          ? source
          : undefined,
      withdrawal,
    };
  };
  return view === undefined ? state.read(loadSource) : loadSource(view);
}

interface RevisionCredentialDependencies {
  readonly state: Pick<PostgresPlatformState, "read" | "transactWithQueue">;
  readonly compute: ComputeDriver;
  readonly secretDriverId: string | undefined;
  readonly proxyDriver: LegacyEgressProxyDriver | undefined;
  readonly credentialDeliveryRef:
    NonNullable<AgentRevision["credentialDeployment"]>["driver"] | undefined;
  readonly currentTokenServiceInstanceId: () => string | undefined;
}

/** Resolve the admitted model dependency using the caller's read view when supplied. */
export async function resolveRevisionHarnessAuth(
  revision: Readonly<AgentRevision>,
  {
    state,
    secretDriverId,
    currentTokenServiceInstanceId,
  }: Pick<
    RevisionCredentialDependencies,
    "state" | "secretDriverId" | "currentTokenServiceInstanceId"
  >,
  view?: PlatformReadView,
): Promise<
  | { readonly harnessAuth: ResolvedHarnessAuth }
  | { readonly result: ReturnType<typeof refuseRevisionInputs>["result"] }
> {
  let harnessAuth: ResolvedHarnessAuth;
  if (isSecretHarnessAuth(revision.harnessAuth)) {
    const auth = revision.harnessAuth;
    if (typeof secretDriverId !== "string" || auth.secretDriverId !== secretDriverId) {
      return refuseRevisionInputs("SECRET_DRIVER_MISMATCH");
    }
    const loadSecret = (readView: PlatformReadView) =>
      readView.secrets.findSecret(auth.source.namespaceId, auth.source.id);
    const secret = view === undefined ? await state.read(loadSecret) : await loadSecret(view);
    if (
      secret === undefined ||
      secret.namespaceId !== revision.namespaceId ||
      secret.namespaceId !== auth.source.namespaceId ||
      secret.id !== auth.source.id ||
      secret.driverId !== secretDriverId ||
      !projectableSecretBackend(secret.backendRef)
    ) {
      return refuseRevisionInputs("HARNESS_AUTH_SOURCE_UNAVAILABLE");
    }
    // Admission verifies the physical source. Workers project authoritative
    // OCC metadata without requiring permission to read backend Secret values.
    harnessAuth = { ...auth, backendRef: secret.backendRef };
  } else if (revision.harnessAuth.method === "credential_source") {
    const auth = revision.harnessAuth;
    if (
      auth.tokenServiceInstanceId === undefined ||
      !revision.credentialDeployment ||
      currentTokenServiceInstanceId() !== auth.tokenServiceInstanceId
    ) {
      return refuseRevisionInputs("CREDENTIAL_SOURCE_UNAVAILABLE");
    }
    const { source, withdrawal } = await resolveRevisionCredentialSource(
      state,
      revision,
      auth,
      view,
    );
    if (withdrawal !== undefined) {
      return refuseRevisionInputs("CREDENTIAL_WITHDRAWN");
    }
    if (
      source === undefined ||
      source.ownerCapability !== "token_service" ||
      source.tokenServiceInstanceId !== auth.tokenServiceInstanceId
    ) {
      return refuseRevisionInputs("HARNESS_AUTH_SOURCE_UNAVAILABLE");
    }
    harnessAuth = auth;
  } else {
    harnessAuth = revision.harnessAuth;
  }
  return { harnessAuth };
}

export function createRevisionCredentialResolver(dependencies: RevisionCredentialDependencies) {
  const {
    state,
    compute,
    secretDriverId,
    proxyDriver,
    credentialDeliveryRef,
    currentTokenServiceInstanceId,
  } = dependencies;

  async function resolveRevisionSecretContext(
    revision: Readonly<AgentRevision>,
    operation: "reconcile" | "withdraw",
  ): Promise<
    | { readonly context: ComputeRevisionContext }
    | { readonly result: { readonly outcome: "pending" | "permanent"; readonly code: string } }
  > {
    try {
      validateExecutionAdmission(compute, revision, credentialDeliveryRef);
    } catch {
      return refuseRevisionInputs("EXECUTION_ADMISSION_UNAVAILABLE");
    }
    // Withdrawal can remove existing access even when the placement cannot install the policy.
    if (operation === "reconcile") {
      try {
        await validateRepositoryNetworkPolicy(compute, revision);
      } catch {
        return refuseRevisionInputs(
          revision.executionAdmission.mode === "unprotected"
            ? UNSUPPORTED_REPOSITORY_POLICY_PLACEMENT
            : "EXECUTION_ADMISSION_UNAVAILABLE",
        );
      }
    }
    const bindings = revisionSecretBindings(revision);
    if ("result" in bindings) {
      return bindings;
    }
    if (
      (Object.keys(bindings.bindings).length > 0 ||
        revision.networkProxy?.credentialSecretId !== undefined) &&
      (typeof secretDriverId !== "string" || revision.secretDriverId !== secretDriverId)
    ) {
      return refuseRevisionInputs("SECRET_DRIVER_MISMATCH");
    }

    const resolved = await state.read(async (view) => {
      const projections: SecretEnvironmentProjection[] = [];
      for (const [name, binding] of Object.entries(bindings.bindings)) {
        const secret = await view.secrets.findSecret(binding.source.namespaceId, binding.source.id);
        if (
          secret === undefined ||
          secret.namespaceId !== revision.namespaceId ||
          secret.driverId !== secretDriverId ||
          !projectableSecretBackend(secret.backendRef)
        ) {
          return undefined;
        }
        projections.push({
          name,
          secretId: secret.id,
          namespaceId: secret.namespaceId,
          agentId: revision.agentId,
          backendRef: secret.backendRef,
        });
      }
      return projections;
    });

    if (resolved === undefined) {
      return refuseRevisionInputs("SECRET_BINDING_UNAVAILABLE");
    }

    let networkProxyCredential: ComputeRevisionContext["networkProxyCredential"];
    const networkProxySecretId = revision.networkProxy?.credentialSecretId;
    if (networkProxySecretId !== undefined) {
      const secret = await state.read((view) =>
        view.secrets.findSecret(revision.namespaceId, networkProxySecretId),
      );
      if (
        secret === undefined ||
        secret.driverId !== secretDriverId ||
        !projectableSecretBackend(secret.backendRef)
      ) {
        return refuseRevisionInputs("NETWORK_PROXY_SECRET_UNAVAILABLE");
      }
      networkProxyCredential = {
        secretId: secret.id,
        namespaceId: secret.namespaceId,
        agentId: revision.agentId,
        backendRef: secret.backendRef,
      };
    }

    const model = await resolveRevisionHarnessAuth(revision, dependencies);
    if ("result" in model) {
      return model;
    }
    const credentialSources: Readonly<CredentialSource>[] = [];
    for (const snapshot of revision.credentialSources ?? []) {
      // The Harness source is listed too; it resolves above through the Harness binding.
      if (snapshot.sourceId === revisionHarnessSourceId(revision)) {
        continue;
      }
      if (snapshot.tokenServiceInstanceId !== undefined) {
        if (
          !revision.credentialDeployment ||
          currentTokenServiceInstanceId() !== snapshot.tokenServiceInstanceId
        ) {
          return refuseRevisionInputs("CREDENTIAL_SOURCE_UNAVAILABLE");
        }
        const bindings = revision.credentialDeployment.bindings.filter(
          ({ sourceRef }) => sourceRef.id === snapshot.sourceId,
        );
        if (
          bindings.length === 0 ||
          bindings.some(
            ({ consumer }) => consumer.kind !== "plugin" && consumer.kind !== "repository",
          )
        ) {
          return refuseRevisionInputs("CREDENTIAL_SOURCE_UNAVAILABLE");
        }
        const { source, withdrawal } = await resolveRevisionCredentialSource(
          state,
          revision,
          snapshot,
        );
        if (withdrawal?.state === "pending") {
          return { result: { outcome: "pending", code: "CREDENTIAL_WITHDRAWAL_PENDING" } };
        }
        if (withdrawal?.state === "revoked") {
          continue;
        }
        if (
          source === undefined ||
          source.ownerCapability !== "token_service" ||
          source.tokenServiceInstanceId !== snapshot.tokenServiceInstanceId
        ) {
          return refuseRevisionInputs("CREDENTIAL_SOURCE_UNAVAILABLE");
        }
        continue;
      }
      if (
        snapshot.credentialProxyId === undefined ||
        snapshot.credentialProxyId !== proxyDriver?.id
      ) {
        return refuseRevisionInputs("CREDENTIAL_SOURCE_UNAVAILABLE");
      }
      const { source, withdrawal } = await resolveRevisionCredentialSource(
        state,
        revision,
        snapshot,
      );
      // A withdrawn non-model source stays detached; the revision keeps running without it.
      if (withdrawal !== undefined) {
        continue;
      }
      if (source === undefined) {
        return refuseRevisionInputs("CREDENTIAL_SOURCE_UNAVAILABLE");
      }
      credentialSources.push(source);
    }
    const workspaceSetup = await state.read((view) =>
      view.workspaceSetups.find(revision.namespaceId, revision.agentId),
    );
    if (workspaceSetup !== undefined && compute.supportsWorkspaceSetup !== true) {
      return refuseRevisionInputs("WORKSPACE_SETUP_UNSUPPORTED");
    }
    return {
      context: {
        ...(revision.egressPlan === undefined ? {} : revisionEgressReceipts(state, revision)),
        secretEnvironment: Object.freeze(resolved),
        ...(networkProxyCredential === undefined ? {} : { networkProxyCredential }),
        harnessAuth: model.harnessAuth,
        ...(credentialSources.length === 0
          ? {}
          : { credentialSources: Object.freeze(credentialSources) }),
        ...(workspaceSetup === undefined ? {} : { workspaceSetup }),
      },
    };
  }

  return resolveRevisionSecretContext;
}
