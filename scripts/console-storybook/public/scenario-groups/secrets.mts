import type {
  NamespaceStatus,
  SecretConsumers,
  SecretMetadata,
} from "@openclaw-enterprise/contracts";
import type { ErrorCode } from "../../../../packages/contracts/src/api/common.ts";
import type { SecretDetailResponse } from "../../../../packages/contracts/src/api/resources.ts";

type SecretListPath = `/namespaces/${string}/secrets`;

type SecretAction =
  { click: string } | { selector: string; click: true } | { selector: string; value: string };

type SecretRule = ({ path: SecretListPath } | { suffix: `/secrets/${string}` }) & {
  method?: "POST" | "PATCH" | "DELETE";
  skip?: number;
} & (
    | { hold: true }
    | { bodyError: true }
    | { status: number; code?: ErrorCode; message?: string }
    | { data: Pick<SecretMetadata, "id" | "name"> }
  );

type SecretScenario = {
  group: "Pages/Secrets";
  name: string;
  path: "/console/secrets" | `/console/secrets?${string}`;
  description: string;
  steps?: readonly string[];
  gap?: string;
  mobile?: true;
  emptySecrets?: true;
  emptyNamespaces?: true;
  namespaceStatus?: NamespaceStatus;
  secretCreateNotPermitted?: true;
  denySecretCreate?: true;
  secretConsumers?: SecretConsumers;
  secretCallerPermissions?: SecretDetailResponse["data"]["callerPermissions"];
  actions?: readonly SecretAction[];
  rules?: readonly SecretRule[];
};

