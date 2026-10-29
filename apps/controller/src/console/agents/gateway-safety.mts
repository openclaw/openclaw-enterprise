import { describeDisabled, element } from "../dom.mjs";
import { admitGatewaySecurityDefaults } from "../gateway-security-defaults.mjs";

type ConfigurationDocument = Readonly<Record<string, unknown>>;

type GatewaySafetySetting = {
  readonly id: string;
  readonly path: readonly string[];
  readonly label: string;
  // The help text for a deployment of `values`.
  readonly help: (values: ConfigurationDocument) => string;
  // The locked-down value Strict mode sets.
  readonly strict: boolean;
  // OpenClaw's default when deployment admission leaves the setting unset.
  readonly gatewayDefault: boolean;
};

/** The Gateway collaboration and safety settings the Configuration tab offers as toggles. */
export const GATEWAY_SAFETY_SETTINGS: readonly GatewaySafetySetting[] = [
  {
    id: "collaborative-steering",
    path: ["messages", "queue", "allowCollaborativeSteering"],
    label: "Other participants can steer a running turn",
    help: (values) =>
      `On: while a turn runs, another Gateway participant in the conversation can add guidance to it. The turn keeps the identity and permissions of the participant who started it, even when the participant steering has fewer. Participants are channel users or local operators with distinct Gateway identities. OCE native admin and workspace access share one Gateway identity, so this setting does not separate OCE users. ${steeringOffHelp(values)}`,
    strict: false,
    gatewayDefault: true,
  },
  {
    id: "apply-patch-workspace",
    path: ["tools", "exec", "applyPatch", "workspaceOnly"],
    label: "apply_patch changes files only in the workspace",
    help: () =>
      "On: the apply_patch tool can add and change files only in the Agent’s workspace. Off: it can also change files outside the workspace that the Agent’s runtime can write.",
    strict: true,
    gatewayDefault: false,
  },
];

export type GatewaySafetyValue =
  | { readonly kind: "value"; readonly value: boolean; readonly explicit: boolean }
  // A non-boolean value, or a non-object on the path: the Gateway refuses it at startup.
  | { readonly kind: "invalid" };

function isObject(value: unknown): value is ConfigurationDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function steeringOffHelp(values: ConfigurationDocument) {
  const queue = isObject(values.messages) ? values.messages.queue : undefined;
  return isObject(queue) && queue.collaborativeSteeringFallback === "reject"
    ? "Off: the Gateway refuses their message and asks them to resend it with /followup, which runs it as a separate turn after it."
    : "Off: their message runs as a separate turn after it.";
}

function configured(values: unknown, path: readonly string[]) {
  let current = values;
  for (const key of path) {
    if (!isObject(current)) {
      return { kind: "invalid" } as const;
    }
    current = current[key];
    if (current === undefined) {
      return { kind: "unset" } as const;
    }
  }
  return typeof current === "boolean"
    ? ({ kind: "value", value: current } as const)
    : ({ kind: "invalid" } as const);
}

/**
 * The value the Gateway runs with for `setting`: the Configuration's own, else the value
 * deployment admission fills, else OpenClaw's default.
 */
export function gatewaySafetyValue(
  values: ConfigurationDocument,
  setting: GatewaySafetySetting,
): GatewaySafetyValue {
  const own = configured(values, setting.path);
  if (own.kind !== "unset") {
    return own.kind === "value" ? { ...own, explicit: true } : own;
  }
  const admitted = configured(admitGatewaySecurityDefaults(values), setting.path);
  return {
    kind: "value",
    value: admitted.kind === "value" ? admitted.value : setting.gatewayDefault,
    explicit: false,
  };
}

function withValue(
  values: ConfigurationDocument,
  [key, ...rest]: readonly string[],
  value: boolean | undefined,
): ConfigurationDocument {
  const name = key!;
  const current = values[name];
  const next = rest.length === 0 ? value : withValue(isObject(current) ? current : {}, rest, value);
  // Removing the setting also removes the objects it leaves empty.
  if (next === undefined || (isObject(next) && Object.keys(next).length === 0)) {
    return Object.fromEntries(Object.entries(values).filter(([other]) => other !== name));
  }
  return { ...values, [name]: next };
}

/**
 * `values` with `setting` at `value`; `undefined` removes it, so it follows the default. A toggle
 * also removes a value equal to the default; `pin` keeps it, so Strict mode stays strict if a
 * default changes. Returns `values` itself when nothing changes, or when a non-object sits on the
 * setting's path.
 */
export function withGatewaySafetyValue(
  values: ConfigurationDocument,
  setting: GatewaySafetySetting,
  value: boolean | undefined,
  { pin = false }: { pin?: boolean } = {},
): ConfigurationDocument {
  const own = configured(values, setting.path);
  if (own.kind === "invalid" && !isObject(parentOf(values, setting.path))) {
    return values;
  }
  const unset = own.kind === "unset" ? values : withValue(values, setting.path, undefined);
  const fallback = gatewaySafetyValue(unset, setting);
  const target = !pin && fallback.kind === "value" && fallback.value === value ? undefined : value;
  if (target === undefined) {
    return unset;
  }
  return own.kind === "value" && own.value === target
    ? values
    : withValue(values, setting.path, target);
}

