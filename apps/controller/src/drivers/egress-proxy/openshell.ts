import { randomUUID } from "node:crypto";
import {
  jointCondition,
  jointOwnerEvidence,
  jointSourcePolicy,
  liveJointFence,
  jointSuccessor,
  readJointEnforcement,
  sameJointPredecessor,
} from "./openshell-joint-policy.ts";
import { wirePolicy } from "./openshell-wire-policy.ts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import { bindOpenShellExchange } from "./openshell-exchange-binding.ts";
import { openShellGitMiddleware, type OpenShellGitRuntime } from "./openshell-git-runtime.ts";
import { repositoryGitDeliveryProfile, requireConfiguration } from "@openclaw-enterprise/contracts";
import type {
  CredentialProviderDefinition,
  ErrorDetail,
  RepositoryGitDeliveryProfile,
} from "@openclaw-enterprise/contracts";
import { credentialFreeMetadataProvider } from "./github-metadata.ts";
import { isDeepStrictEqual } from "node:util";
import type {
  Backend,
  CredentialSourceControl,
  ProxyWiring,
  EgressInstallation,
  ProxyPlan,
  CredentialProxyDriver,
  ProxyRevisionContext,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  isReducedCredentialPlan,
  RepositoryGitProfileUnsupportedError,
  RepositoryGitSenderUnqualifiedError,
} from "@openclaw-enterprise/occ";
import { asRecord, immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import { type OpenShellGateway, openShellWorkspaceName } from "../../backends/openshell.ts";
import {
  confirmSandboxAbsent,
  gatewayIdentityRefusal,
} from "../sandbox/openshell-gateway-errors.ts";
import {
  advertisesOpenShellExecutionProfile,
  jointWorkspaceProfile,
  openShellExchangeCapabilities as capabilities,
} from "./openshell-exchange-capabilities.ts";
import { codexWorkspaceRoutes, codexWorkspaceProviderRef } from "./codex-workspace-provider.ts";
import { verifiedCodexWorkspaceProvider } from "./codex-workspace-identity.ts";
import { openAiStaticProvider } from "./openai-provider.ts";

export interface OpenShellProxyOptions {
  readonly middlewareName: string;
  readonly repositoryMiddlewareName?: string;
  /** Installation operator promises a dedicated, operator-controlled stock 0.1.5 gateway. */
  readonly observedHookPreviewWorkspace?: string;
  readonly authorityScope: "execution";
}

// Retain uint64 revisions as decimal strings: Number would lose generation precision.
function revisionNumber(value: unknown): string | undefined {
  // Proto3 omits a scalar zero; the enclosing evidence message remains mandatory.
  if (value === undefined) {
    return "0";
  }
  return typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
    ? value
    : undefined;
}

function enforcementEvidence(
  status: Readonly<Record<string, unknown>>,
  sandboxId: string,
  policyVersion: number,
  revisionId: string,
  options: OpenShellProxyOptions,
): EgressInstallation["enforcement"] | undefined {
  const revision = asRecord(status.revision);
  const observation = asRecord(status.loaded_policy_observation);
  const source = asRecord(revision?.policy);
  const effective = asRecord(observation?.effective_policy);
  const evidence = asRecord(observation?.enforcement);
  const registeredKey = observation?.registered_exchange_public_key;
  const authority = asRecord(asRecord(effective?.network_middlewares)?.["oce-egress"]);
  if (
    !revision ||
    !observation ||
    !source ||
    !effective ||
    !evidence ||
    !(registeredKey instanceof Uint8Array) ||
    registeredKey.byteLength !== 32 ||
    evidence.sandbox_id !== sandboxId ||
    typeof evidence.instance_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      evidence.instance_id,
    ) ||
    revision.version !== policyVersion ||
    status.active_version !== policyVersion ||
    ![2, "POLICY_STATUS_LOADED"].includes(revision.status as string | number) ||
    evidence.policy_version !== policyVersion ||
    typeof evidence.policy_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(evidence.policy_hash) ||
    typeof revision.policy_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(revision.policy_hash) ||
    observation.source_policy_hash !== revision.policy_hash ||
    revisionNumber(evidence.config_revision) === undefined ||
    revisionNumber(evidence.provider_env_revision) === undefined ||
    authority?.execution_authority !== true ||
    authority.credential_authority !== true ||
    authority.middleware !== options.middlewareName ||
    (authority.credential_connectors !== undefined &&
      !isDeepStrictEqual(authority.credential_connectors, [])) ||
    !isDeepStrictEqual(evidence.enforced_capabilities, capabilities)
  ) {
    return undefined;
  }
  // This V1 observation trusts the registered supervisor and the producer's full
  // typed comparison, including fields outside our protobuf projection. It grants
  // no send authority. Unknown derivations must not produce an observation.
  const inertRule = observation.inert_provider_rule ?? "";
  if (inertRule === "") {
    if (
      evidence.policy_hash !== revision.policy_hash ||
      !isDeepStrictEqual(wirePolicy(source), wirePolicy(effective))
    ) {
      return undefined;
    }
  } else {
    const expectedName = `_provider_oce_runtime_${sha256Hex(revisionId, 16)}`;
    const sourceRules = asRecord(source.network_policies) ?? {};
    const effectiveRules = asRecord(effective.network_policies);
    if (
      inertRule !== expectedName ||
      evidence.policy_hash === revision.policy_hash ||
      !effectiveRules ||
      Object.hasOwn(sourceRules, expectedName) ||
      !isDeepStrictEqual(wirePolicy(effectiveRules[expectedName]), { name: expectedName }) ||
      !isDeepStrictEqual(
        wirePolicy(source),
        wirePolicy({
          ...effective,
          network_policies: Object.fromEntries(
            Object.entries(effectiveRules).filter(([name]) => name !== expectedName),
          ),
        }),
      )
    ) {
      return undefined;
    }
  }
  return {
    instanceId: evidence.instance_id,
    policyHash: evidence.policy_hash,
    peerKeyId: Buffer.from(registeredKey).toString("base64url"),
    authorityScope: "execution" as const,
    // Local change fence, not the supplier's canonical policy hash. Both supplier
    // identities and complete decoded policies must remain stable on revalidation.
    configurationId: sha256Hex(
      JSON.stringify([
        sandboxId,
        evidence.instance_id,
        policyVersion,
        observation.source_policy_hash,
        evidence.policy_hash,
        revisionNumber(evidence.config_revision),
        revisionNumber(evidence.provider_env_revision),
        capabilities,
        wirePolicy(source),
        wirePolicy(effective),
        inertRule,
      ]),
    ),
  };
}

