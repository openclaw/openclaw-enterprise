import { button, dismissOnBackdrop, element } from "../dom.mjs";
import { displayDate, namespacePath } from "./list.mjs";
import { visibleText } from "./logs-view.mjs";

function table(caption, headings, rows) {
  return element(
    "div",
    { className: "policy-table-scroll" },
    element(
      "table",
      { className: "policy-table" },
      element("caption", {}, caption),
      element(
        "thead",
        {},
        element("tr", {}, ...headings.map((heading) => element("th", { scope: "col" }, heading))),
      ),
      element(
        "tbody",
        {},
        ...rows.map((row) =>
          element("tr", {}, ...row.map((value) => element("td", {}, visibleText(value)))),
        ),
      ),
    ),
  );
}

function errorText(error, operation) {
  const message =
    error.status === 403
      ? "Policy access requires Agent operate and read access plus read access to this version. Log access alone does not grant policy access."
      : error.status === 409
        ? "The policy changed. Reload the snapshot before testing this action again."
        : error.status === 501
          ? `${operation} is not supported by the selected Driver.`
          : (error.serverMessage ?? `${operation} is unavailable. Try again shortly.`);
  return error.requestId ? `${message} Request ID: ${error.requestId}` : message;
}

function field(label, id, attributes = {}, hint = null) {
  const input = element("input", { id, autocomplete: "off", ...attributes });
  const help = hint === null ? null : element("p", { id: `${id}-help`, className: "hint" }, hint);
  if (help) {
    input.setAttribute("aria-describedby", help.id);
  }
  return {
    input,
    node: element(
      "div",
      { className: "form-field" },
      element("label", { for: id }, label),
      input,
      help,
    ),
  };
}

function selection(label, id, choices) {
  const input = element(
    "select",
    { id },
    ...choices.map(([value, name]) => element("option", { value }, name)),
  );
  return {
    input,
    node: element("div", { className: "form-field" }, element("label", { for: id }, label), input),
  };
}

function checks(values) {
  return element(
    "div",
    {},
    ...(values.length
      ? [
          element("h4", {}, "Checks not evaluated"),
          element("ul", {}, ...values.map((value) => element("li", {}, visibleText(value)))),
        ]
      : []),
  );
}

function intendedInventory(snapshot) {
  const policy = snapshot.policy;
  const inventory = element(
    "section",
    { className: "policy-inventory", "aria-label": "OCE intended policy" },
    element("h3", {}, "OCE intended policy"),
    element(
      "p",
      { className: "hint" },
      policy.kind === "network"
        ? "This snapshot comes from the current Sandbox Driver configuration for this version. Agent versions do not freeze that configuration. Simulation does not establish the running policy or reproduce an earlier log decision."
        : "This snapshot comes from the selected version’s saved plugin policy. Simulation does not verify native runtime policy or replay an earlier action.",
    ),
    element(
      "p",
      { className: "hint policy-hash" },
      `Simulation snapshot: ${snapshot.simulationHash}`,
    ),
  );
  if (policy.kind === "network") {
    inventory.append(
      table(
        "Intended network rules",
        ["Rule", "Executables", "Destinations", "Simulation limits"],
        policy.rules.map((rule) => [
          rule.name,
          rule.binaries.join(", ") || "No executable conditions",
          rule.destinations
            .map(
              (destination) =>
                `${destination.host}:${destination.ports.join(",")} ${destination.http ? `· HTTP ${destination.http.methods.join(", ")} · ${destination.http.enforcement}` : ""}`,
            )
            .join("; ") || "Built-in decision",
          [
            rule.unsupportedReason,
            ...rule.destinations.map((destination) => destination.unsupportedReason),
          ]
            .filter(Boolean)
            .join("; ") || "—",
        ]),
      ),
    );
  } else {
    inventory.append(
      table(
        "Intended plugin policies",
        ["Plugin", "Enabled", "Tool defaults", "Tool overrides"],
        Object.entries(policy.plugins).map(([id, configured]) => [
          id,
          configured.enabled ? "Yes" : "No",
          JSON.stringify(configured.toolDefaults ?? {}),
          Object.entries(configured.tools ?? {})
            .map(([tool, values]) => `${tool}: ${JSON.stringify(values)}`)
            .join("; ") || "None",
        ]),
      ),
    );
    inventory.append(
      element(
        "details",
        { className: "policy-rule-detail" },
        element("summary", {}, "Plugin policy configuration"),
        element("pre", { tabindex: "0" }, JSON.stringify(policy.plugins, null, 2)),
      ),
    );
  }
  inventory.append(checks(policy.unevaluatedChecks));
  return inventory;
}

