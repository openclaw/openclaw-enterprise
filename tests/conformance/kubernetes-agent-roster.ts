import assert from "node:assert/strict";
import type { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  HarnessAuthSnapshot,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  RevisionHarnessDescriptor,
} from "../../packages/contracts/src/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";

type RosterTopology = readonly [RevisionHarnessDescriptor, OpenClawConfigurationDocument];
type RosterRefusal = readonly [agents: OpenClawConfigurationValue, message: string];

function isConfigurationObject(
  value: OpenClawConfigurationValue | undefined,
): value is OpenClawConfigurationDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withAgentRoster(
  base: OpenClawConfigurationDocument,
  roster: OpenClawConfigurationValue,
): OpenClawConfigurationDocument {
  if (!isConfigurationObject(roster)) {
    return { ...base, agents: roster };
  }
  const baseAgents = base.agents;
  assert.ok(isConfigurationObject(baseAgents) && isConfigurationObject(baseAgents.defaults));
  const { defaults, ...agents } = roster;
  assert.ok(defaults === undefined || isConfigurationObject(defaults));
  return {
    ...base,
    agents: { ...baseAgents, ...agents, defaults: { ...baseAgents.defaults, ...defaults } },
  };
}

export function checkAgentRoster(
  driver: KubernetesComputeDriver,
  revision: {
    readonly harness: RevisionHarnessDescriptor;
    readonly harnessAuth: HarnessAuthSnapshot;
    readonly configuration: OpenClawConfigurationDocument;
  },
  codexConfiguration: OpenClawConfigurationDocument,
): void {
  const openClaw: RosterTopology = [revision.harness, revision.configuration];
  const codex: RosterTopology = [
    { id: "codex", version: "1.0.0", mode: "dedicated" },
    codexConfiguration,
  ];
  const validate = ([harness, base]: RosterTopology, agents: OpenClawConfigurationValue) =>
    driver.validateHarnessAuth(harness, revision.harnessAuth, withAgentRoster(base, agents));
  const assertAccepts = (
    selected: RosterTopology,
    rosters: readonly OpenClawConfigurationValue[],
    label?: string,
  ) => {
    for (const agents of rosters) {
      const description = JSON.stringify(agents);
      assert.doesNotThrow(
        () => validate(selected, agents),
        label ? `${label} ${description}` : description,
      );
    }
  };
  const missingMain = (topology: string) =>
    `${topology} serves the main Agent: add agents.entries.main, or rename an entry to main.`;
  // Dedicated Gateways serve main's workspace, including when the roster names a default owner.
  for (const [selected, topology] of [
    [openClaw, "Dedicated OpenClaw"],
    [codex, "Dedicated Codex"],
  ] as const) {
    const ownerRefusal = (owner: "sessionStore" | "systemAgent") =>
      `${topology} serves the main Agent: set agents.defaults.${owner}.agentId to main, or remove it.`;
    const rejected: readonly RosterRefusal[] = [
      [{ entries: { helper: { workspace: "/home/node/helper" } } }, missingMain(topology)],
      // OpenClaw's schema admits a leading underscore, but it is not a canonical id.
      [
        { ownership: "explicit", entries: { main: {}, _main: {} } },
        `${topology} rejects the Agent ID in agents.entries._main: use up to 64 letters, digits, _ or -, starting with a letter or digit.`,
      ],
      [
        {
          ownership: "explicit",
          entries: { main: {}, helper: {} },
          defaults: { sessionStore: { agentId: "helper" } },
        },
        ownerRefusal("sessionStore"),
      ],
      [
        {
          ownership: "explicit",
          entries: { main: {}, helper: {} },
          defaults: { systemAgent: { agentId: "helper" } },
        },
        ownerRefusal("systemAgent"),
      ],
    ];
    for (const [agents, message] of rejected) {
      assert.throws(
        () => validate(selected, agents),
        (error: unknown) => error instanceof ConfigurationHarnessError && error.message === message,
        `${topology} ${JSON.stringify(agents)}`,
      );
    }
    // Case and padding in the configured default owners are normalized.
    assertAccepts(
      selected,
      [
        {
          ownership: "explicit",
          entries: { Main: {}, helper: {} },
          defaults: { sessionStore: { agentId: "MAIN" }, systemAgent: { agentId: " main " } },
        },
        { ownership: "explicit", entries: { Main: {}, helper_2: {}, "re-viewer": {} } },
        { list: [] },
      ],
      topology,
    );
  }

  // A stored revision's preparation diagnostic should name the original refusal.
  const missingMainMessage = missingMain("Dedicated OpenClaw");
  assert.throws(
    () => validate(openClaw, { entries: { helper: {} } }),
    (error: unknown) => {
      assert.deepEqual(driver.describePrepareRevisionFailure(error), {
        code: "KUBERNETES_CONFIGURATION_INVALID",
        stage: "prepare_revision",
        errorClass: "ConfigurationHarnessError",
        message: missingMainMessage,
      });
      return error instanceof ConfigurationHarnessError && error.message === missingMainMessage;
    },
  );

  const embedded: RosterTopology = [
    { ...revision.harness, mode: "embedded" },
    revision.configuration,
  ];

  // The OpenClaw Gateway consumes all three topologies' rosters and exits at startup
  // (EX_CONFIG 78) on retired or malformed shapes, so admission refuses them up front.
  const listRefusal =
    "The OpenClaw Gateway rejects agents.list: remove it and configure each Agent under agents.entries, keyed by its Agent ID.";
  const ownershipRefusal =
    'The OpenClaw Gateway accepts only "explicit" for agents.ownership: set it to "explicit", or remove it if agents.entries has at most one entry.';
  const multiRefusal =
    'The OpenClaw Gateway needs agents.ownership "explicit" for more than one agents.entries entry: set it, or keep one entry.';
  const emptyRefusal =
    'The OpenClaw Gateway needs at least one agents.entries entry when agents.ownership is "explicit": add one, or remove agents.ownership.';
  const defaultRefusal = (id: string) =>
    `The OpenClaw Gateway rejects agents.entries.${id}.default: remove it.`;
  const entriesRefusal =
    "The OpenClaw Gateway requires agents.entries to be an object keyed by Agent ID.";
  const entryRefusal = (path: string) => `The OpenClaw Gateway requires ${path} to be an object.`;
  const idRefusal = (path: string) =>
    `The OpenClaw Gateway rejects the Agent ID in ${path}: use up to 64 letters, digits, _ or -, not starting with -.`;
  const duplicateRefusal = (first: string, second: string) =>
    `The OpenClaw Gateway normalizes agents.entries.${first} and agents.entries.${second} to the same Agent ID: rename one.`;
  const agentsRefusal = "The OpenClaw Gateway requires agents to be an object.";
  const gatewayRefusals: readonly RosterRefusal[] = [
    [{ ownership: "explicit", entries: {} }, emptyRefusal],
    [{ ownership: "explicit" }, emptyRefusal],
    [{ entries: { main: { default: true } } }, defaultRefusal("main")],
    [{ entries: { main: { default: false } } }, defaultRefusal("main")],
    [
      { entries: { main: {}, helper: { default: true, workspace: "/home/node/helper" } } },
      defaultRefusal("helper"),
    ],
    [
      { ownership: "explicit", entries: { main: {}, helper: { default: false } } },
      defaultRefusal("helper"),
    ],
    [{ list: [{ id: "main", default: true }] }, listRefusal],
    [{ list: [], entries: { main: {} } }, listRefusal],
    [{ list: [], ownership: "explicit", entries: { main: {} } }, listRefusal],
    // The Gateway drops an empty list only beside an implicit roster, so this names the list.
    [{ list: [], ownership: "explicit" }, listRefusal],
    [{ entries: { main: {}, helper: {} } }, multiRefusal],
    [{ ownership: "shared", entries: { main: {} } }, ownershipRefusal],
    // With several broken rules, an entry's default marker is named before the ownership.
    [{ ownership: "shared", entries: { main: { default: true } } }, defaultRefusal("main")],
    [{ entries: null }, entriesRefusal],
    [{ entries: [] }, entriesRefusal],
    [{ entries: "main" }, entriesRefusal],
    [{ entries: { main: null } }, entryRefusal("agents.entries.main")],
    [{ entries: { main: [] } }, entryRefusal("agents.entries.main")],
    [{ entries: { main: false } }, entryRefusal("agents.entries.main")],
    [
      { ownership: "explicit", entries: { main: {}, helper: null } },
      entryRefusal("agents.entries.helper"),
    ],
    [{ entries: { "main!": {} } }, idRefusal('agents.entries["main!"]')],
    // OpenClaw normalizes `main!` to main and may match it first.
    [
      {
        ownership: "explicit",
        entries: { "main!": { workspace: "/home/node/elsewhere" }, main: {} },
      },
      idRefusal('agents.entries["main!"]'),
    ],
    [{ entries: { " main": {} } }, idRefusal('agents.entries[" main"]')],
    [{ entries: { "-main": {} } }, idRefusal("agents.entries.-main")],
    [{ entries: { "a.b": {} } }, idRefusal('agents.entries["a.b"]')],
    [{ entries: { "": {} } }, idRefusal('agents.entries[""]')],
    [{ entries: { ["a".repeat(65)]: {} } }, idRefusal(`agents.entries.${"a".repeat(65)}`)],
    // A submitted key shows control and format characters as ?, quoted.
    [{ entries: { "a\u0000\u202e\u2028b": {} } }, idRefusal('agents.entries["a???b"]')],
    [{ entries: { 'a"b': null } }, entryRefusal('agents.entries["a\\"b"]')],
    [{ ownership: "explicit", entries: { main: {}, Main: {} } }, duplicateRefusal("main", "Main")],
    [
      { ownership: "explicit", entries: { main: {}, helper: {}, HELPER: {} } },
      duplicateRefusal("helper", "HELPER"),
    ],
    // OpenClaw drops trailing dashes from a key that starts with _.
    [{ ownership: "explicit", entries: { _x: {}, "_x-": {} } }, duplicateRefusal("_x", "_x-")],
    [{ ownership: "explicit", entries: { _X: {}, "_x--": {} } }, duplicateRefusal("_X", "_x--")],
    [null, agentsRefusal],
    [[], agentsRefusal],
  ];
  assertAccepts(openClaw, [
    // OpenClaw reads an empty roster as `{ main: {} }` and drops an empty list beside it.
    { entries: {} },
    { list: [] },
    { list: [], entries: {} },
    { entries: { main: { workspace: "/home/node/main" } } },
    { ownership: "explicit", entries: { Main: {}, helper: { workspace: "/home/node/helper" } } },
    {
      ownership: "explicit",
      entries: { main: {}, helper: {} },
      defaults: { systemAgent: { agentId: "Main" } },
    },
  ]);
  const longKey = "k.".repeat(200);
  for (const selected of [openClaw, embedded, codex]) {
    const [harness] = selected;
    for (const [agents, message] of gatewayRefusals) {
      assert.throws(
        () => validate(selected, agents),
        (error: unknown) => error instanceof ConfigurationHarnessError && error.message === message,
        `${harness.mode} ${harness.id} ${JSON.stringify(agents)}`,
      );
    }
    // The submitted key shortens the path so the message keeps the 256-code-point cap.
    assert.throws(
      () => validate(selected, { entries: { [longKey]: {} } }),
      (error: unknown) =>
        error instanceof ConfigurationHarnessError &&
        Array.from(error.message).length === 256 &&
        error.message.startsWith(
          'The OpenClaw Gateway rejects the Agent ID in agents.entries["k.k.',
        ) &&
        error.message.endsWith("…: use up to 64 letters, digits, _ or -, not starting with -."),
      `${harness.mode} ${harness.id} long key`,
    );
  }
  // Only dedicated execution serves main; embedded OpenClaw keeps any valid roster and follows
  // its Gateway's sole default Agent for workspace files.
  assertAccepts(embedded, [
    { entries: { helper: {} } },
    { list: [] },
    { ownership: "explicit", entries: { helper: {}, reviewer: {} } },
    { entries: { _helper: {} } },
    { entries: { "9lives": {} } },
    { entries: { ["a".repeat(64)]: {} } },
    { ownership: "explicit", entries: { Main: {}, helper_2: {}, "re-viewer": {} } },
    { ownership: "explicit", entries: { x: {}, "x-": {}, _x: {}, "_-x": {} } },
  ]);
}