// The controller can run on a different architecture from the dedicated Harness.
// Match the two canonical ELF paths in the pinned runtime package, never its npm launcher.
const codexPackageRoot =
  "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2";
const workspaceBinaries = [
  {
    path:
      codexPackageRoot +
      "-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
  },
  {
    path:
      codexPackageRoot +
      "-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex",
  },
];

/** Nonsecret, exact routing consumed and independently checked by the paired Sandbox. */
export function openShellEgressConfiguration(
  plan: ProxyPlan,
  options: OpenShellProxyOptions,
): Readonly<Record<string, unknown>> {
  if (new Set(plan.routes.map((route) => route.binding.binding.id)).size > 1) {
    throw new Error("The protected execution permits at most one binding.");
  }
  requireConfiguration(OpenShellCredentialProxyDriver, options);
  const workspace = plan.routes.some(
    ({ binding }) =>
      binding.grant.kind === "workspace_inference" ||
      binding.source.provider.id === codexWorkspaceProviderRef.id,
  );
  const joint = options.middlewareName === jointWorkspaceProfile;
  if (
    joint &&
    (plan.policyReductionVersion !== 3 ||
      !options.repositoryMiddlewareName ||
      options.repositoryMiddlewareName === options.middlewareName ||
      plan.repositoryGitAuthorization !== "online-request" ||
      plan.harnessCredentialSource ||
      (plan.repositoryGit &&
        repositoryGitDeliveryProfile(plan.repositoryGit) !== "github_installation") ||
      (plan.generation === 1
        ? !plan.repositoryGit || !workspace
        : plan.generation !== 2 || !!plan.repositoryGit === workspace))
  ) {
    throw new DependencyUnavailableError(
      "The joint workspace sender requires its admitted model and installation grants.",
    );
  }
  if (workspace) {
    const binding = plan.routes[0]!.binding;
    if (
      (!joint &&
        (options.middlewareName !== codexWorkspaceProviderRef.id ||
          options.repositoryMiddlewareName !== undefined ||
          plan.repositoryGit !== undefined ||
          plan.repositoryGitAuthorization !== undefined)) ||
      plan.harnessCredentialSource !== undefined ||
      binding.source.installationId !== plan.execution.installationId ||
      binding.source.namespaceId !== plan.execution.namespaceId ||
      binding.grant.kind !== "workspace_inference" ||
      !isDeepStrictEqual(binding.source.provider, codexWorkspaceProviderRef) ||
      !isDeepStrictEqual(binding.execution, plan.execution) ||
      !isDeepStrictEqual(plan.routes, codexWorkspaceRoutes(binding))
    ) {
      throw new DependencyUnavailableError(
        "The bundled workspace sender requires its exact model-only plan and registration.",
      );
    }
  }
  const hosts = [...new Set(plan.routes.map((route) => new URL(route.origin).hostname))];
  // Keep the authority installed for a zero-route plan. The selector names no
  // reachable rule: network_policies below remains empty, never a wildcard.
  if (!hosts.length) {
    hosts.push("deny-egress.invalid");
  }
  if (!workspace && (hosts.length !== 1 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hosts[0]!))) {
    throw new Error("Protected egress requires one literal host.");
  }
  const gitMiddleware = () => {
    const value = openShellGitMiddleware(
      options.repositoryMiddlewareName!,
      plan.execution.executionId,
    );
    return joint
      ? { "oce-prepared-git": { ...value["oce-prepared-git"], require_execution_admission: true } }
      : value;
  };
  if (plan.repositoryGit && !workspace) {
    if (plan.routes.length || !options.repositoryMiddlewareName) {
      throw new DependencyUnavailableError(
        "This Credential Proxy cannot install the admitted repository plan.",
      );
    }
    // The prepared provider supplies the endpoints for the admitted GitHub scope. No generic exchange
    // authority, broad Git network rule or second credential-bearing sender accompanies it.
    return immutableCopy({
      network_policies: {},
      network_middlewares: gitMiddleware(),
    });
  }
  return immutableCopy({
    network_policies: Object.fromEntries(
      plan.routes.map((route, index) => {
        const origin = new URL(route.origin);
        return [
          `oce-egress-${index}`,
          {
            name: `oce-egress-${index}`,
            ...(workspace && { binaries: workspaceBinaries }),
            endpoints: [
              {
                host: origin.hostname,
                ports: [Number(origin.port || 443)],
                protocol: "rest",
                enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
                ...(workspace
                  ? { rules: [{ allow: { method: route.method, path: route.path } }] }
                  : { access: "NETWORK_ACCESS_PRESET_FULL" }),
                path: route.path,
              },
            ],
          },
        ];
      }),
    ),
    network_middlewares: {
      ...(plan.repositoryGit && joint && gitMiddleware()),
      "oce-egress": {
        name: "oce-egress",
        middleware: options.middlewareName,
        on_error: "fail_closed",
        endpoints: { include: hosts },
        credential_authority: true,
        execution_authority: true,
      },
    },
  });
}