function nativeInventory(policy) {
  const identity = policy.identity;
  const provenance = element("dl", { className: "credential-status-list" });
  for (const [label, value] of [
    ["Sandbox", policy.sandbox],
    ["Observed", displayDate(policy.observedAt)],
    ["Source", identity.source],
    ["Policy version", identity.version],
    ["Global policy version", identity.globalVersion],
    ["Policy hash", identity.policyHash],
    ["Admission", policy.admission.state],
    ["Configuration revision", identity.configRevision],
    ["Provider environment revision", identity.providerEnvRevision],
  ]) {
    provenance.append(element("dt", {}, label), element("dd", {}, visibleText(value ?? "unknown")));
  }
  const inventory = element(
    "section",
    { className: "policy-inventory", "aria-label": "Provider network policy" },
    element("h3", {}, "Sandbox provider snapshot"),
    provenance,
    element(
      "p",
      { className: "hint" },
      "This separately observed provider snapshot may differ from the intended policy and the policy that produced an earlier log.",
    ),
  );
  if (policy.admission.state !== "applied") {
    inventory.append(
      element(
        "p",
        { className: "notice" },
        `Provider admission is ${policy.admission.state}. This inventory does not establish that this policy is loaded in the running Sandbox.`,
      ),
    );
  }
  inventory.append(
    table(
      "Provider network rules",
      ["Rule", "Origin", "Executables", "Destinations"],
      policy.rules.map((rule) => [
        rule.name,
        rule.origin,
        rule.binaries.join(", ") || "No executable conditions reported",
        rule.destinations
          .map(
            (entry) =>
              `${entry.host}:${entry.ports.join(",")} · ${entry.protocol} · TLS ${entry.tls} · ${entry.enforcement}`,
          )
          .join("; ") || "Built-in decision",
      ]),
    ),
  );
  for (const rule of policy.rules) {
    inventory.append(
      element(
        "details",
        { className: "policy-rule-detail" },
        element("summary", {}, `${visibleText(rule.name)} configuration`),
        element(
          "pre",
          { tabindex: "0" },
          JSON.stringify(rule.configuration, null, 2).split("\n").map(visibleText).join("\n"),
        ),
      ),
    );
  }
  return inventory;
}

