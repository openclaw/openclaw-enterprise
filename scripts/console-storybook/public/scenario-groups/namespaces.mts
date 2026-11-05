import type { NamespaceStatus } from "@openclaw-enterprise/contracts";
import type { ErrorCode } from "../../../../packages/contracts/src/api/common.ts";
import type { NamespaceListResponse } from "../../../../packages/contracts/src/api/resources.ts";
import type { StoryAction } from "../../story-action.mts";

type NamespaceRule = { path: "/namespaces" } & (
  | {
      method?: "GET";
      status: number;
      code?: ErrorCode;
      hold?: never;
      data?: never;
    }
  | {
      method?: "GET";
      data: NamespaceListResponse["data"];
      status?: never;
      code?: never;
      hold?: never;
    }
  | {
      method: "POST";
      status: number;
      code?: ErrorCode;
      hold?: never;
      data?: never;
    }
  | {
      method: "POST";
      hold: true;
      status?: never;
      code?: never;
      data?: never;
    }
);

type NamespaceScenario = {
  group: "Pages/Namespaces";
  name: string;
  path: "/console/namespaces" | `/console/namespaces?${string}`;
  description: string;
  steps?: readonly string[];
  gap?: string;
  mobile?: true;
  emptyAgents?: true;
  emptyNamespaces?: true;
  observabilityDenied?: true;
  namespaceStatus?: NamespaceStatus;
  namespaceDeleteDenied?: true;
  namespaceDeleteRestricted?: true;
  namespaceDeleteOutcome?: "complete" | "blocked" | "forbidden" | "pending" | "unknown" | "stalled";
  actions?: readonly StoryAction[];
  rules?: readonly NamespaceRule[];
};

