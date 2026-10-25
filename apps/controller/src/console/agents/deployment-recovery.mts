import type {
  AgentCallerPermissionsResponse,
  AgentDeploymentStatusWire,
  AgentRead,
  AgentRevisionSummaryWire,
} from "@openclaw-enterprise/contracts";
import type { Static } from "typebox";
import { requestFailure } from "../api-client.mjs";
import { element, setHidden, setText } from "../dom.mjs";
import { agentSaveDenial, namespacePath } from "./list.mjs";
import { logTextDenied } from "./logs.mjs";

type RecoveryTab = "credentials" | "configuration" | "logs";
type RecoveryContext = Parameters<typeof logTextDenied>[0] & {
  agentId: string;
  isCurrent(): boolean;
  request(path: string): Promise<unknown>;
  deniedReads?: { has(path: string): boolean; remember(path: string): void };
};

interface FailureToShow {
  latest: Pick<AgentRevisionSummaryWire, "id" | "revision">;
  record: AgentDeploymentStatusWire | null;
  agent: AgentRead;
  permissions: Static<typeof AgentCallerPermissionsResponse>["data"] | null;
  currentLabel: string;
  servingImpact: "replacement-failed" | "selected-failed" | null;
  overviewUnavailable: boolean;
  activityPanel: HTMLElement;
}

// The page that holds the setting to change for failure codes whose cause the operator can
// act on directly. The API's error message already states the next step (finding 1393), so
// the console adds only the link.
const DEPLOYMENT_FAILURE_LINKS: Readonly<Record<string, Exclude<RecoveryTab, "logs">>> = {
  RUNTIME_AUTHENTICATION_FAILED: "credentials",
  RUNTIME_MODEL_PROBE_FAILED: "configuration",
  RUNTIME_MODEL_PROBE_TIMEOUT: "configuration",
  // Kubernetes Compute fails activation at once when the Gateway refuses its own in-Pod
  // CLI (#1128); the Configuration's gateway password reference is what lets it in.
  AGENT_GATEWAY_UNAUTHORIZED: "configuration",
};

// The API's message for a failure that deploying the same Agent again can clear (an outage
// that outlasted every attempt, a lost worker claim, an approval or driver that changed since
// admission) starts a sentence with "Deploy again". The recovery offers Deploy again for those
// messages only, so it never contradicts the step the message names. A message that names no
// step at all (a deadline that passed, a Driver that cannot run this Harness) mentions none of
// deploy, ask or check, and the banner adds the generic advice to it.
const DEPLOY_AGAIN_STEP = /(?:^|[.;]\s)Deploy again\b/u;
const NAMED_STEP = /\b(?:deploy|ask|check)\b/iu;

/**
 * The next step a failed deployment's API message names: "deploy-again" when it says to deploy
 * again, "named" for any other step, and null for none.
 */
export function deploymentFailureStep(message: string | null | undefined) {
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  if (DEPLOY_AGAIN_STEP.test(message)) {
    return "deploy-again";
  }
  return NAMED_STEP.test(message) ? "named" : null;
}

const DEPLOYMENT_FAILURE_LINK_LABELS = {
  credentials: "Open Credentials",
  configuration: "Open Configuration",
};