export class OpenShellCredentialProxyDriver implements CredentialProxyDriver {
  readonly capability = "credential_proxy" as const;
  readonly implementation = "openshell";
  readonly id: string;
  readonly sourceControl: CredentialSourceControl;
  readonly policyReduction?: NonNullable<CredentialProxyDriver["policyReduction"]>;
  readonly bindExchange?: NonNullable<CredentialProxyDriver["bindExchange"]>;
  readonly bindRepositoryGit?: NonNullable<CredentialProxyDriver["bindRepositoryGit"]>;
  private readonly previewEnforcement?: OpenShellGitRuntime["previewEnforcement"];
  private readonly backend: Backend<OpenShellGateway>;
  private readonly sandbox: SandboxDriver;
  private readonly options: OpenShellProxyOptions;

  static readonly configurationSchema = {
    type: "object",
    additionalProperties: false,
    required: ["middlewareName", "authorityScope"],
    properties: {
      middlewareName: { type: "string", minLength: 1 },
      repositoryMiddlewareName: { type: "string", minLength: 1 },
      observedHookPreviewWorkspace: { type: "string", maxLength: 19, minLength: 1 },
      authorityScope: { type: "string", const: "execution" },
    },
  };

  static validateConfiguration(configuration: unknown): readonly ErrorDetail[] {
    const value = asRecord(configuration);
    if (
      !value ||
      Object.keys(value).some(
        (key) =>
          ![
            "middlewareName",
            "authorityScope",
            "repositoryMiddlewareName",
            "observedHookPreviewWorkspace",
          ].includes(key),
      ) ||
      typeof value.middlewareName !== "string" ||
      !value.middlewareName.trim() ||
      (value.observedHookPreviewWorkspace !== undefined &&
        (typeof value.observedHookPreviewWorkspace !== "string" ||
          !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(value.observedHookPreviewWorkspace))) ||
      value.authorityScope !== "execution"
    ) {
      return [
        {
          path: "",
          code: "INVALID_VALUE",
          message: "Invalid protected OpenShell egress configuration.",
        },
      ];
    }
    return [];
  }

