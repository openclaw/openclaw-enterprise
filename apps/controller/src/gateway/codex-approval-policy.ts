import type {
  OpenClawConfigurationDocument,
  PluginDesiredState,
} from "@openclaw-enterprise/contracts";
import {
  CODEX_APPROVAL_POLICY_SETTING as SETTING,
  codexApprovalPolicy,
  ComputeGatewaySettingError,
  ConfigurationHarnessError,
} from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";

function configuredApprovalPolicy(configuration: Readonly<OpenClawConfigurationDocument>): unknown {
  const codex = asRecord(asRecord(asRecord(configuration.plugins)?.entries)?.codex);
  return asRecord(asRecord(codex?.config)?.appServer)?.approvalPolicy;
}

/**
 * The Gateway refuses an approval policy outside its enum, `untrusted` included (its
 * `openclaw doctor --fix` hint cannot edit the read-only configuration Compute renders).
 * Compute Drivers refuse it with their other gateway settings: at provisioning, deployment
 * admission, and preparation; Configuration save applies the same rule (codexApprovalPolicy).
 */
export function validateCodexApprovalPolicySetting(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: (setting: string, requirement: string) => Error = (setting, requirement) =>
    new ComputeGatewaySettingError(setting, requirement),
): void {
  codexApprovalPolicy(configuration, createError);
}

/**
 * Native startup checks an automatic app reviewer against the session approval policy in its
 * startup configuration. When the policy is omitted, the Gateway picks its own session policy
 * (`never` over its websocket transport unless guardian mode or the Gateway's environment
 * override say otherwise), which that check cannot see, so the Codex Plugin Driver requires
 * the policy the Gateway runs as `on-request`.
 */
export function validateCodexAutomaticReviewerPolicy(
  selections: PluginDesiredState,
  configuration: Readonly<OpenClawConfigurationDocument>,
): void {
  const automatic = Object.values(selections).some(
    (selection) => selection?.enabled === true && selection.toolDefaults?.reviewer === "auto",
  );
  const policy = configuredApprovalPolicy(configuration);
  if (automatic && policy !== "on-request" && policy !== "on-failure") {
    throw new ConfigurationHarnessError(
      `An automatic plugin reviewer requires Configuration setting ${SETTING} "on-request"; ${
        policy === undefined ? "set it explicitly" : "change it"
      } or choose the human reviewer.`,
    );
  }
}