function parentOf(values: ConfigurationDocument, path: readonly string[]) {
  let current: unknown = values;
  for (const key of path.slice(0, -1)) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key] ?? {};
  }
  return current;
}

/** Whether every setting runs with its locked-down value. */
export function gatewaySafetyStrict(values: ConfigurationDocument) {
  return GATEWAY_SAFETY_SETTINGS.every((setting) => {
    const value = gatewaySafetyValue(values, setting);
    return value.kind === "value" && value.value === setting.strict;
  });
}

/**
 * Strict mode writes every setting's locked-down value into the Configuration; off removes them,
 * so each setting follows its default.
 */
export function withGatewaySafetyStrict(values: ConfigurationDocument, strict: boolean) {
  return GATEWAY_SAFETY_SETTINGS.reduce(
    (document, setting) =>
      withGatewaySafetyValue(document, setting, strict ? setting.strict : undefined, {
        pin: true,
      }),
    values,
  );
}

const STRICT_HELP =
  "Sets every setting below to its locked-down value. Turn it off to return each setting to its default.";
const INTRO =
  "These Gateway settings apply to every conversation with this Agent. The defaults let the people who share the Agent work together; Strict mode locks each setting down. A change here edits the Configuration JSON: save it, then deploy a new version.";
const INVALID =
  "The Configuration JSON sets this to a value the Gateway refuses. Correct it in the JSON.";

function sourceText(value: GatewaySafetyValue) {
  if (value.kind === "invalid") {
    return INVALID;
  }
  return value.explicit ? "Set in Configuration." : `Default: ${value.value ? "on" : "off"}.`;
}

/**
 * The Configuration tab's collaboration and safety toggles. They show what a deployment of
 * `values` runs with, and each change calls `onChange` with the edited document; the caller
 * stages it in the Configuration JSON editor, which saves it. `update` shows another document,
 * or none (unreadable JSON), and the reason the toggles are unavailable, if any.
 */
export function gatewaySafetyControls({
  onChange,
}: {
  onChange: (values: ConfigurationDocument) => void;
}) {
  let current: ConfigurationDocument | undefined;
  let unavailableReason: string | null = null;
  const reason = element("p", { className: "hint", id: "gateway-safety-reason", hidden: true });
  const toggle = (id: string, label: string, helpText: string, change: (on: boolean) => void) => {
    const input = element("input", {
      type: "checkbox",
      id: `gateway-safety-${id}`,
      "aria-describedby": `gateway-safety-${id}-hint`,
    });
    const source = element("strong", { className: "gateway-safety-source" });
    const help = element("span", { className: "gateway-safety-help" }, helpText);
    const hint = element(
      "p",
      { className: "hint field-help", id: `gateway-safety-${id}-hint` },
      source,
      help,
    );
    input.addEventListener("change", () => change(input.checked));
    const node = element(
      "div",
      { className: "gateway-safety-setting" },
      element("label", { className: "gateway-safety-toggle" }, input, label),
      hint,
    );
    return { input, source, help, node };
  };
  const stage = (next: ConfigurationDocument) => {
    if (current !== undefined && next !== current) {
      onChange(next);
    } else {
      // Nothing changed (Strict mode off when every default is already strict): show it again.
      update(current, unavailableReason);
    }
  };
  const strict = toggle("strict", "Strict mode", STRICT_HELP, (on) => {
    stage(withGatewaySafetyStrict(current ?? {}, on));
  });
  const rows = GATEWAY_SAFETY_SETTINGS.map((setting) => ({
    setting,
    ...toggle(setting.id, setting.label, setting.help({}), (on) => {
      stage(withGatewaySafetyValue(current ?? {}, setting, on));
    }),
  }));
  const node = element(
    "section",
    { className: "gateway-safety", "aria-labelledby": "gateway-safety-heading" },
    element("h3", { id: "gateway-safety-heading" }, "Collaboration and safety"),
    element("p", { className: "hint" }, INTRO),
    strict.node,
    element("div", { className: "gateway-safety-settings" }, ...rows.map((row) => row.node)),
    reason,
  );

  function update(values: ConfigurationDocument | undefined, unavailable: string | null) {
    current = values;
    unavailableReason = unavailable;
    reason.hidden = !unavailable;
    reason.textContent = unavailable ?? "";
    let anyBlocked = false;
    for (const { setting, input, source, help } of rows) {
      const value = values === undefined ? undefined : gatewaySafetyValue(values, setting);
      const invalid = value?.kind === "invalid";
      // A non-object on the path: only the JSON editor can correct it.
      const blocked =
        invalid && withGatewaySafetyValue(values ?? {}, setting, !setting.strict) === values;
      anyBlocked ||= blocked;
      input.checked = value?.kind === "value" && value.value;
      input.indeterminate = invalid;
      input.disabled = Boolean(unavailable) || values === undefined || blocked;
      source.textContent = value === undefined ? "" : `${sourceText(value)} `;
      // Unreadable JSON keeps the last help shown.
      if (values !== undefined) {
        help.textContent = setting.help(values);
      }
      describeDisabled(input, reason);
    }
    strict.input.checked = values !== undefined && gatewaySafetyStrict(values);
    strict.input.disabled = Boolean(unavailable) || values === undefined || anyBlocked;
    strict.source.textContent = "";
    describeDisabled(strict.input, reason);
  }

  return { node, update };
}