  constructor(
    options: OpenShellProxyOptions,
    selection: {
      readonly id: string;
      readonly backend: Backend<OpenShellGateway>;
      readonly sandbox: SandboxDriver;
      readonly exchangeAuthority?: EgressAuthorityConfiguration;
      readonly bindRepositoryGit?: NonNullable<CredentialProxyDriver["bindRepositoryGit"]>;
      readonly previewEnforcement?: OpenShellGitRuntime["previewEnforcement"];
      readonly preparedProviders?: readonly CredentialProviderDefinition[];
    },
  ) {
    requireConfiguration(OpenShellCredentialProxyDriver, options);
    if (selection.sandbox.harnessResource === undefined) {
      throw new Error("Invalid protected OpenShell egress configuration.");
    }
    if (selection.bindRepositoryGit) {
      this.bindRepositoryGit = selection.bindRepositoryGit;
    }
    const exchange = selection.exchangeAuthority;
    const joint = options.middlewareName === jointWorkspaceProfile;
    const workspace = joint || options.middlewareName === codexWorkspaceProviderRef.id;
    if (
      (joint &&
        (!options.repositoryMiddlewareName ||
          options.repositoryMiddlewareName === options.middlewareName ||
          !selection.bindRepositoryGit ||
          options.observedHookPreviewWorkspace)) ||
      (workspace && (!exchange || (!joint && options.repositoryMiddlewareName)))
    ) {
      throw new Error("The workspace registration requires its dedicated installation exchange.");
    }
    if (exchange) {
      this.bindExchange = (createProxy) =>
        bindOpenShellExchange(exchange, this.sourceControl.sender, createProxy);
    }
    if (options.observedHookPreviewWorkspace && selection.previewEnforcement) {
      this.previewEnforcement = selection.previewEnforcement;
    }
    this.id = selection.id;
    this.backend = selection.backend;
    this.sandbox = selection.sandbox;
    this.options = immutableCopy(options);
    if (joint) {
      this.policyReduction = {
        version: 3,
        assertAvailable: async (signal) => {
          await this.sourceControl.assertAvailable(signal, "github_installation");
        },
        prepare: async (context, expected, retained) => {
          if (!(await this.verifyInstallation(context, expected))) {
            return undefined;
          }
          return jointCondition(expected, retained);
        },
        apply: async (context, request, retainedCurrent) => {
          const old = request.expected;
          const condition = jointCondition(old, request.retained);
          if (
            !condition ||
            !isDeepStrictEqual(condition, request.condition) ||
            !(await this.verifyInstallation(context, old))
          ) {
            return;
          }
          const observed = await this.loadedPolicy(context, old.sandboxId);
          if (!observed) {
            return;
          }
          const rpc = observed.client.advanceJointReduction?.bind(observed.client);
          const live = await rpc?.(observed.workspace, observed.name, undefined, context.signal);
          const current = asRecord(live?.current);
          if (
            !current ||
            !sameJointPredecessor(current, old) ||
            live?.pending ||
            live?.fence ||
            live?.joint_authority_verified !== true ||
            live?.credential_installed !== true
          ) {
            return;
          }
          if (!retainedCurrent || !(await retainedCurrent())) {
            return;
          }
          context.signal.throwIfAborted();
          await rpc!(
            observed.workspace,
            observed.name,
            {
              ...current,
              action: request.retained.repositoryGit ? "fence-model" : "fence-git",
              operation_id: request.operationId,
              policy: { ...asRecord(current.policy), effective_policy: condition.remainingPolicy },
            },
            context.signal,
          );
        },
        advance: async (context, request, retainedCurrent) => {
          const effects = context.policyEffects;
          const old = request.expected;
          const signal = context.signal;
          if (!effects) {
            return;
          }
          const observed = await this.loadedPolicy(context, old.sandboxId, true);
          if (!observed) {
            return;
          }
          const { client, workspace, name, existing, status } = observed;
          const rpc = client.advanceJointReduction?.bind(client);
          const fence =
            rpc && liveJointFence(await rpc(workspace, name, undefined, signal), request);
          if (
            !fence ||
            existing.mainProcessInstanceId !== fence.j.processInstanceId ||
            !existing.resourceVersion
          ) {
            return;
          }
          const { cmd, j, condition } = fence;
          const expectedProviders = [
            ...(j.runtimeProvider ? [j.runtimeProvider] : []),
            ...j.recipients.map((r) => r.provider_name),
          ];
          const finalSource = jointSourcePolicy(
            condition.remainingPolicy,
            j.recipients,
            j.runtimeProvider,
          );
          const oldSource = jointSourcePolicy(j.effectivePolicy, j.recipients, j.runtimeProvider);
          const revision = asRecord(status.revision);
          if (
            !finalSource ||
            !oldSource ||
            !revision ||
            status.active_version !== revision.version ||
            ![2, "POLICY_STATUS_LOADED"].includes(revision.status as string | number)
          ) {
            return;
          }
          const prefix = request.operationId + ":";
          const identity = (data: unknown) =>
            sha256Hex(JSON.stringify(wirePolicy([request.operationId, fence.receipt, data])));
          const reserve = async (step: string, id: string) => {
            const state = {
              requestId: randomUUID(),
              identity: id,
              expectedVersion: existing.resourceVersion!,
            };
            if (!(await effects.compare(prefix + step, undefined, state))) {
              return;
            }
            const stillFenced = liveJointFence(
              await rpc!(workspace, name, undefined, signal),
              request,
            );
            if (
              !stillFenced ||
              !isDeepStrictEqual(stillFenced.receipt, fence.receipt) ||
              !(await retainedCurrent())
            ) {
              return;
            }
            signal.throwIfAborted();
            return state;
          };
          const detached: string[] = [];
          if (!request.retained.repositoryGit) {
            let epoch = j.recipients[0]!.attachment_epoch;
            for (const [i, leg] of j.recipients.entries()) {
              const step = "detach-" + i;
              const id = identity([leg, epoch]);
              const row = await effects.read(prefix + step);
              if (!row) {
                if (
                  revision.version !== old.plan.generation ||
                  !isDeepStrictEqual(wirePolicy(revision.policy), wirePolicy(oldSource)) ||
                  existing.spec?.provider_attachment_epoch !== epoch ||
                  !isDeepStrictEqual(existing.spec?.providers, expectedProviders)
                ) {
                  return;
                }
                const state = await reserve(step, id);
                if (!state) {
                  return;
                }
                const result = await client.detachSandboxProvider(
                  workspace,
                  name,
                  leg.provider_name,
                  signal,
                  { expectedResourceVersion: state.expectedVersion, requestId: state.requestId },
                );
                if (result?.detached === true && result.receiptId) {
                  await effects.compare(prefix + step, state, {
                    ...state,
                    receipt: result.receiptId,
                  });
                }
                return;
              }
              if (row.identity !== id || !row.receipt || detached.includes(row.receipt)) {
                return;
              }
              const nextEpoch = await this.detachedEpoch(observed, leg, epoch, row.receipt, signal);
              if (!nextEpoch) {
                return;
              }
              detached.push(row.receipt);
              epoch = nextEpoch;
              expectedProviders.splice(expectedProviders.indexOf(leg.provider_name), 1);
            }
            if (existing.spec?.provider_attachment_epoch !== epoch) {
              return;
            }
          } else if (
            existing.spec?.provider_attachment_epoch !== j.recipients[0]!.attachment_epoch
          ) {
            return;
          }
          if (!isDeepStrictEqual(existing.spec?.providers, expectedProviders)) {
            return;
          }
          const updateId = identity([detached, finalSource]);
          const write = await effects.read(prefix + "policy");
          if (!write) {
            if (
              revision.version !== old.plan.generation ||
              !isDeepStrictEqual(wirePolicy(revision.policy), wirePolicy(oldSource)) ||
              !client.updatePolicy
            ) {
              return;
            }
            const state = await reserve("policy", updateId);
            if (!state) {
              return;
            }
            await client.updatePolicy(
              {
                workspace,
                sandbox: name,
                policy: finalSource,
                requestId: state.requestId,
                expectedResourceVersion: state.expectedVersion,
              },
              signal,
            );
            await effects.compare(prefix + "policy", state, { ...state, receipt: state.requestId });
            return;
          }
          if (
            write.identity !== updateId ||
            write.receipt !== write.requestId ||
            revision.version !== request.retained.generation ||
            !isDeepStrictEqual(wirePolicy(revision.policy), wirePolicy(finalSource))
          ) {
            return;
          }
          const { challenge: _challenge, ...original } = cmd;
          const successor = {
            ...original,
            action: request.retained.repositoryGit ? "retain-git" : "successor",
            fence_receipt: fence.receipt,
            detach_receipt_ids: detached,
          };
          if (
            (await effects.read(prefix + "successor")) ||
            !(await reserve("successor", identity(successor)))
          ) {
            return;
          }
          await rpc!(workspace, name, successor, signal);
        },
        observe: async (context, request) => {
          const observed = await this.loadedPolicy(context, request.expected.sandboxId, true);
          if (!observed) {
            return undefined;
          }
          const reply = await observed.client.advanceJointReduction?.(
            observed.workspace,
            observed.name,
            undefined,
            context.signal,
          );
          const journal = context.policyEffects;
          if (!journal) {
            return undefined;
          }
          const prefix = request.operationId + ":";
          const state = await journal.read(prefix + "successor");
          const fence = asRecord(reply?.fence);
          const last = asRecord(reply?.last_result);
          const cmd = asRecord(last?.command);
          const original = asRecord(fence?.command);
          if (!state || !cmd || !original || !fence) {
            return undefined;
          }
          const receipts: string[] = [];
          let epoch: string | undefined;
          if (!request.retained.repositoryGit) {
            const j = jointOwnerEvidence(request.expected.enforcement);
            if (!j) {
              return undefined;
            }
            epoch = j.recipients[0]!.attachment_epoch;
            for (const [index, leg] of j.recipients.entries()) {
              const step = await journal.read(prefix + "detach-" + index);
              if (!step?.receipt) {
                return undefined;
              }
              epoch = await this.detachedEpoch(observed, leg, epoch, step.receipt, context.signal);
              if (!epoch) {
                return undefined;
              }
              receipts.push(step.receipt);
            }
          }
          const outcome = jointSuccessor(reply, request, observed.existing, observed.status, epoch);
          if (!outcome) {
            return undefined;
          }
          const { challenge: _challenge, ...body } = original;
          const dispatched = {
            ...body,
            action: cmd.action,
            fence_receipt: fence.receipt,
            detach_receipt_ids: receipts,
          };
          if (
            !isDeepStrictEqual(receipts, cmd.detach_receipt_ids ?? []) ||
            state.identity !==
              sha256Hex(
                JSON.stringify(wirePolicy([request.operationId, fence.receipt, dispatched])),
              )
          ) {
            return undefined;
          }
          // A lost successor acknowledgement can be reconciled from the authenticated
          // original result. The already-reserved command is never dispatched again.
          const receipt = sha256Hex(JSON.stringify(wirePolicy(last)));
          if (
            state.receipt
              ? state.receipt !== receipt
              : !(await journal.compare(prefix + "successor", state, { ...state, receipt }))
          ) {
            return undefined;
          }
          return outcome;
        },
      };
    }
    this.sourceControl = Object.freeze({
      backend: { id: selection.backend.id, generation: 1 },
      sender: { id: `${selection.backend.id}/supervisor`, generation: 1 },
      resolver: { id: `${selection.id}/resolver`, generation: 1 },
      providers: [
        openAiStaticProvider,
        credentialFreeMetadataProvider,
        ...(workspace ? [verifiedCodexWorkspaceProvider] : []),
        ...(selection.preparedProviders ?? []),
      ],
      assertAvailable: async (signal: AbortSignal, profile?: RepositoryGitDeliveryProfile) => {
        if (joint) {
          if (profile !== undefined && profile !== "github_installation") {
            throw new RepositoryGitSenderUnqualifiedError();
          }
        }
        // Independent modes keep their original release gate. The joint profile also
        // requires positive authenticated admission from both selected senders.
        if (!joint) {
          this.assertRepositoryGitProfileAvailable(profile);
        }
        const client = this.backend.client.clientForNamespace("");
        if (!client.getGatewayInfo) {
          throw new DependencyUnavailableError(
            "The selected OpenShell counterpart does not support protected egress.",
          );
        }
        const info = await client.getGatewayInfo(signal);
        const extensions = info.extensions;
        const git = profile === "repository_git" || profile === "github_installation";
        if (joint) {
          const registered = (name: string) =>
            (Array.isArray(extensions) ? extensions : []).filter(
              (value) => asRecord(value)?.configured_name === name,
            );
          const model = registered(options.middlewareName);
          const repo = registered(options.repositoryMiddlewareName!);
          const exact = (rows: typeof model, identity: string) => {
            const row = asRecord(rows[0]);
            return (
              rows.length === 1 &&
              row?.implementation_name === identity &&
              row.implementation_version === "1" &&
              row.protocol_major === 1 &&
              [4, "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE"].includes(row.kind as string | number)
            );
          };
          const modelRow = asRecord(model[0]);
          const gitRow = asRecord(repo[0]);
          if (
            !client.advanceJointReduction ||
            !exact(model, "oce/static-egress") ||
            !advertisesOpenShellExecutionProfile(modelRow?.required_capabilities) ||
            !advertisesOpenShellExecutionProfile(modelRow?.supported_capabilities) ||
            !exact(repo, "oce/online-request-authorization") ||
            ![gitRow?.required_capabilities, gitRow?.supported_capabilities].every(
              (value) =>
                Array.isArray(value) && value.includes("openshell.supervisor-middleware.contract"),
            )
          ) {
            throw new DependencyUnavailableError(
              "Joint access requires both authenticated middleware registrations.",
            );
          }
          return profile === "github_installation"
            ? { profile, authorization: "online-request" as const }
            : undefined;
        }
        const registration = git ? options.repositoryMiddlewareName : options.middlewareName;
        if (
          !registration ||
          !Array.isArray(extensions) ||
          (workspace &&
            extensions.filter((value) => asRecord(value)?.configured_name === registration)
              .length !== 1) ||
          !extensions.some((value) => {
            const item = asRecord(value);
            return (
              item?.configured_name === registration &&
              (item.kind === "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE" || item.kind === 4) &&
              item.protocol_major === 1 &&
              (!workspace ||
                (item.implementation_name === "oce/static-egress" &&
                  item.implementation_version === "1")) &&
              (git ||
                (advertisesOpenShellExecutionProfile(item.required_capabilities) &&
                  advertisesOpenShellExecutionProfile(item.supported_capabilities)))
            );
          })
        ) {
          throw new DependencyUnavailableError(
            "The selected OpenShell counterpart has no negotiated protected egress authority.",
          );
        }
        // Advertise the explicitly selected assurance. The held launcher, actual policy and
        // recipient must still be verified before any usable Git credential is selected.
        if (
          profile === "github_installation" &&
          this.options.observedHookPreviewWorkspace &&
          this.previewEnforcement &&
          info.gateway_version === "0.1.5"
        ) {
          return { profile, authorization: "request-hook-observed" as const };
        }
        if (git) {
          if (this.options.observedHookPreviewWorkspace && profile === "github_installation") {
            throw new DependencyUnavailableError(
              "The observed-hook preview requires the qualified stock 0.1.5 gateway.",
            );
          }
          return { profile, authorization: "online-request" as const };
        }
      },
    });
  }

