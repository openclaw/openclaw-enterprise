import type { StoryAction } from "../../story-action.mts";
import type { DriverConfigurationDescriptor } from "@openclaw-enterprise/contracts";
import type { ErrorCode } from "../../../../packages/contracts/src/api/common.ts";

type SettingsRule =
  | ({ path: "/installation/driver-configurations" } & (
      | { data: { configurations: readonly DriverConfigurationDescriptor[] } }
      | { hold: true }
      | { status: number; code?: ErrorCode }
    ))
  | { path: "/api/auth/sign-out"; method: "POST"; status: number };

type SettingsScenario = {
  actions?: StoryAction[];
  group: "Pages/Settings";
  name: string;
  path: "/console/settings";
  description: string;
  steps?: readonly string[];
  installationModelProvider?: true;
  installationNestedValues?: true;
  installationValuesUnavailable?: true;
  readOnlyPermissionSummary?: true;
  sessionUser?: { id: string; name: string; email: string };
  rules?: readonly SettingsRule[];
};

export const settingsScenarios = {
  settings: {
    group: "Pages/Settings",
    name: "Account",
    path: "/console/settings",
    description:
      "An account card with initials, name and email, and a Session card with Sign out. Administrators can inspect accepted startup fields or the same values as JSON, including redacted sections and an empty object. There are no editable settings in this release.",
    steps: [
      "Check that the page has no Namespace selector and that the account card shows initials, name and email.",
      "Expand each Installation Driver below the cards. Read the human labels and raw keys; Credential Gateway shows binary paths, Sandbox shows nested fields and hidden resources, and IAM has no visible fields. Switch Fields / JSON and confirm the expanded groups stay open.",
      "Choose Sign out in the Session card: “Signing out…” appears, then the sign-in page.",
      "On a long page, scroll to the bottom and check that the sidebar background and operator profile reach it. At phone width, values fit and the existing navigation drawer still opens.",
    ],
  },
  settingsModelProvider: {
    group: "Pages/Settings",
    name: "Shared model provider",
    path: "/console/settings",
    installationModelProvider: true,
    description:
      "Read the shared Compute provider as Fields and JSON. The same endpoint serves Codex and OpenClaw. These are simulated accepted Installation values; editing remains an operator configuration task.",
    steps: [
      "Expand Compute, then runtime and modelProvider.",
      "Switch to JSON and confirm protocol and baseUrl.",
      "No key or source routing field is present.",
    ],
  },
  settingsDriverNestedValues: {
    group: "Pages/Settings",
    name: "Nested Driver values",
    path: "/console/settings",
    installationNestedValues: true,
    description:
      "A simulated package Driver has nested records, arrays, empty values and a writeOnly field. The API fixture returns its redaction marker, and the production renderer handles the safe JSON without a bundled schema-specific form. The expanded page exercises the shared sidebar beyond one viewport.",
    steps: [
      "Expand Configuration. Inspect groups, nested records, false, zero, null, empty arrays and objects, literal markup text, and the hidden value.",
      "Switch to JSON and back to Fields. The values and expanded state remain unchanged.",
      "Scroll to the bottom: the navigation background and profile reach the page bottom. At phone width, open and close the navigation drawer and check that fields fit the viewport.",
    ],
  },
  settingsDriverValuesUnavailable: {
    group: "Pages/Settings",
    name: "Driver values unavailable",
    path: "/console/settings",
    installationValuesUnavailable: true,
    description:
      "These simulated Driver schemas mark the whole startup object writeOnly, so the API omits its values. Each expanded group explains that values are unavailable; schemas are not substituted.",
    steps: ["Expand a Driver and check the unavailable message. No JSON Schema is shown."],
  },
  settingsDriverConfigurationsEmpty: {
    group: "Pages/Settings",
    name: "No Driver configurations",
    path: "/console/settings",
    rules: [{ path: "/installation/driver-configurations", data: { configurations: [] } }],
    description: "Installation discovery succeeds without any selected Driver configurations.",
    steps: ["Check the empty message beneath the Installation Driver configuration heading."],
  },
  settingsDriverConfigurationsLoading: {
    group: "Pages/Settings",
    name: "Driver configuration loading",
    path: "/console/settings",
    rules: [{ path: "/installation/driver-configurations", hold: true }],
    description:
      "Installation discovery is pending. The section shows a loading message until the normal client timeout reports the failed read.",
  },
  settingsDriverConfigurationsFailure: {
    group: "Pages/Settings",
    name: "Driver configuration unavailable",
    path: "/console/settings",
    rules: [{ path: "/installation/driver-configurations", status: 503 }],
    description:
      "Installation discovery fails. The section reports the read failure without exposing values or showing a schema fallback.",
  },
  settingsDriverConfigurationsDenied: {
    group: "Pages/Settings",
    name: "No Installation admin access: no Driver query",
    path: "/console/settings",
    readOnlyPermissionSummary: true,
    description:
      "The account can still use its Account and Session cards. Its permissions say it cannot administer the Installation, so Settings skips the Driver configuration request and leaves out the section.",
  },
  settingsDriverConfigurationsEndpointRefused: {
    group: "Pages/Settings",
    name: "Driver configuration endpoint refused",
    path: "/console/settings",
    rules: [{ path: "/installation/driver-configurations", status: 403, code: "FORBIDDEN" }],
    description:
      "The Driver configuration request returns 403 FORBIDDEN. A permissions recheck confirms that the account can still administer the Installation, so the Driver section stays visible with a refusal alert and no values. The Account and Session cards also remain visible.",
  },
  settingsNameIsEmail: {
    group: "Pages/Settings",
    name: "Account without a display name",
    path: "/console/settings",
    // Sign-in providers that have no display name record the email as the name.
    sessionUser: {
      id: "storybook-operator",
      name: "operator@example.com",
      email: "operator@example.com",
    },
    description:
      "An account whose recorded name is its email address. The account card names it once, by email.",
    steps: [
      "Check that the account card shows the initial O and operator@example.com under Email, with no Name row repeating the address.",
      "Compare Account: a distinct display name still shows under Name.",
    ],
  },
  settingsSignOutFailure: {
    group: "Pages/Settings",
    name: "Sign-out unconfirmed",
    path: "/console/settings",
    rules: [{ path: "/api/auth/sign-out", method: "POST", status: 503 }],
    // The account menu's hidden Sign out comes first in the page, so name the card's button.
    actions: [{ selector: ".settings-sign-out", click: true }],
    description:
      "Sign out from the Session card fails with the session still active: private content stays hidden until revocation can be confirmed.",
    steps: [
      "Choose Retry: it repeats the sign-out and keeps private content hidden until it succeeds.",
    ],
  },
} satisfies Record<string, SettingsScenario>;