/** Simulates server-owned intended policy. Optional native evaluation is separate evidence. */
export function createPolicyTester(context, { base }) {
  const host = element("div", { className: "network-policy-host" });
  const openButton = button("Open policy tester", (event) => open(null, event.currentTarget), {
    className: "policy-open",
    hidden: true,
  });
  let dismissObserved;

  function open(record, trigger = openButton) {
    const requests = new AbortController();
    const dialog = element("dialog", {
      className: "network-policy-dialog",
      "aria-labelledby": "network-policy-title",
    });
    dismissOnBackdrop(dialog);
    let description = null;
    let provider = null;
    let loading = false;
    let nativeLoading = false;
    let running = null;
    const active = () => dialog.open && context.isCurrent() && !requests.signal.aborted;
    const snapshot = () =>
      kind.input.value === "network" ? description?.network : description?.plugins;
    const feedback = element("p", { className: "policy-feedback", role: "status" });
    const inventory = element("div");
    const result = element("section", {
      className: "policy-result",
      "aria-label": "Policy simulation result",
      "aria-live": "polite",
    });
    const kind = selection("Action type", "policy-kind", [
      ["network", "Network request"],
      ["plugin", "Plugin tool"],
    ]);
    const destination = field("Destination host", "policy-host", {
      required: true,
      maxlength: "253",
      pattern: "[^\\s/:?#]+",
      placeholder: "api.example.com",
    });
    const port = field("Port", "policy-port", {
      type: "number",
      required: true,
      min: "1",
      max: "65535",
      value: "443",
    });
    const binary = field(
      "Full executable path",
      "policy-binary",
      { required: true, pattern: "/.*", maxlength: "4096", placeholder: "/usr/bin/curl" },
      record?.fields?.binary
        ? `The log reports ${visibleText(record.fields.binary)}. Enter the full executable path; a logged name does not verify its path.`
        : "Enter the full executable path used by the hypothetical action.",
    );
    const sha = field("Executable SHA-256 (optional)", "policy-sha", {
      pattern: "[A-Fa-f0-9]{64}",
      maxlength: "64",
    });
    const ancestors = element("textarea", {
      id: "policy-ancestors",
      rows: "2",
      placeholder: "/usr/bin/python3",
    });
    const cmdline = element("textarea", {
      id: "policy-cmdline",
      rows: "2",
      placeholder: "/workspace/script.py",
    });
    const advanced = element(
      "details",
      { className: "policy-process-context" },
      element("summary", {}, "Additional process identity"),
      sha.node,
      element(
        "div",
        { className: "form-field" },
        element("label", { for: ancestors.id }, "Ancestor executable paths (one per line)"),
        ancestors,
      ),
      element(
        "div",
        { className: "form-field" },
        element("label", { for: cmdline.id }, "Command-line paths (one per line)"),
        cmdline,
      ),
    );
    const http = element("input", { id: "policy-http", type: "checkbox" });
    const method = field("HTTP method", "policy-method", {
      value: "GET",
      required: true,
      pattern: "[A-Z]+",
      maxlength: "16",
    });
    const path = field("HTTP path", "policy-path", {
      value: "/",
      required: true,
      pattern: "/.*",
      maxlength: "4096",
    });
    const query = field(
      "Query parameters (optional)",
      "policy-query",
      { placeholder: "state=open&label=bug" },
      "Use URL query syntax; repeated names retain every value.",
    );
    const httpFields = element(
      "div",
      { className: "policy-input-grid", hidden: true },
      method.node,
      path.node,
      query.node,
    );
    const networkFields = element(
      "div",
      {},
      element("div", { className: "policy-input-grid" }, destination.node, port.node, binary.node),
      advanced,
      element("label", { className: "log-option", for: http.id }, http, " Include an HTTP request"),
      httpFields,
    );
    const plugin = field("Plugin ID", "policy-plugin", {
      required: true,
      maxlength: "512",
      list: "policy-plugin-options",
      placeholder: "occ-plugin:diffs",
    });
    const tool = field("Tool ID", "policy-tool", {
      required: true,
      maxlength: "512",
      list: "policy-tool-options",
      placeholder: "diffs",
    });
    const pluginOptions = element("datalist", { id: "policy-plugin-options" });
    const toolOptions = element("datalist", { id: "policy-tool-options" });
    const readOnly = selection("Read-only classification", "policy-readonly", [
      ["", "Unknown"],
      ["true", "Read only"],
      ["false", "Writes data"],
    ]);
    const destructive = selection("Destructive classification", "policy-destructive", [
      ["", "Unknown"],
      ["false", "No"],
      ["true", "Yes"],
    ]);
    const pluginFields = element(
      "div",
      { hidden: true },
      element("div", { className: "policy-input-grid" }, plugin.node, tool.node),
      pluginOptions,
      toolOptions,
      element("div", { className: "policy-input-grid" }, readOnly.node, destructive.node),
      element(
        "p",
        { className: "hint" },
        "Classifications are hypothetical test inputs. Simulation does not verify the runtime's tool metadata, credentials, or an approver's decision.",
      ),
    );
    const simulate = element(
      "button",
      { type: "submit", className: "primary", disabled: true },
      "Simulate policy",
    );
    const reload = button("Reload snapshot", () => void load());
    const form = element(
      "form",
      { className: "policy-test-form" },
      element("h3", {}, "Action to test"),
      element(
        "p",
        { className: "hint" },
        "Test the intended policy without making a network request or invoking a plugin tool.",
      ),
      kind.node,
      networkFields,
      pluginFields,
      element("div", { className: "form-actions" }, simulate),
    );
    const nativeFeedback = element("p", { role: "status" });
    const nativePolicy = element("div");
    const nativeResult = element("section", {
      className: "policy-result",
      "aria-label": "Native policy evaluation result",
      "aria-live": "polite",
    });
    const inspectNative = button("Inspect Sandbox provider", () => void loadNative());
    const evaluateNative = button("Evaluate with Sandbox provider", () => void evaluate("native"), {
      disabled: true,
    });
    const nativePanel = element(
      "details",
      { className: "policy-native" },
      element("summary", {}, "Optional native network evaluation"),
      element(
        "p",
        { className: "hint" },
        "Read and evaluate the Sandbox provider's current snapshot separately from OCE simulation. This does not send the action or prove connectivity.",
      ),
      element("div", { className: "form-actions" }, inspectNative, evaluateNative),
      nativeFeedback,
      nativePolicy,
      nativeResult,
    );

    function updateControls() {
      const network = kind.input.value === "network";
      const busy = running !== null;
      simulate.disabled = !snapshot() || loading || busy;
      reload.disabled = loading || busy || nativeLoading;
      for (const input of form.querySelectorAll("input, textarea, select")) {
        input.disabled = busy;
      }
      for (const input of networkFields.querySelectorAll("input, textarea")) {
        input.disabled = busy || !network;
      }
      for (const input of pluginFields.querySelectorAll("input, select")) {
        input.disabled = busy || network;
      }
      for (const input of httpFields.querySelectorAll("input")) {
        input.disabled = busy || !network || !http.checked;
      }
      networkFields.hidden = !network;
      pluginFields.hidden = network;
      httpFields.hidden = !http.checked;
      nativePanel.hidden = !network;
      inspectNative.disabled = nativeLoading || busy || loading;
      evaluateNative.disabled = !provider || nativeLoading || busy || loading;
    }

    function renderIntended() {
      const current = snapshot();
      inventory.replaceChildren(
        current
          ? intendedInventory(current)
          : element(
              "p",
              { className: "notice" },
              description?.unsupported.find((entry) => entry.kind === kind.input.value)?.reason ??
                "No simulation policy was reported for this action type.",
            ),
      );
      pluginOptions.replaceChildren(
        ...Object.keys(description?.plugins?.policy.plugins ?? {}).map((id) =>
          element("option", { value: id }),
        ),
      );
      updateToolOptions();
      updateControls();
    }

    function updateToolOptions() {
      toolOptions.replaceChildren(
        ...(description?.plugins?.policy.toolIds[plugin.input.value] ?? []).map((id) =>
          element("option", { value: id }),
        ),
      );
    }

    async function load() {
      if (!active() || loading || running || nativeLoading) {
        return;
      }
      loading = true;
      description = null;
      provider = null;
      result.replaceChildren();
      nativePolicy.replaceChildren();
      nativeResult.replaceChildren();
      nativeFeedback.textContent = "";
      inventory.replaceChildren();
      feedback.textContent = "Loading intended policy…";
      updateControls();
      try {
        const value = await context.request(`${base}/policy-simulation`, {
          signal: requests.signal,
          revalidate: false,
        });
        if (!active()) {
          return;
        }
        description = value;
        if (!record && !snapshot()) {
          kind.input.value = value.plugins ? "plugin" : "network";
        }
        renderIntended();
        feedback.textContent = "OCE intended policy loaded. Enter an action to simulate.";
      } catch (error) {
        if (active()) {
          feedback.textContent = errorText(error, "Policy simulation");
        }
      } finally {
        loading = false;
        updateControls();
      }
    }

    async function loadNative() {
      if (!active() || nativeLoading || running || loading) {
        return;
      }
      nativeLoading = true;
      provider = null;
      nativePolicy.replaceChildren();
      nativeResult.replaceChildren();
      nativeFeedback.textContent = "Loading Sandbox provider policy…";
      updateControls();
      try {
        const value = await context.request(`${base}/network-policy`, {
          signal: requests.signal,
          revalidate: false,
        });
        if (!active()) {
          return;
        }
        provider = value;
        nativePolicy.replaceChildren(nativeInventory(value));
        nativeFeedback.textContent =
          "Provider snapshot loaded. Native evaluation uses the network action above.";
      } catch (error) {
        if (active()) {
          nativeFeedback.textContent = errorText(error, "Native policy inspection");
        }
      } finally {
        nativeLoading = false;
        updateControls();
      }
    }

    function networkInput() {
      const paths = (input) =>
        input.value
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean);
      const body = {
        host: destination.input.value.trim(),
        port: Number(port.input.value),
        binaryPath: binary.input.value.trim(),
        ...(sha.input.value ? { binarySha256: sha.input.value.toLowerCase() } : {}),
        ...(paths(ancestors).length ? { ancestors: paths(ancestors) } : {}),
        ...(paths(cmdline).length ? { cmdlinePaths: paths(cmdline) } : {}),
      };
      if (http.checked) {
        const parameters = {};
        for (const [key, value] of new URLSearchParams(query.input.value)) {
          if (!Object.hasOwn(parameters, key)) {
            Object.defineProperty(parameters, key, { value: [], enumerable: true });
          }
          parameters[key].push(value);
        }
        body.http = {
          method: method.input.value,
          path: path.input.value,
          ...(query.input.value ? { query: parameters } : {}),
        };
      }
      return body;
    }

    async function evaluate(operation) {
      const current = snapshot();
      if (
        !active() ||
        loading ||
        running ||
        nativeLoading ||
        (operation === "simulation" ? !current : !provider) ||
        !form.reportValidity()
      ) {
        return;
      }
      const network = kind.input.value === "network";
      const body =
        operation === "native"
          ? { ...networkInput(), expectedPolicyHash: provider.identity.policyHash }
          : {
              kind: kind.input.value,
              expectedSimulationHash: current.simulationHash,
              ...(network
                ? networkInput()
                : {
                    pluginId: plugin.input.value.trim(),
                    toolId: tool.input.value.trim(),
                    ...(readOnly.input.value ? { readOnly: readOnly.input.value === "true" } : {}),
                    ...(destructive.input.value
                      ? { destructive: destructive.input.value === "true" }
                      : {}),
                  }),
            };
      running = operation;
      const output = operation === "native" ? nativeResult : result;
      const status = operation === "native" ? nativeFeedback : feedback;
      output.replaceChildren();
      status.textContent =
        operation === "native" ? "Evaluating with Sandbox provider…" : "Simulating policy…";
      updateControls();
      try {
        const value = await context.request(
          `${base}/${operation === "native" ? "network-policy/evaluate" : "policy-simulation"}`,
          { method: "POST", body, signal: requests.signal, revalidate: false },
        );
        if (!active()) {
          return;
        }
        output.replaceChildren(
          element(
            "h3",
            {},
            `${operation === "native" ? "Native evaluator" : "Simulated"} decision: ${visibleText(value.decision)}`,
          ),
          element("p", {}, visibleText(value.reason)),
        );
        if (operation === "simulation") {
          output.append(
            element(
              "p",
              { className: "hint policy-hash" },
              `Simulated snapshot: ${visibleText(value.simulationHash)}`,
            ),
            table(
              "Simulation rule results",
              ["Rule", "Matched", "Decision", "Reason"],
              value.rules.map((rule) => [
                rule.name,
                rule.matched ? "Yes" : "No",
                rule.decision,
                rule.reason,
              ]),
            ),
          );
        } else {
          output.append(
            element(
              "p",
              { className: value.applied ? "hint" : "notice" },
              value.applied
                ? "This provider snapshot was reported as applied."
                : "This result evaluates current provider configuration; it does not establish the applied Sandbox policy.",
            ),
            element(
              "p",
              { className: "hint policy-hash" },
              `Evaluated policy hash: ${visibleText(value.policyHash)}`,
            ),
            table(
              "Native evaluation stages",
              ["Stage", "Decision", "Reason"],
              value.stages.map((stage) => [stage.id, stage.decision, stage.reason]),
            ),
            table(
              "Native rule results",
              ["Rule", "Matched", "Reason"],
              value.rules.map((rule) => [
                provider.rules.find((entry) => entry.id === rule.id)?.name ?? rule.id,
                rule.matched ? "Yes" : "No",
                rule.reason,
              ]),
            ),
          );
        }
        output.append(checks(value.unevaluatedChecks));
        status.textContent =
          operation === "native"
            ? "Native evaluation complete. No network request was made."
            : "Simulation complete. No network request or plugin invocation was made.";
      } catch (error) {
        if (active()) {
          status.textContent = errorText(
            error,
            operation === "native" ? "Native policy evaluation" : "Policy simulation",
          );
        }
      } finally {
        running = null;
        updateControls();
      }
    }

    form.addEventListener("input", () => {
      if (description && !loading) {
        feedback.textContent = snapshot()
          ? "Inputs changed. Simulate again."
          : "This action type cannot be simulated.";
      }
      result.replaceChildren();
      nativeResult.replaceChildren();
      updateToolOptions();
      updateControls();
    });
    kind.input.addEventListener("change", () => {
      if (description && !loading) {
        feedback.textContent = snapshot()
          ? "Inputs changed. Simulate again."
          : "This action type cannot be simulated.";
      }
      result.replaceChildren();
      nativeResult.replaceChildren();
      if (description) {
        renderIntended();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void evaluate("simulation");
    });

    if (record) {
      const fields = record.fields ?? {};
      destination.input.value = String(fields.dst_host ?? "");
      port.input.value = String(fields.dst_port ?? "443");
      if (fields.url) {
        try {
          const url = new URL(fields.url);
          destination.input.value = url.hostname;
          port.input.value = url.port || (url.protocol === "http:" ? "80" : "443");
          if (!fields.url.includes("[redacted") && !record.truncated) {
            path.input.value = url.pathname;
            query.input.value = url.search.slice(1);
          }
        } catch {
          /* Sanitized or incomplete URL components remain editable. */
        }
      }
      http.checked = fields.method !== undefined;
      method.input.value = String(fields.method ?? "GET");
    }
    dialog.append(
      ...[
        element(
          "div",
          { className: "plugin-dialog-header" },
          element("h2", { id: "network-policy-title" }, "Policy inspector and tester"),
          button("Close", () => dialog.close()),
        ),
        record
          ? element(
              "section",
              { className: "policy-observed" },
              element("h3", {}, "Observed log decision"),
              element("p", {}, visibleText(record.message)),
              element(
                "p",
                { className: "hint" },
                `Rule ${visibleText(record.fields?.rule_name ?? "unknown")} · engine ${visibleText(record.fields?.rule_type ?? "unknown")} · generation ${visibleText(record.fields?.policy_generation ?? "unknown")}`,
              ),
              element(
                "p",
                { className: "hint" },
                "Inputs are recovered from sanitized logs and may be incomplete. Review the destination, request and process identity before testing.",
              ),
            )
          : null,
        element("div", { className: "policy-status-bar" }, feedback, reload),
        form,
        inventory,
        result,
        nativePanel,
      ].filter((node) => node !== null),
    );
    function dismiss() {
      dialog.removeEventListener("close", dismiss);
      if (dismissObserved === dismiss) {
        dismissObserved = undefined;
      }
      requests.abort();
      // A log refusal dismisses synchronously; ordinary dismissal arrives here after close.
      if (dialog.open) {
        dialog.close();
      }
      dialog.remove();
      if (trigger.isConnected) {
        trigger.focus();
      } else if (openButton.isConnected) {
        openButton.focus();
      }
    }
    if (record) {
      dismissObserved = dismiss;
    }
    dialog.addEventListener("close", dismiss);
    host.append(dialog);
    dialog.showModal();
    updateControls();
    kind.input.focus();
    void load();
  }
  return { host, openButton, open, dismissObservedLog: () => dismissObserved?.() };
}

export function renderAgentPolicyTester(context, { agent, revisionId }) {
  const base = `${namespacePath(context.namespaceId)}/agents/${encodeURIComponent(agent.id)}/deployments/${encodeURIComponent(revisionId)}/runtime`;
  const tester = createPolicyTester(context, { base });
  tester.openButton.hidden = false;
  return element(
    "section",
    { className: "agent-card" },
    element("h2", {}, "Policy tester"),
    element(
      "p",
      {},
      "Inspect current Sandbox Driver network rules and this version’s saved plugin policies, then simulate an action and see each rule’s result.",
    ),
    element(
      "p",
      { className: "hint" },
      "Log access and a running Sandbox are not required for plugin simulation. Tests do not execute the entered action.",
    ),
    tester.openButton,
    tester.host,
  );
}
