import { element } from "../dom.mjs";
import { createSlackDirectoryField } from "./slack-directory.mjs";

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
  const select = element(
    "select",
    { "aria-label": `${label} mode` },
    ...(allowInherit ? [element("option", { value: "inherit" }, inheritedLabel)] : []),
    element("option", { value: "none" }, "No Slack approvers"),
    element("option", { value: "chosen" }, "Selected Slack users"),
  );
  const helper = element("p", { className: "hint" });
  const control = element("input", {
    id: `slack-approvers-${crypto.randomUUID()}`,
    type: "hidden",
  });
  const picker = createSlackDirectoryField({
    context,
    kind: "users",
    control,
    label: `${label} people`,
    getSecretId,
    agentId,
    qualifyUsers: true,
    lazyNames,
  });
  control.addEventListener("input", () => {
    const other = (getValue() ?? []).filter((entry) => entry.channel !== "slack");
    const slack = control.value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ channel: "slack", id }));
    onChange([...other, ...slack]);
    render();
  });
  select.addEventListener("change", () => {
    if (select.value === "inherit") {
      onChange(undefined);
    } else if (select.value === "none") {
      onChange((getValue() ?? []).filter((entry) => entry.channel !== "slack"));
    }
    render();
    picker.refreshValue();
  });
  function render() {
    const current = getValue();
    const slack = current?.filter((entry) => entry.channel === "slack") ?? [];
    const otherCount = (current?.length ?? 0) - slack.length;
    control.value = slack.map((entry) => entry.id).join(", ");
    helper.textContent =
      current === undefined
        ? select.value === "chosen"
          ? "Select people to replace the inherited approvers."
          : `${inheritedLabel}. No approver list is set at this level.`
        : current.length === 0
          ? "No Slack user can approve until people are selected."
          : `${slack.length} Slack approver${slack.length === 1 ? "" : "s"} selected.${otherCount ? ` ${otherCount} other channel entries are preserved.` : ""}`;
    picker.hidden = select.value !== "chosen";
  }
  function refresh() {
    const current = getValue();
    select.value =
      current === undefined
        ? "inherit"
        : current.some((entry) => entry.channel === "slack") || select.value === "chosen"
          ? "chosen"
          : "none";
    render();
    picker.refreshValue();
  }
  const field = element(
    "div",
    { className: "slack-approver-field" },
    element("label", {}, label, select),
    helper,
    picker,
  );
  field.refreshValue = refresh;
  field.refreshNames = () => {
    render();
    picker.refreshNames();
  };
  field.pauseNames = () => picker.pauseNames();
  refresh();
  return field;
}