  /** Stock may offer the observed-hook preview only by explicit Installation opt-in. The
   * repository profile's online-request authorization has no qualified release: the release
   * gate (`repositoryGitEnforcement`) never observes enforcement for it, so admission refuses
   * it here instead of leaving its Harness to wait out enrollment (finding 2199). A sender that
   * qualifies it must replace both checks together. */
  protected assertRepositoryGitProfileAvailable(
    profile: RepositoryGitDeliveryProfile | undefined,
  ): void {
    if (profile === "repository_git") {
      throw new RepositoryGitSenderUnqualifiedError();
    }
    if (
      profile === "github_installation" &&
      !(this.options.observedHookPreviewWorkspace && this.previewEnforcement)
    ) {
      throw new DependencyUnavailableError(
        "This OpenShell Driver is not qualified for GitHub installation access.",
      );
    }
  }

  async configureRevision(context: ProxyRevisionContext): Promise<ProxyWiring> {
    this.assertPlan(context);
    const profile = repositoryGitDeliveryProfile(context.plan.repositoryGit);
    if (context.plan.repositoryGit !== undefined && profile === undefined) {
      // Finding 2204: never check a Git plan's counterpart as an ordinary egress plan. Deploy
      // refuses it first; preparation repeats the refusal so the worker fails it at once.
      throw new RepositoryGitProfileUnsupportedError();
    }
    await this.sourceControl.assertAvailable(context.signal, profile);
    return immutableCopy({
      plan: context.plan,
      configuration: openShellEgressConfiguration(context.plan, this.options),
    });
  }