export const namespacesScenarios = {
  namespaces: {
    group: "Pages/Namespaces",
    name: "Ready and provisioning",
    path: "/console/namespaces",
    description:
      "Installation-wide Namespace cards and Create Namespace, without a Namespace selector. Each card opens that Namespace's Agents; status badges read Ready or Provisioning.",
    steps: [
      "Select Create Namespace, enter a unique name, and submit. The success dialog explains provisioning; Open Agents selects the created Namespace.",
      "Reset, then cancel a new form with Escape. No Namespace is created and focus returns to Create Namespace.",
    ],
  },
  namespaceDelete: {
    group: "Pages/Namespaces",
    name: "Delete Namespace",
    path: "/console/namespaces",
    emptyAgents: true,
    namespaceDeleteOutcome: "complete",
    description:
      "Use the same trash icon as the Agents table, confirm the exact Namespace, and watch simulated cleanup finish.",
    steps: [
      "Select Engineering's trash icon, then Delete Namespace. The row stays Deleting until the next status reads confirm removal.",
    ],
  },
  namespaceDeleteConfirmation: {
    group: "Pages/Namespaces",
    name: "Delete confirmation",
    path: "/console/namespaces",
    namespaceDeleteOutcome: "complete",
    actions: [{ selector: '[aria-label="Delete Engineering"]', click: true }],
    description:
      "The confirmation identifies the Namespace and explains reserved names, asynchronous cleanup, and default Presets. Cancel restores focus to the trash icon.",
  },
  namespaceDeleteMobile: {
    group: "Pages/Namespaces",
    name: "Delete confirmation mobile",
    path: "/console/namespaces",
    mobile: true,
    namespaceDeleteOutcome: "complete",
    actions: [{ selector: '[aria-label="Delete Engineering"]', click: true }],
    description: "The same confirmation becomes a bottom sheet at phone width.",
  },
  namespaceDeleteBlocked: {
    group: "Pages/Namespaces",
    name: "Delete blocked by resources",
    path: "/console/namespaces",
    namespaceDeleteOutcome: "blocked",
    actions: [
      { selector: '[aria-label="Delete Engineering"]', click: true },
      { click: "Delete Namespace" },
    ],
    description:
      "A simulated NAMESPACE_NOT_EMPTY response names remaining resources the caller can read and counts the rest. Open Agents or Secrets, or inspect Configuration cleanup commands.",
  },
  namespaceDeleteDenied: {
    group: "Pages/Namespaces",
    name: "Delete permission denied",
    path: "/console/namespaces",
    namespaceDeleteDenied: true,
    description:
      "A member's advisory permission answer refuses deletion. The trash icon looks disabled and its reason says only an Installation administrator can delete a Namespace.",
  },
  namespaceDeleteRestricted: {
    group: "Pages/Namespaces",
    name: "Delete blocked by a Restriction",
    path: "/console/namespaces",
    namespaceDeleteRestricted: true,
    description:
      "An Installation administrator whom a deny Restriction keeps from deleting the Namespace. The reason names the Restriction and who can lift it, not an administrator to ask.",
    gap: "The permission answer is advisory. The controller still authorizes each delete.",
  },
  namespaceDeleteRefused: {
    group: "Pages/Namespaces",
    name: "Delete permission changed",
    path: "/console/namespaces",
    namespaceDeleteOutcome: "forbidden",
    actions: [
      { selector: '[aria-label="Delete Engineering"]', click: true },
      { click: "Delete Namespace" },
    ],
    description:
      "A write can still be refused after the advisory read. The row shows the reason and request ID.",
  },
  namespaceDeletePending: {
    group: "Pages/Namespaces",
    name: "Delete request pending",
    path: "/console/namespaces",
    namespaceDeleteOutcome: "pending",
    actions: [
      { selector: '[aria-label="Delete Engineering"]', click: true },
      { click: "Delete Namespace" },
    ],
    description:
      "The pending write blocks dismissal and navigation. Its timeout requires a status read before another attempt.",
  },
  namespaceDeleteUnknown: {
    group: "Pages/Namespaces",
    name: "Delete outcome unknown",
    path: "/console/namespaces",
    namespaceDeleteOutcome: "unknown",
    actions: [
      { selector: '[aria-label="Delete Engineering"]', click: true },
      { click: "Delete Namespace" },
    ],
    description:
      "An unconfirmed write requires Refresh status. The Console does not replay deletion or assume it started.",
  },
  namespaceDeleteRetry: {
    group: "Pages/Namespaces",
    name: "Delete cleanup recovery",
    path: "/console/namespaces",
    namespaceStatus: "deleting",
    namespaceDeleteOutcome: "stalled",
    description:
      "An existing deleting Namespace keeps status and deliberate retry controls. Only the backend decides whether retry is allowed.",
  },
  namespacesUnavailable: {
    group: "Pages/Namespaces",
    name: "Unavailable selection",
    path: "/console/namespaces?namespace=ns_00000000-0000-4000-8000-000000000099",
    description:
      "Recover from a stale Namespace URL using the selector inside the message, which says the Namespace is missing or not readable.",
    steps: [
      "Choose Engineering under Choose a valid Namespace; the URL changes and the warning disappears without leaving Namespaces.",
      "Use browser Back to return to the unavailable selection and recover again.",
    ],
  },
  namespacesUnavailableMobile: {
    group: "Pages/Namespaces",
    name: "Unavailable selection mobile",
    path: "/console/namespaces?namespace=ns_00000000-0000-4000-8000-000000000099",
    mobile: true,
    description: "Recover inline at 390px without opening navigation.",
  },
  namespacesUnavailableEmpty: {
    group: "Pages/Namespaces",
    name: "Unavailable selection without access",
    path: "/console/namespaces?namespace=ns_00000000-0000-4000-8000-000000000099",
    emptyNamespaces: true,
    description: "No readable alternatives: show access guidance instead of a selection action.",
  },
  namespacesEmpty: {
    group: "Pages/Namespaces",
    name: "Empty",
    path: "/console/namespaces",
    emptyNamespaces: true,
    description:
      "No readable Namespaces. Create Namespace remains available; the API decides whether creation is permitted.",
  },
  namespacesEmptyMember: {
    group: "Pages/Namespaces",
    name: "Empty for a member",
    path: "/console/namespaces",
    emptyNamespaces: true,
    observabilityDenied: true,
    description:
      "A person who does not administer the Installation gets Create Namespace as a secondary action and is told to ask an administrator. A Namespace create grant still works from it.",
  },
  namespaceCreateRefused: {
    group: "Pages/Namespaces",
    name: "Create refused, then closed",
    path: "/console/namespaces",
    emptyNamespaces: true,
    observabilityDenied: true,
    rules: [{ path: "/namespaces", method: "POST", status: 403, code: "FORBIDDEN" }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
      { click: "Cancel" },
    ],
    description:
      "After the API refuses creation, the page disables Create Namespace, says why, and focuses that reason. Refresh or a browser reload offers creation again.",
    steps: [
      "Tab to Create Namespace. It takes focus and looks unavailable, described by the refusal; Enter, Space or a click opens nothing.",
    ],
  },
  namespaceCreate: {
    group: "Pages/Namespaces",
    name: "Create Namespace",
    path: "/console/namespaces",
    actions: [{ click: "Create Namespace", focus: true }],
    description:
      "A name-only dialog uses the shared field and modal patterns. No credentials or infrastructure configuration are required in this form.",
    steps: [
      "Enter a unique name and create. Inspect the provisioning explanation, then select Done to see the new Namespace or Open Agents to use it.",
    ],
  },
  namespaceCreateMobile: {
    group: "Pages/Namespaces",
    name: "Create Namespace on mobile",
    path: "/console/namespaces",
    mobile: true,
    emptyNamespaces: true,
    actions: [{ click: "Create Namespace", focus: true }],
    description:
      "The empty list offers creation. On a phone the form becomes a bottom sheet with reachable actions.",
  },
  namespaceCreateRequired: {
    group: "Pages/Namespaces",
    name: "Create name required",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "Submitting an empty name shows a persistent inline error and focuses the field without sending a request.",
  },
  namespaceCreateInvalidName: {
    group: "Pages/Namespaces",
    name: "Create invalid name",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support\tteam" },
    ],
    description:
      "A pasted tab is refused at the field as it arrives, by the API's own Name rule, before any request. More than 200 characters is refused the same way instead of being cut.",
  },
  namespaceCreateConflict: {
    group: "Pages/Namespaces",
    name: "Create name conflict",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Engineering" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "An existing name is refused. The entered name remains editable; choose another name and submit again.",
  },
  namespaceCreateDenied: {
    group: "Pages/Namespaces",
    name: "Create permission denied",
    path: "/console/namespaces",
    emptyNamespaces: true,
    rules: [{ path: "/namespaces", method: "POST", status: 403, code: "FORBIDDEN" }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "A creation denial explains the missing Installation permission and disables resubmission. Cancel returns to the empty list.",
    steps: [
      "Tab to Namespace name and Create Namespace. Each takes focus and looks unavailable, described by the refusal; typing, Enter, Space or a click sends nothing (finding 2935).",
    ],
  },
  namespaceCreatePending: {
    group: "Pages/Namespaces",
    name: "Create pending",
    path: "/console/namespaces",
    rules: [{ path: "/namespaces", method: "POST", hold: true }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "While creation waits, the field and actions are disabled and Escape cannot dismiss the form. After the client timeout, inspect the unknown-outcome recovery.",
  },
  namespaceCreateUnknown: {
    group: "Pages/Namespaces",
    name: "Create outcome unknown",
    path: "/console/namespaces",
    rules: [{ path: "/namespaces", method: "POST", status: 503, code: "DEPENDENCY_UNAVAILABLE" }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "An unconfirmed write blocks resubmission. Check Namespaces rereads the list before a deliberate new attempt; this fixture does not establish whether the write committed.",
    steps: [
      "Tab to Namespace name and Create Namespace. Each takes focus and looks unavailable, described by the Outcome unknown warning; Enter, Space or a click sends nothing (finding 2935).",
    ],
  },
  namespaceCreateSuccess: {
    group: "Pages/Namespaces",
    name: "Namespace created",
    path: "/console/namespaces",
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "Creation succeeded in the simulated fixture. The dialog distinguishes provisioning from readiness and offers the new Namespace's Agents.",
  },
  namespaceCreateUnreadable: {
    group: "Pages/Namespaces",
    name: "Created without read access",
    path: "/console/namespaces",
    emptyNamespaces: true,
    // A create-only role: the authorized list never includes the new Namespace.
    rules: [{ path: "/namespaces", data: [] }],
    actions: [
      { click: "Create Namespace", focus: true },
      { selector: "#namespace-name", value: "Support" },
      { selector: 'dialog button[type="submit"]', click: true },
    ],
    description:
      "The caller may create Namespaces but not read them. The dialog says the Namespace was created and that their access does not include viewing it, and offers only Done.",
  },
  namespacesDenied: {
    group: "Pages/Namespaces",
    name: "Access denied",
    path: "/console/namespaces",
    rules: [{ path: "/namespaces", status: 403 }],
    description:
      "Namespace discovery is denied, as for an account whose access was removed. Private data stays hidden, and the panel offers Sign out beside Retry.",
    steps: ["Choose Sign out and confirm the sign-in page replaces the panel."],
  },
} satisfies Record<string, NamespaceScenario>;
