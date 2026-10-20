import type { AgentGatewayPerson } from "@openclaw-enterprise/contracts";

// Access presentation fixtures; these do not prove live ingress or persistence.
export function directControlUiAccessScenarios() {
  const revision =
    "/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=ns_00000000-0000-4000-8000-000000000001&revision=rev_00000000-0000-4000-8000-000000000001";
  const largeGatewayTeam: AgentGatewayPerson[] = Array.from({ length: 50 }, (_, index) => ({
    identity: `teammate-${String(index + 1).padStart(2, "0")}@example.com`,
    profileId: `profile-${index}`,
    displayName: `${["Alex", "Casey", "Jordan", "Morgan", "Riley"][index % 5]} ${String(50 - index).padStart(2, "0")}`,
    role: index % 13 === 0 ? "maintainer" : "member",
    hasAvatar: false,
  }));

  // Configured users need not have connected or created a Gateway profile.
  largeGatewayTeam[45] = {
    identity: "a.new.research.collaborator.with.a.long.identity@example.com",
    profileId: null,
    displayName: "",
    role: null,
    hasAvatar: false,
  };
  return {
    controlUiBookmark: {
      name: "Control UI bookmark",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      controlUiBookmarkUrl: "https://control.example.com/research-assistant",
      gatewayPeople: largeGatewayTeam.slice(0, 3),
      description: "Shared direct-entry bookmark, separate from OCC sharing and native identities.",
      workflow: [
        "Edit link, then Save or Cancel.",
        "Remove clears only the bookmark.",
        "The external link opens in a new tab without prefetching.",
      ],
      gap: "Simulated UI proof only; not backend persistence, IAM enforcement, or authenticated ingress proof.",
    },
    controlUiBookmarkEmpty: {
      name: "Control UI bookmark empty",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      description: "No direct URL saved. Agent update permission enables Add direct URL.",
    },
    controlUiBookmarkReadonly: {
      name: "Control UI bookmark readonly",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      controlUiBookmarkUrl: "https://control.example.com/research-assistant",
      readOnlyPermissionSummary: true,
      description:
        "Agent readers see the saved link without editing or the administer-only native roster.",
    },
    controlUiBookmarkLoading: {
      name: "Control UI bookmark loading",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      rules: [{ method: "GET", suffix: "/control-ui-bookmark", delayMs: 600000 }],
      description: "Bookmark loading is independent of the native roster and OCC sharing.",
    },
    controlUiBookmarkError: {
      name: "Control UI bookmark error",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      rules: [{ method: "GET", suffix: "/control-ui-bookmark", status: 503 }],
      description:
        "A bookmark read failure has its own refresh action; other Access cards remain usable.",
    },
    controlUiBookmarkEdit: {
      name: "Control UI bookmark edit",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      controlUiBookmarkUrl: "https://control.example.com/research-assistant",
      actions: [{ click: "Edit link" }],
      description: "Small inline URL editor with Save, Cancel, and Remove.",
    },
    controlUiBookmarkConflict: {
      name: "Control UI bookmark conflict",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      controlUiBookmarkUrl: "https://control.example.com/research-assistant",
      bookmarkConflictOnce: true,
      actions: [
        { click: "Edit link" },
        { selector: "#control-ui-bookmark-url", value: "https://new.example.com/control-ui" },
        { selector: ".control-ui-bookmark-form button[type=submit]", click: true },
      ],
      description:
        "A competing save preserves input and requires an explicit bookmark refresh before saving again.",
    },
    controlUiBookmarkUncertain: {
      name: "Control UI bookmark uncertain",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      controlUiBookmarkUrl: "https://control.example.com/research-assistant",
      bookmarkUncertainOnce: true,
      actions: [
        { click: "Edit link" },
        { selector: "#control-ui-bookmark-url", value: "https://new.example.com/control-ui" },
        { selector: ".control-ui-bookmark-form button[type=submit]", click: true },
      ],
      description:
        "An uncertain save is reconciled by reading, never automatic write replay. Input remains for review.",
    },
    controlUiBookmarkRosterUnavailable: {
      name: "Control UI bookmark roster unavailable",
      group: "Components/Direct Control UI access",
      path: revision + "&tab=access",
      deployed: true,
      controlUiBookmarkUrl: "https://control.example.com/research-assistant",
      rules: [
        { method: "GET", suffix: "/gateway/people", status: 501 },
        { method: "GET", suffix: "/configuration", status: 403 },
      ],
      description:
        "Bookmark remains available when native roster support or configuration reads are unavailable.",
    },
    gatewayPeople: {
      controlUiBookmarkUrl: "https://control.example.com/research-assistant",
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Configured users",
      gatewayPeople: [
        {
          identity: "oidc:alice.hart@example.test",
          profileId: "profile-alice-hart",
          displayName: "Alice Hart",
          role: "maintainer",
          hasAvatar: false,
        },
        {
          identity: "oidc:marco.rivera@example.test",
          profileId: "profile-marco-rivera",
          displayName: "Marco Rivera",
          role: "member",
          hasAvatar: false,
        },
        {
          identity: "oidc:never-connected-collaborator-with-a-long-subject-identifier@example.test",
          profileId: null,
          displayName: "",
          role: null,
          hasAvatar: false,
        },
      ],
      description:
        "Configured Gateway identities with optional profile names and native roles, separate from OCC Roles.",
      steps: [
        "Check configured identities below friendly names and Gateway role labels, then refresh users.",
        "Resize to phone width; names and roles remain readable.",
      ],
      gap: "Simulated UI proof; real Gateway configuration and exact profile matching are verified separately.",
    },
    gatewayPeopleLarge: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "50 people",
      gatewayPeople: largeGatewayTeam,
      description:
        "Fifty configured users remain compact in a searchable inline list on Access. A never-connected identity needs no profile.",
      steps: [
        "Search the inline list for Riley, then teammate-01@example.com, and then a name that is absent.",
        "Clear the search and scroll the compact inline list. OCC sharing stays separate below; no drawer opens.",
        "Repeat at 390px with a reserved scrollbar gutter; both panel edges stay visible and its list scrolls.",
      ],
    },
    gatewayPeopleSearch: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Search people",
      gatewayPeople: largeGatewayTeam,
      actions: [{ selector: "#gateway-people-search", value: "Riley" }],
      description: "Search the full list by name or configured identity, regardless of case.",
    },
    gatewayPeopleIdentitySearch: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Search configured identity",
      gatewayPeople: largeGatewayTeam,
      actions: [{ selector: "#gateway-people-search", value: "teammate-01@example.com" }],
      description: "An identity search finds a named user without searching a profile ID.",
    },
    gatewayPeopleNoMatches: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "No matching people",
      gatewayPeople: largeGatewayTeam,
      actions: [{ selector: "#gateway-people-search", value: "no such person" }],
      description: "An empty search result leaves the search and close controls available.",
    },
    gatewayPeopleNeverConnected: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Never connected",
      gatewayPeople: [
        {
          identity: "oidc:never-connected-collaborator-with-a-long-subject-identifier",
          profileId: null,
          displayName: "",
          role: null,
          hasAvatar: false,
        },
      ],
      description:
        "A configured identity appears once even before a Gateway profile exists. No role or avatar is invented.",
    },
    gatewayPeopleEmpty: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Empty",
      gatewayPeople: [],
      description: "No configured human identities; the list does not wait for someone to connect.",
      steps: ["Inspect Access: direct users come first, followed by Share Agent through OCC."],
    },
    gatewayPeopleNotConfigured: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Not configured and hidden",
      gatewayPeople: null,
      description: "An installation without a Gateway people adapter hides the card.",
      steps: ["Check that OCC sharing remains usable when direct users are unavailable."],
    },
    gatewayPeopleLoading: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Independent loading",
      gatewayPeople: [
        {
          identity: "alice@example.com",
          profileId: "profile-alice",
          displayName: "Alice Chen",
          role: "member",
          hasAvatar: false,
        },
        {
          identity: "bob@example.com",
          profileId: "profile-bob",
          displayName: "Bob Rivera",
          role: "maintainer",
          hasAvatar: false,
        },
      ],
      rules: [{ method: "GET", suffix: "/gateway/people", hold: true }],
      description:
        "The authorized direct roster shows its own loading state while OCC sharing remains independently usable.",
      steps: ["Inspect Access: direct users come first, followed by Share Agent through OCC."],
    },
    gatewayPeopleError: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Unavailable and retry",
      gatewayPeople: [
        {
          identity: "alice@example.com",
          profileId: "profile-alice",
          displayName: "Alice Chen",
          role: "member",
          hasAvatar: false,
        },
        {
          identity: "bob@example.com",
          profileId: "profile-bob",
          displayName: "Bob Rivera",
          role: "maintainer",
          hasAvatar: false,
        },
      ],
      rules: [{ method: "GET", suffix: "/gateway/people", status: 503, once: true }],
      description: "Review the Gateway people unavailable and retry state.",
      steps: ["Inspect Access: direct users come first, followed by Share Agent through OCC."],
    },
    gatewayPeopleDenied: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Denied and hidden",
      gatewayPeople: [
        {
          identity: "alice@example.com",
          profileId: "profile-alice",
          displayName: "Alice Chen",
          role: "member",
          hasAvatar: false,
        },
        {
          identity: "bob@example.com",
          profileId: "profile-bob",
          displayName: "Bob Rivera",
          role: "maintainer",
          hasAvatar: false,
        },
      ],
      rules: [{ method: "GET", suffix: "/gateway/people", status: 403 }],
      description: "Review the Gateway people denied and hidden state.",
      steps: ["Inspect Access: direct users come first, followed by Share Agent through OCC."],
    },
    gatewayPeopleAccessGranted: {
      group: "Components/Direct Control UI access",
      name: "Access granted after denial",
      path: `${revision}&tab=access`,
      deployed: true,
      gatewayPeople: [
        {
          identity: "alice@example.com",
          profileId: "profile-alice",
          displayName: "Alice Chen",
          role: "member",
          hasAvatar: false,
        },
        {
          identity: "bob@example.com",
          profileId: "profile-bob",
          displayName: "Bob Rivera",
          role: "maintainer",
          hasAvatar: false,
        },
      ],
      rules: [{ method: "GET", suffix: "/gateway/people", status: 403, once: true }],
      description:
        "A denied roster stays hidden until the reader explicitly retries after a grant.",
      steps: [
        "The configured-users card starts hidden. Select the page Refresh button to retry authorization and reveal the roster.",
      ],
      gap: "The fixture simulates a grant by refusing only the first read; real IAM recovery has browser integration coverage.",
    },
    gatewayPeopleSharingDenied: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Roster allowed, OCC sharing denied",
      gatewayPeople: [
        {
          identity: "oidc:alex.morgan@example.test",
          profileId: "profile-alex",
          displayName: "Alex Morgan",
          role: "maintainer",
          hasAvatar: false,
        },
        {
          identity: "oidc:never-connected-long-subject@example.test",
          profileId: null,
          displayName: "",
          role: null,
          hasAvatar: false,
        },
      ],
      rules: [{ method: "GET", suffix: "/iam/roles", status: 403 }],
      description:
        "Exact-Agent administration can read direct Gateway identities even when Installation policy refuses OCC sharing. No access-editing control is added to the roster.",
      steps: [
        "Search the inline direct list. OCC sharing shows its own unavailable policy state below it.",
      ],
      gap: "Simulated UI proof; real authorization and denial-cache recovery are covered by browser integration fixtures.",
    },
    gatewayPeopleStopped: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "No serving Gateway",
      gatewayPeople: [
        {
          identity: "alice@example.com",
          profileId: "profile-alice",
          displayName: "Alice Chen",
          role: "member",
          hasAvatar: false,
        },
        {
          identity: "bob@example.com",
          profileId: "profile-bob",
          displayName: "Bob Rivera",
          role: "maintainer",
          hasAvatar: false,
        },
      ],
      rules: [{ method: "GET", suffix: "/gateway/people", status: 409 }],
      description: "Review the Gateway people no serving gateway state.",
      steps: ["Inspect Access: direct users come first, followed by Share Agent through OCC."],
    },
    gatewayPeopleAvatar: {
      group: "Components/Direct Control UI access",
      path: `${revision}&tab=access`,
      deployed: true,
      name: "Avatar fallback",
      gatewayPeople: [
        {
          identity: "alice@example.com",
          profileId: "profile-alice",
          displayName: "Alice Chen",
          role: "member",
          hasAvatar: true,
        },
        {
          identity: "bob@example.com",
          profileId: "profile-bob",
          displayName: "Bob Rivera",
          role: "maintainer",
          hasAvatar: true,
        },
      ],
      description: "Alice loads a synthetic image; Bob’s missing image falls back to initials.",
      steps: ["Inspect Access: direct users come first, followed by Share Agent through OCC."],
    },
  };
}