  async wiringStatus(
    context: ProxyRevisionContext,
    prepared: ProxyWiring,
  ): Promise<EgressInstallation | undefined> {
    this.assertPlan(context);
    if (!isDeepStrictEqual(prepared.plan, context.plan)) {
      throw new Error("The prepared Sandbox policy has a different admitted plan.");
    }
    const observed = await this.loadedPolicy(context);
    if (!observed) {
      return undefined;
    }
    const { status, sandboxId } = observed;
    const revision = asRecord(status.revision);
    const policy = asRecord(revision?.policy);
    const protectedConfiguration = openShellEgressConfiguration(context.plan, this.options);
    const expected = prepared.configuration;
    const expectedPolicies = asRecord(expected.network_policies);
    if (
      !expectedPolicies ||
      Object.keys(expectedPolicies).some(
        (key) => !key.startsWith("oce-egress-") && key !== "workspace-node-enrollment",
      ) ||
      !isDeepStrictEqual(
        wirePolicy(expected.network_middlewares),
        wirePolicy(protectedConfiguration.network_middlewares),
      ) ||
      !isDeepStrictEqual(
        wirePolicy(
          Object.fromEntries(
            Object.entries(expectedPolicies).filter(([name]) => name.startsWith("oce-egress-")),
          ),
        ),
        wirePolicy(protectedConfiguration.network_policies),
      )
    ) {
      throw new Error("The prepared Sandbox policy changed protected egress routes.");
    }
    const policies = asRecord(policy?.network_policies);
    // The authenticated supervisor must report loading the exact policy. A desired spec,
    // provider name or running Pod alone is not installation evidence.
    if (
      !revision ||
      !policy ||
      // Protobuf omits the map when deny-all has no rules (even auxiliary rules).
      (Object.keys(expectedPolicies).length > 0 && !policies) ||
      Number(status.active_version) !== context.plan.generation ||
      Number(revision.version) !== context.plan.generation ||
      ![2, "POLICY_STATUS_LOADED"].includes(revision.status as string | number) ||
      !isDeepStrictEqual(
        wirePolicy(policy.network_middlewares),
        wirePolicy(expected.network_middlewares),
      )
    ) {
      return undefined;
    }
    // The paired Sandbox supplies the entire admitted source, including filesystem,
    // process and auxiliary rules. Network-only equality cannot establish that source.
    if (!isDeepStrictEqual(wirePolicy(policy), wirePolicy(expected))) {
      throw new DependencyUnavailableError(
        "The installed egress source policy differs from its admitted policy.",
      );
    }
    const enforcement =
      this.options.middlewareName === jointWorkspaceProfile
        ? await this.jointEnforcement(
            context,
            observed,
            prepared.configuration,
            undefined,
            prepared.jointGit,
          )
        : await observed.enforcement();
    return enforcement === undefined
      ? undefined
      : immutableCopy({
          plan: context.plan,
          sandboxId,
          sender: this.sourceControl.sender,
          installedAt: new Date().toISOString(),
          enforcement,
        });
  }

