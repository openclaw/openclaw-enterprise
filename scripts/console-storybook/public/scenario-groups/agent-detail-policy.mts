import type {
  SandboxNetworkGrant,
  SandboxPolicyApplication,
  SandboxPolicyRecommendation,
} from "@openclaw-enterprise/contracts";
import type { createFixtureFetch } from "../preview-rules.mts";

type PolicyState =
  | "ready"
  | "unicode"
  | "many"
  | "populated"
  | "alternate"
  | "discoveryLoading"
  | "discoveryDenied"
  | "stalePreview"
  | "refreshRace"
  | "json"
  | "ownerDenied"
  | "invalid"
  | "conflict"
  | "empty"
  | "disabled"
  | "unsupported"
  | "gap"
  | "missingMetadata"
  | "failed"
  | "failedCeiling"
  | "applyRejected"
  | "applyDenied"
  | "incompletePreview"
  | "unconfirmedSave"
  | "editDenied"
  | "ceilingDenied"
  | "suggestionsUnavailable"
  | "readDenied"
  | "loading"
  | "noCredential"
  | "protected"
  | "protectedDownloadCoverage"
  | "protectedDownloadViewer"
  | "protectedDownloadEmpty"
  | "protectedDownloadPreviousRevision"
  | "protectedDownloadDeniedBeforeDispatch"
  | "protectedDownloadDeniedAfterDispatch"
  | "withheldOne"
  | "withheldMany";

type PolicyOutcome = "saved" | SandboxPolicyApplication["state"];

type AgentDetailPolicyScenario = {
  group: "Pages/Agent detail";
  name: string;
  path: string;
  deployed: true;
  candidateDeploymentStatus: "succeeded";
  policyState: PolicyState;
  description: string;
  steps: string[];
  gap: string;
  rules?: Parameters<typeof createFixtureFetch>[0];
  policyDenialCount?: number;
  policyRuleCount?: number;
  policyNewDenials?: number;
  policyWithheld?: number;
  policyNoSandboxDriver?: true;
  policySuggestions?: SandboxPolicyRecommendation[];
  // The expanded-suggestions story owns this key with an explicit undefined value.
  policyInitialOutcome?: PolicyOutcome | undefined;
  policyKeepPending?: boolean;
  policyAdminDenied?: true;
  policyCeiling?: SandboxNetworkGrant[];
  readOnlyPermissionSummary?: true;
  agentPermissionSummary?: Record<string, boolean | readonly string[]>;
  sessionUser?: { id: string; name: string; email: string };
};

type PolicyEntry = [id: string, scenario: AgentDetailPolicyScenario];