/** Recovery actions for the latest readable failed deployment. The API authorizes every destination. */
export function createDeploymentRecovery(
  context: RecoveryContext,
  {
    path,
    selected,
    isDeleting,
    refresh,
    versionLink,
  }: {
    path: string;
    selected: string;
    isDeleting(): boolean;
    refresh(): void;
    versionLink(
      label: string,
      revisionId: string,
      tab: RecoveryTab,
      options?: { deploy: boolean },
    ): HTMLAnchorElement;
  },
) {
  const { agentId, namespaceId } = context;
  const recoveryTitle = element("h2");
  // A danger status block (spec 3.4): the failed version in the label, the code at the end of
  // the message's first sentence, and one primary action. Each part is its own node, so a poll
  // that reads back the same failure writes nothing.
  const recoveryLabel = element("p", { className: "status-label" });
  const recoveryLead = document.createTextNode("");
  const recoveryCode = element("code", { hidden: true });
  const recoveryRest = document.createTextNode("");
  const recoveryMessage = element(
    "p",
    { className: "status-body" },
    recoveryLead,
    recoveryCode,
    recoveryRest,
  );
  const recoveryActions = element("div", {
    className: "status-actions deployment-recovery-actions",
  });
  const recovery = element(
    "section",
    {
      className: "status deployment-recovery",
      "data-tone": "danger",
      hidden: true,
      "aria-label": "Deployment needs attention",
    },
    recoveryLabel,
    recoveryTitle,
    recoveryMessage,
    recoveryActions,
  );
  let recoveryTarget: string | undefined;
  // The failed version whose Deployment details the card has folded. A reader who reopens the details keeps them open.
  let recoveryFolded: string | null = null;
  // The Configuration ID this page has read successfully, and the one recovery is checking. Deploy
  // again opens a draft that builds Deploy new version only from a readable Configuration, and
  // "not yet denied" is not readable (finding 1931).
  let readableConfigurationId: string | null = null;
  let configurationCheckId: string | null = null;

  function show(failure: FailureToShow | null) {
    if (!failure) {
      setHidden(recovery, true);
      return;
    }
    const {
      latest,
      record,
      agent,
      permissions,
      currentLabel,
      servingImpact,
      overviewUnavailable,
      activityPanel,
    } = failure;
    // Put the recovery action first. Fold repeated failure details once; keep cleanup, warnings
    // or an incomplete overview visible, and respect the reader opening the details again.
    if (recovery.hidden && recoveryFolded !== latest.id) {
      recoveryFolded = latest.id;
      const details = activityPanel.querySelector<HTMLDetailsElement>(":scope > details");
      if (details?.open && !record?.cleanup && !record?.warnings?.length && !overviewUnavailable) {
        details.open = false;
      }
    }
    setHidden(recovery, false);
    const version = `v${latest.revision}`;
    const { code, message: errorMessage } = record?.error ?? {};
    const modelCheck = ["RUNTIME_MODEL_PROBE_FAILED", "RUNTIME_MODEL_PROBE_TIMEOUT"].includes(
      code ?? "",
    );
    setText(recoveryLabel, `Deployment failed · ${version}`);
    // The label names the failed version above a line about serving; a title that already says
    // "vN deployment failed" stands alone (finding 2368).
    setHidden(recoveryLabel, !servingImpact);
    setText(
      recoveryTitle,
      servingImpact ? "This Agent may be offline" : `${version} deployment failed`,
    );
    const lead = modelCheck
      ? `${version} failed its startup model check`
      : `${version} did not deploy successfully`;
    // Offer only links the caller's permission answer and this tab's remembered denials
    // allow; the API still authorizes each page they open (finding 1458).
    const logsAllowed =
      !logTextDenied(context, agentId) &&
      !context.deniedReads?.has(`${path}/revisions/${encodeURIComponent(latest.id)}`);
    // Agent permissions can support opening a draft; they do not grant Configuration access.
    const configurationId = agent.configurationId;
    const configurationAvailable =
      typeof configurationId === "string" &&
      configurationId.length > 0 &&
      !("configurationReadError" in agent) &&
      !context.deniedReads?.has(
        `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(configurationId)}`,
      );
    // The API's message states this failure's own next step (finding 1393); the banner leads
    // with it, so that step is in view rather than only in Deployment details below the fold
    // (finding 1898). The generic advice stays for a record without one.
    const step = deploymentFailureStep(errorMessage);
    const generic = logsAllowed
      ? "Check the failed version’s logs before deploying a new version."
      : "Ask someone with log access to check the failed version’s logs before deploying a new version.";
    let impact = errorMessage ? (step ? errorMessage : `${errorMessage} ${generic}`) : generic;
    if (servingImpact === "replacement-failed") {
      impact = `${currentLabel} is still selected, but its runtime was probably stopped for this deployment.${errorMessage ? ` ${errorMessage}` : ""}`;
    } else if (servingImpact === "selected-failed") {
      impact = `${currentLabel} is still selected, but its runtime replaced the previous version before deployment finished.${errorMessage ? ` ${errorMessage}` : ""}`;
    }
    if ((servingImpact || step) && !logsAllowed) {
      // Without the Logs link this is the reader's only way to the logs (finding 1484).
      impact += " Ask someone with log access to check the failed version’s logs.";
    }
    // The code ends the first sentence, so the reader can match it to Logs and to occ.
    setText(recoveryLead, code ? `${lead} (` : `${lead}.`);
    setText(recoveryCode, code ?? "");
    setHidden(recoveryCode, !code);
    setText(recoveryRest, code ? `). ${impact}` : ` ${impact}`);
    // Deploying again is the whole next step only where the API's message says so. The draft
    // it opens builds Deploy new version only from a readable Configuration, so the link waits
    // for a successful read of it (finding 1931).
    const deployAgainAllowed =
      step === "deploy-again" && permissions?.deploy === true && configurationAvailable;
    const deployAgain = deployAgainAllowed && readableConfigurationId === configurationId;
    const guidance =
      code && Object.hasOwn(DEPLOYMENT_FAILURE_LINKS, code)
        ? DEPLOYMENT_FAILURE_LINKS[code]
        : undefined;
    // Agent-side saves need Agent update and the source grants each update also checks; the draft
    // page disables its editors without them (finding 2441).
    const agentEditable =
      permissions?.update === true && agentSaveDenial(permissions) === undefined;
    // Without them, the draft's only step is Deploy new version, which it builds only from a
    // readable Configuration, so "Open version draft" waits for the same read (finding 1944).
    const openDraftAllowed =
      guidance === "configuration" &&
      configurationAvailable &&
      !agentEditable &&
      permissions?.deploy === true;
    if ((deployAgainAllowed || openDraftAllowed) && readableConfigurationId !== configurationId) {
      checkConfigurationReadable(configurationId);
    }
    const canOpenConfiguration =
      guidance === "configuration" &&
      configurationAvailable &&
      (agentEditable || (openDraftAllowed && readableConfigurationId === configurationId));
    const canOpenCredentials =
      guidance === "credentials" &&
      agentEditable &&
      (!("harnessAuth" in agent) || agent.harnessAuth?.method !== "runtime");
    const tab = canOpenConfiguration || canOpenCredentials ? guidance : null;
    const nextLabel =
      tab &&
      (canOpenConfiguration && !agentEditable
        ? "Open version draft"
        : DEPLOYMENT_FAILURE_LINK_LABELS[tab]);
    const actionsFor = `${latest.id}/${tab}/${nextLabel}/${logsAllowed}/${deployAgain}`;
    if (recoveryTarget !== actionsFor) {
      recoveryTarget = actionsFor;
      const again = deployAgain
        ? versionLink("Deploy again", "draft", "configuration", { deploy: true })
        : null;
      const logs = logsAllowed ? versionLink(`Open ${version} Logs`, latest.id, "logs") : null;
      const next = tab && nextLabel ? versionLink(nextLabel, "draft", tab) : null;
      // The first action is the one primary on the page: Deploy again where the message says
      // to, else the failed version's Logs. The others are secondary buttons.
      const actions = [again, logs, next].filter((action) => action !== null);
      actions.forEach((action, index) => {
        action.className = index === 0 ? "button button--primary" : "button";
      });
      recoveryActions.replaceChildren(...actions);
      recoveryActions.hidden = actions.length === 0;
    }
  }

  // Another version's tabs have no reason to read the Configuration, so recovery reads it once
  // before offering Deploy again or Open version draft. A denial is remembered like the draft's;
  // any other failure leaves the links hidden for this page view. The draft's own read decides
  // there.
  function checkConfigurationReadable(configurationId: string) {
    if (selected === "draft" || configurationCheckId === configurationId) {
      return;
    }
    configurationCheckId = configurationId;
    const configurationPath = `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(configurationId)}`;
    void context.request(configurationPath).then(
      () => {
        // A late answer for a Configuration the Agent has since replaced decides nothing.
        if (!context.isCurrent() || isDeleting() || configurationCheckId !== configurationId) {
          return;
        }
        readableConfigurationId = configurationId;
        refresh();
      },
      (error) => {
        if (requestFailure(error).status === 403) {
          context.deniedReads?.remember(configurationPath);
          if (context.isCurrent() && !isDeleting()) {
            refresh();
          }
        } else if (!context.isCurrent() && configurationCheckId === configurationId) {
          // Cut short by leaving the page: a view Back restores asks again.
          configurationCheckId = null;
        }
      },
    );
  }

  return {
    section: recovery,
    show,
    noteDraftRead(id: string | null) {
      readableConfigurationId = id;
    },
  };
}