  async verifyInstallation(
    context: ProxyRevisionContext,
    installation: EgressInstallation,
  ): Promise<boolean> {
    this.assertPlan(context);
    if (
      typeof installation.sandboxId !== "string" ||
      installation.sandboxId.length === 0 ||
      !installation.enforcement ||
      !isDeepStrictEqual(installation.plan, context.plan) ||
      !isDeepStrictEqual(installation.sender, this.sourceControl.sender)
    ) {
      return false;
    }
    // Compare the same live registration, effective configuration and recipient. In the
    // observed preview this is a fresh observation, not a stock lock against operator changes.
    const reducedJoint =
      this.options.middlewareName === jointWorkspaceProfile && context.plan.generation > 1;
    const observed = await this.loadedPolicy(context, installation.sandboxId, reducedJoint);
    if (this.options.middlewareName === jointWorkspaceProfile) {
      if (!observed || !installation.enforcement.joint) {
        return false;
      }
      return isDeepStrictEqual(
        await this.jointEnforcement(context, observed, undefined, installation),
        installation.enforcement,
      );
    }
    return isDeepStrictEqual(await observed?.enforcement(), installation.enforcement);
  }

  private async detachedEpoch(
    observed: NonNullable<Awaited<ReturnType<OpenShellCredentialProxyDriver["loadedPolicy"]>>>,
    leg: { readonly provider_name: string; readonly provider_id: string },
    epoch: string,
    receiptId: string,
    signal: AbortSignal,
  ) {
    const { client, workspace, name, sandboxId } = observed;
    const { receipt } = await client.getSandboxProviderStatus(
      workspace,
      name,
      leg.provider_name,
      signal,
      receiptId,
    );
    const desired = receipt?.desired;
    const from = receipt?.detachedFrom;
    if (
      receipt?.receiptId === receiptId &&
      receipt.provider === leg.provider_name &&
      receipt.workspace === workspace &&
      receipt.kind === "PROVIDER_MUTATION_KIND_DETACH" &&
      from?.providerId === leg.provider_id &&
      from.sandboxId === sandboxId &&
      from.attachmentEpoch === epoch &&
      desired?.sandboxId === sandboxId &&
      desired.attachmentEpoch &&
      desired.attachmentEpoch !== epoch &&
      desired.attachmentEpoch === receipt.mutationId
    ) {
      return desired.attachmentEpoch;
    }
  }

  private async jointEnforcement(
    context: ProxyRevisionContext,
    observed: NonNullable<Awaited<ReturnType<OpenShellCredentialProxyDriver["loadedPolicy"]>>>,
    source?: Readonly<Record<string, unknown>>,
    installed?: EgressInstallation,
    provision?: ProxyWiring["jointGit"],
  ) {
    const reply = await observed.client.advanceJointReduction?.(
      observed.workspace,
      observed.name,
      undefined,
      context.signal,
    );
    if (installed) {
      return readJointEnforcement(
        context,
        observed.existing,
        observed.status,
        reply,
        undefined,
        installed,
      );
    }
    const effects = context.policyEffects;
    const current = asRecord(reply?.current);
    if (!effects || !provision || !source || !current || !context.jointAdmissionCurrent) {
      return;
    }
    const awaiting = reply?.joint_authority_verified !== true;
    const enforcement = readJointEnforcement(
      context,
      observed.existing,
      observed.status,
      reply,
      source,
      undefined,
      provision,
      awaiting ? "prepare-admit" : "installed",
    );
    if (!enforcement?.joint || !enforcement.peerKeyId) {
      return;
    }
    const command = {
      ...current,
      action: "admit",
      model_grant: enforcement.joint.model,
      git_grant: enforcement.joint.git,
    };
    // Persist identity before dispatch. A later cold read can consume only the original
    // authenticated receipt, even if the operator replaces a session on the same Sandbox.
    const identity = sha256Hex(JSON.stringify(wirePolicy(command)));
    const prior = await effects.read("admit");
    if (prior && prior.identity !== identity) {
      return;
    }
    if (!(await context.jointAdmissionCurrent(provision.grant))) {
      return;
    }
    if (awaiting) {
      if (
        !prior &&
        (await effects.compare("admit", undefined, {
          requestId: randomUUID(),
          expectedVersion: String(context.plan.generation),
          identity,
        }))
      ) {
        if (!(await context.jointAdmissionCurrent(provision.grant))) {
          return;
        }
        context.signal.throwIfAborted();
        await observed.client.advanceJointReduction!(
          observed.workspace,
          observed.name,
          command,
          context.signal,
        );
      }
      return;
    }
    const last = asRecord(reply?.last_result);
    if (
      !prior ||
      last?.applied !== true ||
      !isDeepStrictEqual(wirePolicy(last.command), wirePolicy(command))
    ) {
      return;
    }
    if (
      !prior.receipt &&
      !(await effects.compare("admit", prior, { ...prior, receipt: identity }))
    ) {
      return;
    }
    return enforcement;
  }

