import {
  assertExecutionReleaseAllowed,
  credentialSourceMatchesSnapshot,
  isSecretHarnessAuth,
  normalizeSecretBindings,
  type AgentRevision,
  type ComputeDriver,
  type ComputeRevisionContext,
  type CredentialGatewayDriver,
  type CredentialSource,
  type CredentialSourceSnapshot,
  type LegacyEgressProxyDriver,
  type ResolvedHarnessAuth,
  type Secret,
  type SecretBindings,
  type SecretEnvironmentProjection,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, type PostgresPlatformState } from "@openclaw-enterprise/occ";
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

export function validateExecutionAdmission(compute: ComputeDriver, revision: AgentRevision): void {
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

interface RevisionCredentialDependencies {
  readonly state: Pick<PostgresPlatformState, "read" | "transactWithQueue">;
  readonly compute: ComputeDriver;
  readonly secretDriverId: string | undefined;
  readonly credentialGateway: CredentialGatewayDriver | undefined;
  readonly proxyDriver: LegacyEgressProxyDriver | undefined;
}

export function createRevisionCredentialResolver({
  state,
  compute,
  secretDriverId,
  credentialGateway,
  proxyDriver,
}: RevisionCredentialDependencies) {
  async function resolveRevisionCredentialSource(
    revision: Readonly<AgentRevision>,
    snapshot: CredentialSourceSnapshot,
  ) {
    const { namespaceId, id: revisionId } = revision;
    const { sourceId } = snapshot;
    return state.read(async (view) => {
      const source = await view.credentialSources.findCredentialSource(namespaceId, sourceId);
      const withdrawal = await view.credentialSources.findCredentialWithdrawal(
        namespaceId,
        revisionId,
        sourceId,
      );
      return {
        source:
          withdrawal === undefined &&
          source?.state === "ready" &&
          credentialSourceMatchesSnapshot(source, snapshot)
            ? source
            : undefined,
        withdrawal,
      };
    });
  }

  async function resolveRevisionSecretContext(
    revision: Readonly<AgentRevision>,
    operation: "reconcile" | "withdraw",
  ): Promise<
    | { readonly context: ComputeRevisionContext }
    | { readonly result: ReturnType<typeof refuseRevisionInputs>["result"] }
  > {
    try {
      validateExecutionAdmission(compute, revision);
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
      Object.keys(bindings.bindings).length > 0 &&
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

    let harnessAuth: ResolvedHarnessAuth;
    if (isSecretHarnessAuth(revision.harnessAuth)) {
      const auth = revision.harnessAuth;
      if (typeof secretDriverId !== "string" || auth.secretDriverId !== secretDriverId) {
        return refuseRevisionInputs("SECRET_DRIVER_MISMATCH");
      }
      const secret = await state.read((view) =>
        view.secrets.findSecret(auth.source.namespaceId, auth.source.id),
      );
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
      if (credentialGateway === undefined || auth.credentialGatewayId !== credentialGateway.id) {
        return refuseRevisionInputs("CREDENTIAL_GATEWAY_MISMATCH");
      }
      const { source, withdrawal } = await resolveRevisionCredentialSource(revision, auth);
      // A withdrawn source never re-attaches to its revision, for example after Pod loss.
      if (withdrawal !== undefined) {
        return refuseRevisionInputs("CREDENTIAL_WITHDRAWN");
      }
      // A deleting source can no longer be attached, even to an admitted revision.
      if (source === undefined) {
        return refuseRevisionInputs("HARNESS_AUTH_SOURCE_UNAVAILABLE");
      }
      if (source.egress !== undefined) {
        const control = proxyDriver?.sourceControl;
        const provider = control?.providers.find((entry) =>
          isDeepStrictEqual(entry.ref, source.egress!.key.provider),
        );
        if (!provider || !isDeepStrictEqual(control?.backend, source.egress.key.backend)) {
          return refuseRevisionInputs("EGRESS_PROVIDER_UNAVAILABLE");
        }
        // Provider defaults must reach the normal Harness too. In particular, a
        // source with an omitted optional endpoint cannot escape its protected profile.
        harnessAuth = {
          ...auth,
          source: { ...source, config: provider.normalizeConfig(source.config) },
        };
      } else {
        harnessAuth = { ...auth, source };
      }
    } else {
      harnessAuth = revision.harnessAuth;
    }
    const credentialSources: Readonly<CredentialSource>[] = [];
    for (const snapshot of revision.credentialSources ?? []) {
      // The Harness source is listed too; it resolves above through the Harness binding.
      if (snapshot.sourceId === revisionHarnessSourceId(revision)) {
        continue;
      }
      const sourceOwner = snapshot.credentialProxyId ?? snapshot.credentialGatewayId;
      if (
        sourceOwner !==
        (snapshot.credentialProxyId === undefined ? credentialGateway?.id : proxyDriver?.id)
      ) {
        return refuseRevisionInputs("CREDENTIAL_GATEWAY_MISMATCH");
      }
      const { source, withdrawal } = await resolveRevisionCredentialSource(revision, snapshot);
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
        harnessAuth,
        ...(credentialSources.length === 0
          ? {}
          : { credentialSources: Object.freeze(credentialSources) }),
        ...(workspaceSetup === undefined ? {} : { workspaceSetup }),
      },
    };
  }

  return resolveRevisionSecretContext;
}