export function createAgentDetailPolicyScenarios({
  candidateVersion,
}: {
  candidateVersion: string;
}) {
  const variants = [
    ["policyDenials", "ready", "Policy denials and reviewed network additions"],
    ["policyUnicodeExecutable", "unicode", "Unicode executable path remains complete"],
    ["policyDenialsMany", "many", "Two hundred denials with batch approval"],
    ["policyRulesPopulated", "populated", "Manage ten applied network rules"],
    [
      "policyConfigurationAlternate",
      "alternate",
      "Another Driver renders enum fields from its schema",
    ],
    ["policyConfigurationLoading", "discoveryLoading", "Configuration discovery loading"],
    ["policyConfigurationDenied", "discoveryDenied", "Configuration discovery denied"],
    ["policyConfigurationStale", "stalePreview", "A superseded preview preserves the newer draft"],
    [
      "policyConfigurationRefresh",
      "refreshRace",
      "Overlapping policy refreshes retain the newest read",
    ],
    ["policyConfigurationJson", "json", "Complex fields retain invalid JSON for correction"],
    [
      "policyConfigurationHidden",
      "ownerDenied",
      "Policy hidden while independent logs remain visible",
    ],
    ["policyConfigurationInvalid", "invalid", "Configuration preview field errors"],
    ["policyConfigurationConflict", "conflict", "Configuration version conflict retains draft"],
    ["policyDenialsEmpty", "empty", "No denials in the loaded window"],
    ["policyDenialsDisabled", "disabled", "Policy editing disabled"],
    ["policyDenialsUnsupported", "unsupported", "Sandbox policy capability unavailable"],
    ["policyDenialsGap", "gap", "Policy denial window has a buffer gap"],
    ["policyDenialsMissingMetadata", "missingMetadata", "Policy denial with unknown metadata"],
    ["policyDenialsFailed", "failed", "Policy application unconfirmed"],
    [
      "policyApplicationCeilingChanged",
      "failedCeiling",
      "Policy application refused by a changed ceiling",
    ],
    ["policyDenialsApplyRejected", "applyRejected", "Combined policy change rejected"],
    ["policyDenialsApplyDenied", "applyDenied", "Combined policy change refused access"],
    ["policyIncompletePreview", "incompletePreview", "Policy preview omits the validated rules"],
    [
      "policyUnconfirmedSave",
      "unconfirmedSave",
      "Policy save returns different rules than reviewed",
    ],
    ["policyDenialsEditDenied", "editDenied", "Independent policy permission denied"],
    [
      "policyDenialsCeilingDenied",
      "ceilingDenied",
      "Policy addition exceeds the delegation ceiling",
    ],
    [
      "policyDenialsSuggestionsUnavailable",
      "suggestionsUnavailable",
      "Manual policy editing without suggestions",
    ],
    ["policyDenialsReadDenied", "readDenied", "Policy logs denied but policy remains editable"],
    ["policyDenialsLoading", "loading", "Policy decisions loading"],
    [
      "policyDenialsNoCredential",
      "noCredential",
      "Policy logs unavailable without runtime credentials",
    ],
    ["policyDenialsProtected", "protected", "Protected execution refuses network policy additions"],
    [
      "protectedDownloadCoverage",
      "protectedDownloadCoverage",
      "Protected Downloads stay covered by a host rule",
    ],
    [
      "protectedDownloadViewer",
      "protectedDownloadViewer",
      "Protected Downloads are read-only for a viewer",
    ],
    [
      "protectedDownloadEmpty",
      "protectedDownloadEmpty",
      "Protected Downloads with no live destinations",
    ],
    [
      "protectedDownloadPreviousRevision",
      "protectedDownloadPreviousRevision",
      "Protected Downloads after revision replacement",
    ],
    [
      "protectedDownloadDeniedBeforeDispatch",
      "protectedDownloadDeniedBeforeDispatch",
      "Protected Downloads authorization fails before dispatch",
    ],
    [
      "protectedDownloadDeniedAfterDispatch",
      "protectedDownloadDeniedAfterDispatch",
      "Protected Downloads authorization fails after dispatch",
    ],
    [
      "policyDenialsWithheldOne",
      "withheldOne",
      "One policy record withheld since the last refresh",
    ],
    [
      "policyDenialsWithheldMany",
      "withheldMany",
      "Multiple policy records withheld since the last refresh",
    ],
  ] satisfies [id: string, state: PolicyState, name: string][];
  return variants.map(
    ([id, state, name]) =>
      [
        id,
        {
          group: "Pages/Agent detail",
          name,
          path: `${candidateVersion}&tab=policy`,
          deployed: true,
          candidateDeploymentStatus: "succeeded",
          policyState: state,
          ...(["many", "populated"].includes(state)
            ? { policyDenialCount: 200, policyRuleCount: 10, policyNewDenials: 12 }
            : {}),
          ...(state === "withheldOne" ? { policyWithheld: 1 } : {}),
          ...(state === "withheldMany" ? { policyWithheld: 2 } : {}),
          ...(state === "discoveryLoading"
            ? { rules: [{ suffix: "/driver-configurations", hold: true }] }
            : {}),
          ...(state === "discoveryDenied"
            ? { rules: [{ suffix: "/driver-configurations", status: 403 }] }
            : {}),
          ...(state === "editDenied"
            ? {
                rules: [
                  { method: "PATCH", suffix: "/sandbox-policy/networking/editing", status: 403 },
                ],
              }
            : {}),
          ...(state === "stalePreview" ? { rules: [{ suffix: "/validate", delayMs: 3000 }] } : {}),
          description:
            "Observed denial records, aggregated provider suggestions, and governed policy additions remain distinct.",
          steps: [
            ...(state === "populated"
              ? [
                  "At 1440px and 390px, open Manage rules and Tab to Add rule. Press Enter: Executable path receives focus. Tab to Add Port ranges and press Enter: the new Start port receives focus. Type 443; focus stays there and Tab reaches End port.",
                  "Tab to Add Port ranges and press Space: focus moves to the second Start port. Tab to Remove Port ranges 1 and press Enter: focus moves to the surviving Start port. Add another range, then remove the last range with Space: focus returns to the previous Start port. With one range left, Remove is disabled and Tab from End port reaches Add Port ranges. Do not review, save, or apply during this check. Reset the story before other checks.",
                ]
              : []),
            ...(state === "many"
              ? [
                  "Scroll to Denials. The pager is the last control below the five rows. Go to page 2 and turn on Follow. The page stays in place when 12 new denials arrive. Choose Show newest to see page 1 of 43 with 212 loaded denials.",
                ]
              : []),
            "Expand a denial to inspect the sanitized log. Review its exact executable and endpoint before saving an addition.",
            "Select denial rows across pages, then Allow selected. Confirm the validated proposal retains existing rules and combines repeated executable/host/port requests. Back to editing preserves the draft.",
            "Open Manage rules. Search the five-row pages, use a row menu to edit or remove a rule, or Add rule. Compare Save for later with Save and apply to current revision. Apply saved rules is unavailable while a proposal has unsaved edits.",
            "Use the Policy editing switch in the Network policy card on the page. Open Manage rules and confirm the editing toggle is absent, saved rules remain, and Add rule follows the editing setting. Close the dialog to re-enable editing. Check the empty, denied, unsupported, missing metadata, and unconfirmed stories.",
          ],
          gap: "Simulated UI proof only. These fixtures do not prove authorization, persistence, enforcement, or provider policy activation.",
          ...(state === "unicode"
            ? {
                description:
                  "A normalized executable path has 281 Unicode code points and 551 UTF-16 code units, within the API schema's 512-code-point limit.",
                steps: [
                  "Expand Policy details, then Read-only Installation defaults. The JSON is indented and the executable path wraps inside the block, even on a phone.",
                  "Open View network limits and copy the full executable path from the Installation ceiling. Close the dialog, choose Review suggestion, then paste the copied path into Executable path. Confirm the value still ends with /tool.",
                  "Choose Review changes. Confirm the complete executable path, including /tool, appears in Proposed rules. Choose Save for later and confirm policy v2 keeps that same path while the current revision stays unchanged.",
                  "Reset the story to repeat. The six directory components each contain 45 Deseret letters (U+10400); the path is 1091 UTF-8 bytes.",
                ],
                gap: "Simulated UI proof only. This story does not validate a real executable, save to OCC, apply OpenShell policy or start a workload.",
              }
            : {}),
          ...(state === "refreshRace"
            ? {
                description:
                  "Another operator's simulated saves advance the policy between two overlapping reads.",
                steps: [
                  "Double-click Refresh policy. The older read returns first; wait for saved policy v3.",
                  "Apply the saved policy to the current revision. Observe pending status, then simulated provider confirmation from continued polling.",
                ],
              }
            : {}),
          ...(state === "ownerDenied"
            ? {
                steps: [
                  "Refresh denials and confirm the independent log window loads even though discovery has no policy descriptor.",
                  "Scroll to the policy and suggestion permission refusals. Confirm neither offers a retry or editing control.",
                ],
              }
            : {}),
          ...(state === "unsupported"
            ? {
                steps: [
                  "The tab says once that the Sandbox Driver does not support per-Agent network policy. It reads no Sandbox logs or suggestions and offers no editor.",
                ],
              }
            : {}),
          ...(state === "protected"
            ? {
                steps: [
                  "Open Manage rules. The protected execution notice is visible, adding and editing are disabled, and live application is unavailable.",
                  "A rule saved before protected execution applied blocks every protected deploy. Choose Remove saved network rules, review the removal, then Save for later and confirm the saved policy is empty.",
                ],
              }
            : {}),
          ...(state === "protectedDownloadCoverage"
            ? {
                description:
                  "An Installation administrator can manage downloads. A confirmed host rule still covers an archive after the administrator disables its exact rule.",
                steps: [
                  "In Protected downloads, search for no-match and check that No listed destinations match your search appears. Clear the search. The host and /releases/tool.tar.gz both show Enabled under Live rule status.",
                  "Under Filter destinations, choose No confirmed live rule. The approved mirror appears with Enable. Choose All live rule states to return to the full list.",
                  "Choose Enabled or covered under Filter destinations, then paste https://downloads.example.org/releases/unlisted-tool.tar.gz into Search destinations. Choose Show host rules. The search changes to https://downloads.example.org:443 and the All paths row shows Enabled. Clear the search and choose All live rule states.",
                  "Choose Disable on the archive row. Wait for Live rules confirmed. The archive still has Agent approval and shows Covered by host with https://downloads.example.org:443. The host stays Enabled.",
                  "Choose Add destination. Enter artifacts.example.net, keep HTTPS, leave Exact archive path empty, and choose Allow download. Wait for Live rules confirmed and open Receipt details to see the change.",
                  "For artifacts.example.net, open the More actions menu (⋯) and choose Withdraw approval. Wait for Live rules confirmed. Check that the added destination disappears and downloads.example.org stays Enabled. Reset story to repeat.",
                ],
                gap: "Simulated Console and policy responses. Use the live workflow to verify download enforcement.",
              }
            : {}),
          ...(state === "protectedDownloadViewer"
            ? {
                readOnlyPermissionSummary: true,
                sessionUser: {
                  id: "storybook-viewer",
                  name: "Demo Viewer",
                  email: "viewer@example.com",
                },
                agentPermissionSummary: {
                  update: false,
                  deploy: false,
                  operate: false,
                  delete: false,
                  administer: false,
                  configurationUpdate: false,
                  configurationRead: true,
                  configurationSecretsOperate: false,
                  configurationSecretsOperateDeniedBindings: [],
                  agentSourcesOperate: false,
                  sandboxPolicyRead: true,
                  readLogs: false,
                },
                description:
                  "A viewer can read the Agent's download policy and receipts. The viewer has no policy edit or Installation administration grant.",
                steps: [
                  "In Protected downloads, inspect both destinations and open Receipt details. Search for tool.tar.gz to isolate the archive.",
                  "Choose Refresh in Protected downloads. Confirm that the archive stays visible and that Protected downloads offers no Add destination, Enable, Disable, or Withdraw approval actions.",
                ],
                gap: "Simulated Console permission responses. The API authorizes changes in a live Installation.",
              }
            : {}),
          ...(state === "protectedDownloadEmpty"
            ? {
                description: "This revision is verified and the Agent has no saved destinations.",
                steps: [
                  "In Protected downloads, check No live edit confirmed and No destinations listed for live editing. Read the guidance for checking the running Sandbox’s create-time policy.",
                ],
                gap: "Simulated Console and policy responses.",
              }
            : {}),
          ...(state === "protectedDownloadPreviousRevision"
            ? {
                description:
                  "Revision 7 passed its readiness checks after replacing revision 6. The Agent retains its approved and desired destinations, with a receipt for revision 6.",
                steps: [
                  "In Protected downloads, check No live edit confirmed and No live rule confirmed on both rows. Read the guidance for checking the running Sandbox’s create-time policy. Open Receipt details. Check the revision 6 operation IDs, versions, request state, and timestamps. Change and Reason are absent.",
                  "Choose Enable on the host row and wait for Live rules confirmed. Check that the host shows Enabled and the archive shows Covered by host. Receipt details names revision 7 and shows the enable action and host destination under Change.",
                ],
                gap: "Simulated revision replacement and policy responses. Use the live workflow to verify download enforcement.",
              }
            : {}),
          ...(state === "protectedDownloadDeniedBeforeDispatch" ||
          state === "protectedDownloadDeniedAfterDispatch"
            ? {
                description:
                  state === "protectedDownloadDeniedBeforeDispatch"
                    ? "The requester loses permission before the controller sends a download change to the provider."
                    : "The requester loses permission after the controller records dispatch. The outcome remains uncertain.",
                steps: [
                  "Choose Add destination. Enter artifacts.example.net, keep HTTPS, and choose Allow download.",
                  state === "protectedDownloadDeniedBeforeDispatch"
                    ? "When Change not applied appears, read which grants an administrator must check before the requester submits again."
                    : "When Change unconfirmed appears, check that the guidance directs the operator to the original operation before another change.",
                  "Open Receipt details to find the request ID and AUTHORIZATION_DENIED reason. Choose Reset story to repeat.",
                ],
                gap: "Simulated policy responses for both stages of an authorization failure.",
              }
            : {}),
          ...(state === "ceilingDenied"
            ? {
                steps: [
                  "Review the suggested outside.example.org addition and compare it with the Installation delegation ceiling.",
                  "Choose Review changes. The preview ceiling rejection must be announced and brought into view, with the attempted addition preserved for correction.",
                  "Confirm the saved policy version and additions are unchanged. This preview simulates the API rejection; the browser integration exercises actual OCC admission.",
                ],
              }
            : {}),
          ...(state === "applyRejected"
            ? {
                steps: [
                  "Review a suggestion, then choose Review changes and Save and apply to current revision.",
                  "Refresh the policy. The rejected change leaves the saved rules and version unchanged.",
                ],
              }
            : {}),
          ...(state === "applyDenied"
            ? {
                rules: [
                  {
                    method: "POST",
                    suffix: "/sandbox-policy/networking/apply",
                    status: 403,
                    code: "FORBIDDEN",
                  },
                ],
                steps: [
                  "Review a suggestion, then choose Review changes and Save and apply to current revision.",
                  "The simulated apply answers 403, as when SandboxPolicy read is revoked while the page is open. Confirm the refusal names Agent manage_policy and SandboxPolicy update and read. Refresh and verify the saved version did not change.",
                ],
              }
            : {}),
          ...(state === "incompletePreview"
            ? {
                steps: [
                  "Choose Review suggestion, then Review changes. The preview omits the rules; your proposal stays editable and Save is unavailable.",
                ],
              }
            : {}),
          ...(state === "unconfirmedSave"
            ? {
                steps: [
                  "Review a suggestion, then choose Review changes and Save and apply to current revision.",
                  "The response omits the reviewed rule. Confirm the Console reads the policy again and shows the recorded outcome without sending another apply.",
                ],
              }
            : {}),
          ...(state === "readDenied"
            ? { rules: [{ suffix: "/runtime/logs", status: 403, code: "AUTHORIZATION_DENIED" }] }
            : {}),
          ...(state === "loading" ? { rules: [{ suffix: "/runtime/logs", hold: true }] } : {}),
          ...(state === "noCredential"
            ? { rules: [{ suffix: "/runtime/logs", status: 503, code: "DEPENDENCY_UNAVAILABLE" }] }
            : {}),
          ...(state === "withheldOne"
            ? {
                description:
                  'The Denials tab shows a warning banner when sandbox records are withheld. One withheld record uses the singular "record".',
                steps: [
                  'Check the warning banner above the denial list. It reads "1 record withheld since the last refresh." Confirm the singular form.',
                ],
              }
            : {}),
          ...(state === "withheldMany"
            ? {
                description: 'Two withheld records: the warning banner uses the plural "records".',
                steps: [
                  'Check the warning banner above the denial list. It reads "2 records withheld since the last refresh." Confirm the plural form.',
                ],
              }
            : {}),
        } satisfies AgentDetailPolicyScenario,
      ] satisfies PolicyEntry,
  );
}