export function secretsScenarios({
  presetSecretsPath,
  click,
}: {
  presetSecretsPath: SecretListPath;
  click(text: string): { click: string };
}) {
  return {
    secrets: {
      group: "Pages/Secrets",
      name: "Populated",
      path: "/console/secrets",
      description:
        "The library shows names and IDs. The privacy notice explains why stored values are never returned. Simulated UI proof.",
      steps: [
        "Search by name or ID. Tab to a result and press Enter; its dialog names the Namespace and lists consumers.",
        "Create a Secret with a dummy value, replace it, then delete it. Switch Namespace to inspect isolation in navigation.",
      ],
    },
    secretsMobile: {
      group: "Pages/Secrets",
      name: "Mobile",
      path: "/console/secrets",
      mobile: true,
      actions: [{ selector: "#secret-search", value: "sec_demo_model" }],
      description:
        "Compare the same 390 × 844 page with one search result, then with a list that scrolls.",
      steps: [
        "Open the one Secret, then Replace value. The top bar, dimmed page and sheet reach the right edge, with no empty strip. Press Escape without entering a value.",
        "Clear Search Secrets, scroll to the last Secret and open it. The sheet reaches the available edge: beside a classic scrollbar, or under an overlay scrollbar. Escape returns focus to that Secret.",
      ],
    },
    secretsSearch: {
      group: "Pages/Secrets",
      name: "No search matches",
      path: "/console/secrets",
      actions: [{ selector: '[aria-label="Search Secrets"]', value: "no-such-secret" }],
      description: "Clear the search to see the Secrets in this Namespace again.",
    },
    secretsEmpty: {
      group: "Pages/Secrets",
      name: "Empty",
      path: "/console/secrets",
      emptySecrets: true,
      description: "An authorized list without Secrets offers creation.",
    },
    secretsLoading: {
      group: "Pages/Secrets",
      name: "Loading",
      path: "/console/secrets",
      rules: [{ path: presetSecretsPath, hold: true }],
      description: "Namespace admission succeeds while the Secret list is still loading.",
    },
    secretsUnavailable: {
      group: "Pages/Secrets",
      name: "Read unavailable",
      path: "/console/secrets",
      rules: [{ path: presetSecretsPath, status: 503 }],
      description: "A failed Secret collection read shows recovery, with no stale rows.",
    },
    secretsNoNamespace: {
      group: "Pages/Secrets",
      name: "No readable Namespace",
      path: "/console/secrets",
      emptyNamespaces: true,
      description: "Secret requests require an admitted Namespace selection.",
    },
    secretsNamespaceNotReady: {
      group: "Pages/Secrets",
      name: "Namespace provisioning",
      path: "/console/secrets",
      namespaceStatus: "provisioning",
      description:
        "Metadata stays readable; creation and replacement wait for Namespace readiness.",
    },
    secretsCreate: {
      group: "Pages/Secrets",
      name: "Create",
      path: "/console/secrets",
      actions: [click("Create Secret")],
      description:
        "The header identifies the Namespace. The form preserves whitespace and explains that you can replace a saved value but cannot retrieve it.",
      steps: [
        "Enter a name and a dummy value. Use Show value beside the Value label, then hide it again.",
        "Press Enter from Secret name to submit. After the save, Close is the only dialog action.",
      ],
    },
    secretsMissingValue: {
      group: "Pages/Secrets",
      name: "Missing value",
      path: "/console/secrets",
      actions: [
        click("Create Secret"),
        { selector: "#secret-name", value: "Team API key" },
        { selector: 'dialog button[type="submit"]', click: true },
      ],
      description: "Required-value errors remain beside their field; no request is sent.",
    },
    secretsCreateNotPermitted: {
      group: "Pages/Secrets",
      name: "Create not permitted",
      path: "/console/secrets",
      secretCreateNotPermitted: true,
      description:
        "The caller's access does not include Secret creation. Create Secret is disabled and the note under the toolbar names the reason.",
      steps: [
        "Tab to Create Secret. It takes focus and looks unavailable, a screen reader names the note as its description, and Enter, Space or a click opens nothing.",
      ],
    },
    secretsCreateDenied: {
      group: "Pages/Secrets",
      name: "Create denied",
      path: "/console/secrets",
      denySecretCreate: true,
      actions: [
        click("Create Secret"),
        { selector: "#secret-name", value: "Team API key" },
        { selector: "#secret-value", value: "synthetic-story-value" },
        { selector: 'dialog button[type="submit"]', click: true },
      ],
      description:
        "The permission answer allowed creation, but the API refuses it (for example, a grant removed after the page loaded). The form clears the value, disables editing, and focuses Close.",
      steps: [
        "Tab to Secret name, Show value, Value and Create Secret. Each takes focus and looks unavailable, described by the refusal; typing, Enter, Space or a click sends nothing and the value stays masked (finding 2935).",
        "Close the dialog. The page's Create Secret looks unavailable, described by the note under the toolbar that asks to select Refresh after access changes.",
      ],
    },
    secretsUnknownSave: {
      group: "Pages/Secrets",
      name: "Unknown save outcome",
      path: "/console/secrets",
      rules: [{ path: presetSecretsPath, method: "POST", bodyError: true }],
      actions: [
        click("Create Secret"),
        { selector: "#secret-name", value: "Team API key" },
        { selector: "#secret-value", value: "synthetic-story-value" },
        { selector: 'dialog button[type="submit"]', click: true },
      ],
      description:
        "An unreadable reply leaves an amber warning that the outcome is unknown. The value is erased and this dialog cannot resubmit.",
    },
    secretsConsumers: {
      group: "Pages/Secrets",
      name: "Consumers and restricted references",
      path: "/console/secrets",
      secretConsumers: {
        agents: [
          "agt_00000000-0000-4000-8000-000000000001",
          "agt_00000000-0000-4000-8000-000000000099",
        ],
        configurations: ["cfg_00000000-0000-4000-8000-000000000001"],
        credentialSources: [],
        provisioningRequests: [],
        unreadable: 2,
        truncated: true,
      },
      actions: [click("Demo model API key (simulated)")],
      description:
        "The readable Agent keeps its link. A previously listed Agent shows no identity or link and asks you to reopen the Secret to check again. Hidden count, incomplete-list warning and disabled deletion remain. Simulated UI proof.",
    },
    secretsReadOnly: {
      group: "Pages/Secrets",
      name: "Read only for this caller",
      path: "/console/secrets",
      secretCallerPermissions: { update: false, delete: false },
      secretConsumers: {
        agents: ["agt_00000000-0000-4000-8000-000000000001"],
        configurations: [],
        credentialSources: [],
        provisioningRequests: [],
        unreadable: 0,
        truncated: false,
      },
      actions: [click("Demo model API key (simulated)")],
      description:
        "The Secret read says this caller may neither replace nor delete the Secret. Both buttons are disabled before any typing, and each names its reason. Consumers name the Agent, with its ID beside it. Simulated UI proof.",
      steps: [
        "Tab to Replace value and Delete Secret. Each takes focus and looks unavailable. Replace value is described by its note; Delete Secret by the blocked-deletion sentence and its note. Enter, Space or a click opens nothing.",
      ],
      gap: "The answer is advisory. The controller still authorizes each write.",
    },
    secretsLinkUnlisted: {
      group: "Pages/Secrets",
      name: "Link to an unlisted Secret",
      path: "/console/secrets?secret=sec_not_listed",
      description:
        "A link to a Secret the readable list leaves out opens no dialog. For a member, a note says it may not exist or the caller may not read it, and who grants read. This simulated caller administers the Installation, so the note says only that no such Secret is in the readable list. Nothing reads the Secret.",
    },
    secretsReplace: {
      group: "Pages/Secrets",
      name: "Replace value",
      path: "/console/secrets",
      actions: [click("Demo model API key (simulated)"), click("Replace value")],
      description:
        "Replacement preserves the reference and explains deployment and CredentialSource handoff. Existing values are never loaded.",
    },
    secretsReplaceDenied: {
      group: "Pages/Secrets",
      name: "Replace denied",
      path: "/console/secrets",
      rules: [
        { suffix: "/secrets/sec_demo_model", method: "PATCH", status: 403, code: "FORBIDDEN" },
      ],
      actions: [
        click("Demo model API key (simulated)"),
        click("Replace value"),
        { selector: "#secret-value", value: "synthetic-story-value" },
        { selector: 'dialog button[type="submit"]', click: true },
      ],
      description: "A denied replacement clears the value, disables editing, and focuses Close.",
    },
    secretsDelete: {
      group: "Pages/Secrets",
      name: "Delete confirmation",
      path: "/console/secrets",
      actions: [click("Demo model API key (simulated)"), click("Delete Secret")],
      description:
        "Permanent storage deletion requires confirmation and explains upstream revocation and previously delivered values.",
    },
    secretsDeleteConflict: {
      group: "Pages/Secrets",
      name: "Concurrent reference conflict",
      path: "/console/secrets",
      rules: [
        {
          suffix: "/secrets/sec_demo_model",
          method: "DELETE",
          status: 409,
          code: "RESOURCE_CONFLICT",
          message:
            "The Secret is still referenced by Agent agt_00000000-0000-4000-8000-000000000001. Remove those references first.",
        },
      ],
      actions: [
        click("Demo model API key (simulated)"),
        click("Delete Secret"),
        click("Permanently delete Secret"),
      ],
      description:
        "A newly added reference can refuse deletion after the detail read. Reopen the detail to inspect current consumers.",
      steps: [
        "Tab to Permanently delete Secret. It takes focus and looks unavailable, described by the refusal; Enter, Space or a click sends nothing (finding 2935).",
      ],
    },
    secretsDeletionUnconfirmed: {
      group: "Pages/Secrets",
      name: "Deletion could not be confirmed",
      path: "/console/secrets",
      rules: [
        { suffix: "/secrets/sec_demo_model", method: "DELETE", bodyError: true },
        {
          suffix: "/secrets/sec_demo_model",
          skip: 1,
          data: { id: "sec_different", name: "Different Secret (simulated)" },
        },
      ],
      actions: [
        click("Demo model API key (simulated)"),
        click("Delete Secret"),
        click("Permanently delete Secret"),
        click("Check deletion status"),
      ],
      description:
        "The delete response was lost, then the status check returned a different Secret. The dialog leaves the outcome unknown and offers no second Delete.",
    },
  } satisfies Record<string, SecretScenario>;
}
