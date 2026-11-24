import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { asRecord, immutableCopy } from "../../packages/utils/src/index.ts";
import type { OpenShellPreparedGitBinding } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import {
  openShellEffectiveBoundGitRule,
  type OpenShellGitSandboxVerifier,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-repository-policy-readback.ts";
import { verifyExistingSandbox } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { wirePolicy } from "../../apps/controller/src/drivers/egress-proxy/openshell-wire-policy.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxProviderStatus,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { compileOpenShellBoundGitRule } from "../../apps/controller/src/drivers/sandbox/openshell-git-network-policy.ts";

// Stock OpenShell 0.1.8 adds these read-only paths, in order, if they
// exist and are missing, then syncs the enriched source policy to the Gateway.
// Its read-write baseline (/tmp and /dev/null) is explicit in this launch.
const stockProxyReadOnly = ["/usr", "/lib", "/etc", "/app", "/var/log", "/proc", "/dev/urandom"];

export function directGitLaunchVerifier(
  request: OpenShellSandboxCreateRequest,
): OpenShellGitSandboxVerifier {
  const expected = immutableCopy(request);
  const policy = asRecord(expected.spec.policy);
  const filesystem = asRecord(policy?.filesystem);
  const readOnly = filesystem?.read_only;
  const readWrite = filesystem?.read_write;
  assert.ok(policy && filesystem && Array.isArray(readOnly) && Array.isArray(readWrite));
  assert.ok(readWrite.includes("/tmp") && readWrite.includes("/dev/null"));

  return (observed, signal, source) => {
    signal.throwIfAborted();
    const loadedReadOnly = asRecord(source?.filesystem)?.read_only;
    assert.ok(Array.isArray(loadedReadOnly), "ACL_LAUNCH_FILESYSTEM");
    const additions = stockProxyReadOnly.filter(
      (path) =>
        !readOnly.includes(path) && !readWrite.includes(path) && loadedReadOnly.includes(path),
    );
    // Compare the entire admitted source, including every nondefault field.
    // Never infer the intended filesystem, policy or owner from GetSandbox.
    const expectedPolicy = {
      ...policy,
      filesystem: { ...filesystem, read_only: [...readOnly, ...additions] },
    };
    assert.ok(
      isDeepStrictEqual(wirePolicy(source), wirePolicy(expectedPolicy)),
      "ACL_LAUNCH_POLICY",
    );
    verifyExistingSandbox({ ...observed, spec: { ...observed.spec, policy } }, expected);
  };
}

const gitBootstrapReads = [
  "getWorkspace",
  "getProviderProfile",
  "getProvider",
  "getSandboxProviderStatus",
  "getSandboxPolicyStatus",
  "getSandboxConfig",
  "getSandbox",
] as const;
type GitBootstrapRead = (typeof gitBootstrapReads)[number];

const readinessReasons = [
  "PROVIDER_READINESS_REASON_UNSPECIFIED",
  "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR",
  "PROVIDER_READINESS_REASON_WAITING_FOR_CREDENTIALS",
  "PROVIDER_READINESS_REASON_WAITING_FOR_POLICY",
  "PROVIDER_READINESS_REASON_WAITING_FOR_PROCESS",
  "PROVIDER_READINESS_REASON_SUPERVISOR_DISCONNECTED",
  "PROVIDER_READINESS_REASON_SUPERVISOR_LEASE_EXPIRED",
  "PROVIDER_READINESS_REASON_CREDENTIALS_WITHHELD",
  "PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH",
  "PROVIDER_READINESS_REASON_DESIRED_STATE_CHANGED",
];

// These booleans locate refusals. The Provider verifier remains the sole decision-maker.
export function traceDirectGitBootstrap(client: OpenShellGatewayClient) {
  type Outcome = "unread" | "missing" | "returned" | "rpc-error";
  const outcomes = new Map<GitBootstrapRead, Outcome>();
  const observations = new Map<GitBootstrapRead, unknown>();
  return {
    client: new Proxy(client, {
      get(target, name: string | symbol) {
        const method = Reflect.get(target, name);
        if (typeof method !== "function") {
          return method;
        }
        const read = gitBootstrapReads.find((candidate) => candidate === name);
        if (!read) {
          return method.bind(target);
        }
        return async (...args: unknown[]) => {
          try {
            const result: unknown = await Reflect.apply(method, target, args);
            outcomes.set(read, result == null ? "missing" : "returned");
            // Never retain workspace, profile or Provider bodies for diagnostics.
            if (gitBootstrapReads.indexOf(read) >= 3) {
              observations.set(read, result);
            }
            return result;
          } catch (error) {
            outcomes.set(read, "rpc-error");
            throw error;
          }
        };
      },
    }),
    reset() {
      outcomes.clear();
      observations.clear();
    },
    summary(
      binding: OpenShellPreparedGitBinding,
      sandboxId: string,
      rule: ReturnType<typeof compileOpenShellBoundGitRule>,
    ) {
      const status = observations.get("getSandboxProviderStatus") as
        OpenShellSandboxProviderStatus | undefined;
      const desired = status?.receipt?.desired;
      const observed = status?.observed;
      const age = Date.parse(status?.evaluatedTime ?? "") - Date.parse(status?.observedTime ?? "");
      const policyStatus = asRecord(observations.get("getSandboxPolicyStatus"));
      const revision = asRecord(policyStatus?.revision);
      const config = asRecord(observations.get("getSandboxConfig"));
      const sourceRule = asRecord(asRecord(revision?.policy)?.network_policies)?.[rule.name];
      const effectiveRule = asRecord(asRecord(config?.policy)?.network_policies)?.[rule.name];
      const expectedRule = openShellEffectiveBoundGitRule(rule, sourceRule, binding.provider);
      const sandbox = observations.get("getSandbox") as OpenShellSandboxResponse | undefined;
      const admission = sandbox?.configurationAdmission;
      return {
        reads: Object.fromEntries(
          gitBootstrapReads.map((read) => [read, outcomes.get(read) ?? "unread"]),
        ),
        ...(status && {
          provider: {
            ready: status.state === "PROVIDER_READINESS_STATE_READY",
            reason:
              readinessReasons.find((reason) => reason === status.reason) ?? "unreported-or-other",
            targetMatches:
              desired?.sandboxId === sandboxId &&
              desired.sandbox === binding.sandbox &&
              desired.providerId === binding.providerId &&
              desired.providerResourceVersion === binding.resourceVersion &&
              status.receipt?.workspace === binding.workspace &&
              status.receipt.provider === binding.provider,
            hasGeneration:
              !!desired?.attachmentEpoch &&
              !!desired.providerEnvRevision &&
              !!desired.configRevision &&
              !!desired.policyHash,
            supervisorGenerationMatches:
              !!observed &&
              !!desired &&
              observed.attachmentEpoch === desired.attachmentEpoch &&
              observed.providerEnvRevision === desired.providerEnvRevision &&
              observed.configRevision === desired.configRevision &&
              observed.policyHash === desired.policyHash,
            hasSupervisor:
              !!observed?.sessionId &&
              !!observed.sequence &&
              !!observed.processInstanceId &&
              !!status.networkInstanceId,
            credentialsInstalled: observed?.credentialsInstalled === true,
            policyActive: observed?.policyActive === true,
            launchEnvironmentInstalled: observed?.launchEnvironmentInstalled === true,
            fresh: age >= 0 && age < 15_000,
          },
        }),
        ...((policyStatus || config) && {
          policy: {
            sourceLoaded: revision?.status === "POLICY_STATUS_LOADED" && !revision.load_error,
            configAdmitted:
              config?.configuration_admitted === true &&
              config.policy_validation_failure_mode === "fail_closed" &&
              !config.configuration_error,
            versionsMatch:
              typeof revision?.version === "number" &&
              revision.version > 0 &&
              policyStatus?.active_version === revision.version &&
              config?.version === revision.version,
            localPolicy:
              config?.policy_source === 1 &&
              config.workspace === binding.workspace &&
              (config.global_policy_version === undefined || config.global_policy_version === 0),
            sourceRuleMatches: expectedRule !== undefined,
            effectiveRuleMatches:
              expectedRule !== undefined &&
              isDeepStrictEqual(wirePolicy(effectiveRule), wirePolicy(expectedRule)),
            configGenerationMatches:
              !!desired &&
              !!config &&
              config.provider_attachment_epoch === desired.attachmentEpoch &&
              config.provider_env_revision === desired.providerEnvRevision &&
              config.config_revision === desired.configRevision &&
              config.policy_hash === desired.policyHash,
          },
        }),
        ...(sandbox && {
          sandbox: {
            hasActivatedConfiguration: admission !== undefined,
            identityMatches:
              sandbox.id === sandboxId &&
              sandbox.workspace === binding.workspace &&
              sandbox.name === binding.sandbox &&
              sandbox.mainProcessInstanceId === status?.networkInstanceId,
            launchPolicyMatches:
              !!revision &&
              isDeepStrictEqual(wirePolicy(revision.policy), wirePolicy(sandbox.spec?.policy)),
            attachmentMatches:
              !!desired?.attachmentEpoch &&
              sandbox.spec?.provider_attachment_epoch === desired.attachmentEpoch &&
              isDeepStrictEqual(sandbox.spec?.providers, [binding.provider]),
            configurationMatches:
              admission?.state === 2 &&
              !!desired &&
              !!revision &&
              !!config &&
              !!admission.instance_id &&
              admission.instance_id === config.configuration_instance_id &&
              admission.policy_version === revision.version &&
              admission.policy_hash === desired.policyHash &&
              admission.config_revision === desired.configRevision &&
              admission.provider_env_revision === desired.providerEnvRevision &&
              !admission.error,
          },
        }),
      };
    },
  };
}