// An Installation that selects no Sandbox Driver: the API names that cause instead of the
// Driver's missing capability (D774).
export function createAgentDetailPolicyWithoutSandboxDriver(
  unsupported: AgentDetailPolicyScenario,
) {
  return {
    ...unsupported,
    name: "Installation selects no Sandbox Driver",
    policyNoSandboxDriver: true,
    description:
      "The Policy denials tab says once that Agents run without a Sandbox, and offers no policy editor.",
    steps: [
      "Confirm the single status sentence names the missing Sandbox Driver, and that the Policy editing switch and Manage rules are absent.",
    ],
  } satisfies AgentDetailPolicyScenario;
}

export function createAgentDetailPolicyOutcomes({
  populated,
  disabled,
}: {
  populated: AgentDetailPolicyScenario;
  disabled: AgentDetailPolicyScenario;
}) {
  const policySuggestions = Array.from(
    { length: 12 },
    (_, index) =>
      ({
        id: `suggested-${index}`,
        status: "pending",
        observations: 12 - index,
        grant: {
          id: `suggested-rule-${index}`,
          binary: "/usr/bin/python3.11",
          host: `service-${index + 1}.example.org`,
          ports: [{ from: 443, to: 443 }],
        },
      }) satisfies SandboxPolicyRecommendation,
  );
  const variants = [
    ["policySuggestionsExpanded", undefined, "Twelve suggestions with compact review"],
    ["policySavedForLater", "saved", "Saved rules awaiting application"],
    ["policyApplying", "pending", "Waiting for Sandbox confirmation"],
    ["policyApplied", "applied", "Confirmed running policy"],
    ["policyRetryApplication", "failed", "Inspect then retry unconfirmed application"],
  ] satisfies [id: string, outcome: PolicyOutcome | undefined, name: string][];
  const outcomes = variants.map(
    ([id, outcome, name]) =>
      [
        id,
        {
          ...populated,
          name,
          policySuggestions,
          policyInitialOutcome: outcome,
          policyKeepPending: outcome === "pending",
          policyNewDenials: 0,
          steps: [
            "Inspect three suggestions, show all twelve, then show fewer. Expand a full executable path.",
            "Open View network limits directly from the page. The ceiling is read-only and grants no access.",
            "Manage rules: inspect five at a time. Remove a rule and review through the fixed footer. Done preserves the local proposal without saving.",
            "For failed application, Refresh status reads without applying. Retry application is a separate explicit action after inspection.",
          ],
        } satisfies AgentDetailPolicyScenario,
      ] satisfies PolicyEntry,
  );
  const policyDenialsDisabled = {
    ...disabled,
    policyRuleCount: 10,
    policySuggestions,
  } satisfies AgentDetailPolicyScenario;
  const policyEditingAdminDenied = {
    ...policyDenialsDisabled,
    name: "Editing administration refused",
    policyAdminDenied: true,
  } satisfies AgentDetailPolicyScenario;
  const policyNoNetworkLimits = {
    ...policyDenialsDisabled,
    name: "No additional network access delegated",
    policyRuleCount: 0,
    policyCeiling: [],
  } satisfies AgentDetailPolicyScenario;
  return { outcomes, policyDenialsDisabled, policyEditingAdminDenied, policyNoNetworkLimits };
}