  private async loadedPolicy(
    context: ProxyRevisionContext,
    expectedSandboxId?: string,
    recovery = false,
  ) {
    if (!recovery) {
      await this.sourceControl.assertAvailable(
        context.signal,
        repositoryGitDeliveryProfile(context.plan.repositoryGit),
      );
    }
    const ref = this.sandbox.harnessResource!(context);
    const client = this.backend.client.clientForNamespace(ref.namespaceName);
    const workspace = openShellWorkspaceName(context.namespace);
    const name = ref.resourceName;
    const existing = await client.getSandbox({ workspace, name }, context.signal);
    if (
      !existing ||
      (expectedSandboxId !== undefined &&
        (existing.id !== expectedSandboxId || !client.getSandboxPolicyStatus))
    ) {
      return undefined;
    }
    this.assertOwned(existing.annotations, context);
    if (!existing.id || !client.getSandboxPolicyStatus) {
      return undefined;
    }
    const status = await client.getSandboxPolicyStatus(workspace, name, context.signal);
    const sandboxId = existing.id;
    return {
      status,
      client,
      workspace,
      name,
      existing,
      sandboxId,
      enforcement: () =>
        context.plan.repositoryGit
          ? context.plan.repositoryGitAuthorization === "request-hook-observed" &&
            context.revision.executionAdmission.version === 6 &&
            workspace === this.options.observedHookPreviewWorkspace
            ? this.previewEnforcement?.(context, sandboxId)
            : this.repositoryGitEnforcement(context, status, sandboxId)
          : enforcementEvidence(
              status,
              sandboxId,
              context.plan.generation,
              context.revision.id,
              this.options,
            ),
    };
  }

  /**
   * Release gate for the public online profile. Registration, a loaded policy and provider
   * readiness do not prove that this sender cannot skip the request hook or reuse an execution
   * identity. Stock v0.1.5 can omit the request phase; no published release is qualified here,
   * so `assertRepositoryGitProfileAvailable` refuses the profile at admission.
   * Require verified TLS, credential placement and no bypass on a supported release. Never use
   * the private installation-exchange capability or the reported URL scheme as that proof.
   */
  protected repositoryGitEnforcement(
    _context: ProxyRevisionContext,
    _status: Readonly<Record<string, unknown>>,
    _sandboxId: string,
  ): EgressInstallation["enforcement"] | undefined {
    return undefined;
  }

  async removeRevision(context: ProxyRevisionContext): Promise<boolean> {
    this.assertPlan(context);
    const ref = this.sandbox.harnessResource!(context);
    const client = this.backend.client.clientForNamespace(ref.namespaceName);
    const workspace = openShellWorkspaceName(context.namespace);
    const selector = { workspace, name: ref.resourceName };
    const unconfirmed = `the protected Sandbox ${ref.resourceName} cannot be confirmed removed`;
    const refused = gatewayIdentityRefusal(workspace, unconfirmed);
    const read = () => client.getSandbox(selector, context.signal);
    // OpenShell answers NOT_FOUND alike for a removed Sandbox and for one this identity may
    // not see, so a missing Sandbox is removed only once GetWorkspace proves the identity
    // still sees the Workspace and a second read still finds none (findings 1670, 1692,
    // 2055). A credential-less Sandbox is otherwise recorded withdrawn while it runs.
    const absent = () =>
      confirmSandboxAbsent(
        client,
        workspace,
        context.signal,
        refused,
        () => new Error(`OpenShell reports no Workspace ${workspace}, so ${unconfirmed}.`),
        read,
      );
    const existing = (await refused(read)) ?? (await absent());
    if (!existing) {
      return true;
    }
    this.assertOwned(existing.annotations, context);
    await refused(() => client.deleteSandbox(selector, context.signal));
    return ((await refused(read)) ?? (await absent())) === undefined;
  }

  private assertPlan(context: ProxyRevisionContext): void {
    if (
      (!isDeepStrictEqual(context.plan, context.revision.egressPlan) &&
        !(
          this.options.middlewareName === jointWorkspaceProfile &&
          isReducedCredentialPlan(context.revision.egressPlan, context.plan)
        )) ||
      context.plan.egressDriverId !== this.id ||
      context.plan.sandboxDriverId !== this.sandbox.id ||
      context.plan.execution.namespaceId !== context.namespace.id ||
      context.plan.execution.revisionId !== context.revision.id
    ) {
      throw new Error("Protected egress plan does not match its admitted owner.");
    }
  }

  private assertOwned(
    annotations: Readonly<Record<string, string>>,
    context: ProxyRevisionContext,
  ): void {
    if (
      annotations["openclaw.dev/namespace-id"] !== context.namespace.id ||
      annotations["openclaw.dev/agent-id"] !== context.revision.agentId ||
      annotations["openclaw.dev/revision-id"] !== context.revision.id
    ) {
      throw new Error("Protected Sandbox ownership differs from admission.");
    }
  }
}
