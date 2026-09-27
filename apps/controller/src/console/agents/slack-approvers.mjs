import { button, element } from "../dom.mjs";
import { createSlackDirectoryPicker, createSlackNameResolver } from "./slack-directory.mjs";

const SLACK_PRINCIPAL = /^team:(T[A-Z0-9]{1,31}):user:([UW][A-Z0-9]{1,31})$/;

function isSlackPrincipal(value) {
  return SLACK_PRINCIPAL.test(value);
}

export function createSlackApproverField({
  context,
  label,
  getSecretId,
  agentId,
  getValue,
  onChange,
  inheritedLabel = "Inherit Agent default",
  allowInherit = true,
  lazyNames = false,
}) {
  const value = getValue();
  const select = element(
    "select",
    { "aria-label": `${label} mode` },
    ...(allowInherit ? [element("option", { value: "inherit" }, inheritedLabel)] : []),
    element("option", { value: "none" }, "No Slack approvers"),
    element("option", { value: "chosen" }, "Selected Slack users"),
  );
  select.value =
    value === undefined
      ? "inherit"
      : value.some((entry) => entry.channel === "slack")
        ? "chosen"
        : "none";
  const ids = element("div", { className: "slack-approver-ids" });
  const helper = element("p", { className: "hint" });
  const nameStatus = element("p", { className: "hint", role: "status" });
  const manual = element("input", {
    type: "text",
    "aria-label": `${label} exact Slack selector`,
    placeholder: "team:T…:user:U…",
    autocomplete: "off",
  });
  const manualError = element("p", { className: "error", role: "alert" });
  let selectedWorkspaceId = null;
  let selectedWorkspaceSecretId = null;
  let namesActive = !lazyNames;
  let nameState = { names: new Map() };
  const nameResolver = createSlackNameResolver({
    context,
    kind: "users",
    getSecretId,
    agentId,
    onUpdate: (state) => {
      nameState = state;
      if (selectedWorkspaceSecretId !== getSecretId()) {
        selectedWorkspaceId = null;
        selectedWorkspaceSecretId = null;
      }
      if (state.workspaceId) {
        selectedWorkspaceId = state.workspaceId;
        selectedWorkspaceSecretId = getSecretId();
      }
      renderIds();
    },
  });
  const picker = createSlackDirectoryPicker({
    context,
    kind: "users",
    getSecretId,
    agentId,
    label: `Find approver for ${label}`,
    saveDescription: "A workspace-qualified Slack user selector is saved.",
    onWorkspace: (workspaceId, secretId) => {
      selectedWorkspaceId = workspaceId;
      selectedWorkspaceSecretId = secretId;
    },
    onSelect: (candidate) => {
      const id = `team:${candidate.workspaceId}:user:${candidate.id}`;
      if (!isSlackPrincipal(id)) {
        return;
      }
      const current = getValue() ?? [];
      if (!current.some((entry) => entry.channel === "slack" && entry.id === id)) {
        commit([...current, { channel: "slack", id }]);
      }
    },
  });
  function commit(value) {
    onChange(value);
    refresh();
  }
  const addManual = button("Add exact selector", () => {
    const id = manual.value.trim();
    if (!isSlackPrincipal(id)) {
      manualError.textContent = "Enter a full Slack selector such as team:T123:user:U456.";
      return;
    }
    const teamId = id.slice("team:".length, id.indexOf(":user:"));
    if (
      selectedWorkspaceId &&
      selectedWorkspaceSecretId === getSecretId() &&
      teamId !== selectedWorkspaceId
    ) {
      manualError.textContent = `This bot belongs to workspace ${selectedWorkspaceId}. Enter a user in that workspace.`;
      return;
    }
    const current = getValue() ?? [];
    if (!current.some((entry) => entry.channel === "slack" && entry.id === id)) {
      commit([...current, { channel: "slack", id }]);
    }
    manual.value = "";
    manualError.textContent = "";
  });
  manual.addEventListener("input", () => {
    manualError.textContent = "";
  });
  const manualField = element(
    "div",
    { className: "slack-approver-manual" },
    element("label", {}, "Exact workspace-qualified user ID", manual),
    addManual,
    manualError,
  );
  select.addEventListener("change", () => {
    if (select.value === "inherit") {
      commit(undefined);
    } else if (select.value === "none") {
      commit((getValue() ?? []).filter((entry) => entry.channel !== "slack"));
    } else if (getValue() === undefined) {
      commit([]);
    }
  });

  function renderIds() {
    const current = getValue();
    const slack = current?.filter((entry) => entry.channel === "slack") ?? [];
    ids.replaceChildren(
      ...(current ?? []).map((entry) => {
        const match = entry.channel === "slack" ? SLACK_PRINCIPAL.exec(entry.id) : null;
        const candidate =
          match?.[1] === nameState.workspaceId ? nameState.names.get(match[2]) : null;
        return element(
          "span",
          { className: "slack-approver-id" },
          candidate ? element("strong", {}, candidate.displayName || candidate.name) : null,
          element("code", {}, entry.id),
          button(`Remove ${entry.id}`, () => commit(current.filter((item) => item !== entry)), {
            "aria-label": `Remove ${entry.id}`,
          }),
        );
      }),
    );
    const mismatched = slack.some((entry) => {
      const match = SLACK_PRINCIPAL.exec(entry.id);
      return match && nameState.workspaceId && match[1] !== nameState.workspaceId;
    });
    nameStatus.textContent = nameState.error
      ? `${nameState.error} Saved IDs remain available.`
      : nameState.loading
        ? "Resolving saved Slack user names…"
        : mismatched
          ? `Bot workspace: ${nameState.workspaceName ? `${nameState.workspaceName} · ` : ""}${nameState.workspaceId}. Some saved approvers belong to another workspace.`
          : nameState.workspaceId
            ? `Bot workspace: ${nameState.workspaceName ? `${nameState.workspaceName} · ` : ""}${nameState.workspaceId}. Names are shown for this workspace only.`
            : slack.length && !getSecretId()
              ? "Select a Slack bot token Secret under Channels to show approver names."
              : "";
    if (nameState.truncated) {
      nameStatus.textContent += " Only the first 20 IDs are resolved; all IDs remain visible.";
    }
  }

  function refresh() {
    const current = getValue();
    const slack = current?.filter((entry) => entry.channel === "slack") ?? [];
    const otherCount = (current?.length ?? 0) - slack.length;
    select.value = current === undefined ? "inherit" : slack.length ? "chosen" : "none";
    helper.textContent =
      current === undefined
        ? `${inheritedLabel}. No approver list is set at this level.`
        : current.length === 0
          ? "Explicit empty list: no Slack user can approve at this level."
          : `${slack.length} Slack approver${slack.length === 1 ? "" : "s"} selected.${otherCount ? ` ${otherCount} other channel entr${otherCount === 1 ? "y is" : "ies are"} preserved.` : ""} Only workspace-qualified Slack user IDs are saved.`;
    picker.hidden = current === undefined;
    manualField.hidden = current === undefined;
    if (namesActive) {
      void nameResolver.refresh(
        slack.map((entry) => SLACK_PRINCIPAL.exec(entry.id)?.[2]).filter(Boolean),
      );
    } else {
      nameResolver.invalidate();
    }
  }
  refresh();
  const field = element(
    "div",
    { className: "slack-approver-field" },
    element("label", {}, label, select),
    helper,
    ids,
    nameStatus,
    picker,
    manualField,
  );
  field.refreshValue = refresh;
  field.refreshNames = () => {
    namesActive = true;
    refresh();
  };
  field.pauseNames = () => {
    namesActive = false;
    nameResolver.invalidate();
  };
  return field;
}
