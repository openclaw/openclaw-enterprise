import type {
  InstallationSandboxNetworkPolicyCeiling,
  JSONSchema,
  SandboxNetworkGrant,
} from "@openclaw-enterprise/contracts";
import type { ConsolePageContext } from "./page-context.mjs";
import {
  INSTALLATION_ADMINISTRATION,
  refusedAsNonAdministrator,
  requestErrorDetails,
  requestFailure,
  responseFields,
} from "./api-client.mjs";
import { configurationErrors, configurationFields } from "./configuration-fields.mjs";
import { button, element, statusBlock } from "./dom.mjs";
import { sameValue } from "./carry.mjs";
import { ruleList } from "./agents/sandbox-policy.mjs";
import networkRulesSchema from "./network-policy-definition.mjs";

const ruleSchema = responseFields(networkRulesSchema).items as JSONSchema;
const maximumRules = networkRulesSchema.maxItems as number;

const PATH = "/installation/sandbox-network-policy-ceiling";
type Context = Pick<ConsolePageContext, "request" | "isCurrent" | "onAdministrationEnded">;
type Details = ReturnType<typeof requestErrorDetails>;

function savedCeiling(value: unknown): InstallationSandboxNetworkPolicyCeiling {
  const record = responseFields(value);
  if (
    typeof record.installationId !== "string" ||
    !record.installationId ||
    !Number.isInteger(record.version) ||
    Number(record.version) < 1 ||
    (record.managementMode !== "console" && record.managementMode !== "startup") ||
    typeof record.updatedAt !== "string" ||
    typeof record.updatedBy !== "string" ||
    !Array.isArray(record.rules)
  ) {
    throw new Error("The saved ceiling response is incomplete.");
  }
  return value as InstallationSandboxNetworkPolicyCeiling;
}

/** Installation administration owns this editor; Agent policy admission remains independent. */
export function renderNetworkPolicyCeiling(context: Context) {
  const section = element("section", {
    className: "card network-policy-ceiling",
    id: "network-policy-ceiling",
  });
  const feedback = element("div", { "aria-live": "polite" });
  const content = element("div");
  section.append(
    element("h2", {}, "Network policy ceiling"),
    element(
      "p",
      {},
      "Set the maximum additional network access that Agents can request. The ceiling grants no access by itself. Changes leave running access unchanged.",
    ),
    feedback,
    content,
  );
  let saved: InstallationSandboxNetworkPolicyCeiling | undefined;
  let draft: unknown[] = [];
  let authorized = true;
  let busy = false;
  let writing = false;
  let reviewed = false;
  let editorIndex: number | undefined;
  let details: Details = [];
  let conflict = false;
  let uncertain: { expectedVersion: number; rules: SandboxNetworkGrant[] } | undefined;
  let recovered: InstallationSandboxNetworkPolicyCeiling | undefined;
  let readGeneration = 0;
  const current = () => context.isCurrent();
  const editable = () =>
    authorized && !busy && saved?.managementMode === "console" && !uncertain && !conflict;
  const dirty = () => saved !== undefined && !sameValue(saved.rules, draft);

  function focusResult() {
    const target =
      feedback.querySelector<HTMLElement>(".status") ??
      content.querySelector<HTMLElement>(".ceiling-review");
    if (target) {
      target.tabIndex = -1;
      target.focus();
    }
  }
  function notice(tone: "info" | "success" | "warning" | "danger", title: string, text: string) {
    feedback.replaceChildren(statusBlock(tone, title, text));
  }
  function loseAccess(ended = false) {
    authorized = false;
    reviewed = false;
    if (ended && !dirty()) {
      section.remove();
      return;
    }
    notice(
      "warning",
      "Installation administration required",
      "Your draft is retained while this page is open. Ask an Installation administrator to restore access, then refresh Settings.",
    );
    render();
  }
  context.onAdministrationEnded?.(() => {
    if (current()) {
      loseAccess(true);
    }
  });

  function resetReview() {
    reviewed = false;
    details = [];
    recovered = undefined;
    feedback.replaceChildren();
  }
  async function review() {
    if (!editable() || !dirty() || !saved) {
      return;
    }
    busy = true;
    editorIndex = undefined;
    render();
    try {
      const result = responseFields(
        await context.request(`${PATH}/validate`, {
          method: "POST",
          ...INSTALLATION_ADMINISTRATION,
          body: { expectedVersion: saved.version, rules: draft },
        }),
      );
      if (!current() || !authorized) {
        return;
      }
      if (result.success === false) {
        details = requestErrorDetails(responseFields(result.error));
        if (!details.length) {
          throw new Error("Incomplete validation response.");
        }
        notice(
          "danger",
          "Check the network rules",
          "Correct the reported fields, then review again. Your draft is retained.",
        );
      } else if (result.success === true && sameValue(responseFields(result.data).rules, draft)) {
        reviewed = true;
        details = [];
        feedback.replaceChildren();
      } else {
        throw new Error("The preview did not confirm these rules.");
      }
    } catch (cause) {
      if (!current()) {
        return;
      }
      const { status } = requestFailure(cause);
      if (status === 403) {
        loseAccess(refusedAsNonAdministrator(cause));
      } else if (status === 409) {
        conflict = true;
        notice(
          "warning",
          "The saved ceiling changed",
          "Your draft is retained. Load the current saved rules and review your draft against them before saving.",
        );
      } else {
        notice(
          "danger",
          "Could not review the ceiling",
          "No save was sent. Try the review again. Your draft is retained.",
        );
      }
    } finally {
      if (current()) {
        busy = false;
        render();
        focusResult();
      }
    }
  }

  async function load(kind: "initial" | "reload" | "recover" = "initial") {
    if (busy || !authorized) {
      return;
    }
    const generation = ++readGeneration;
    busy = true;
    render();
    try {
      const next = savedCeiling(
        await context.request(PATH, { ...INSTALLATION_ADMINISTRATION, revalidate: true }),
      );
      if (!current() || generation !== readGeneration || !authorized) {
        return;
      }
      if (saved && saved.installationId !== next.installationId) {
        throw new Error("The response names another Installation.");
      }
      if (saved && next.version < saved.version) {
        throw new Error("The response names an older saved version.");
      }
      if (kind === "recover" && uncertain) {
        const attempt = uncertain;
        uncertain = undefined;
        if (next.version === attempt.expectedVersion + 1 && sameValue(next.rules, attempt.rules)) {
          saved = next;
          draft = structuredClone([...next.rules]);
          reviewed = false;
          conflict = false;
          notice(
            "success",
            "Saved ceiling matches the proposal",
            `Saved version ${next.version} matches your reviewed rules. Running access is unchanged.`,
          );
        } else {
          recovered = next;
          conflict = true;
          reviewed = false;
          notice(
            "warning",
            "Saved ceiling inspected",
            "The current ceiling does not confirm the attempted save. Your draft is retained. Review it against the current saved rules before an explicit retry.",
          );
        }
      } else if (kind === "reload") {
        saved = next;
        conflict = false;
        recovered = undefined;
        reviewed = false;
        details = [];
        notice(
          "info",
          "Current ceiling loaded",
          `Version ${next.version} is now the review baseline. Your draft is retained; review it before saving.`,
        );
      } else {
        saved = next;
        draft = structuredClone([...next.rules]);
        feedback.replaceChildren();
      }
    } catch (cause) {
      if (!current() || generation !== readGeneration) {
        return;
      }
      if (requestFailure(cause).status === 403) {
        loseAccess(refusedAsNonAdministrator(cause));
      } else {
        notice(
          "danger",
          kind === "recover"
            ? "Could not inspect the saved ceiling"
            : "Could not load the network policy ceiling",
          "Check your connection and try the read again. Your draft is retained.",
        );
      }
    } finally {
      if (current() && generation === readGeneration) {
        busy = false;
        render();
        if (kind !== "initial") {
          focusResult();
        }
      }
    }
  }

  async function save() {
    if (!editable() || !reviewed || !saved) {
      return;
    }
    const attempt = {
      expectedVersion: saved.version,
      rules: structuredClone(draft) as SandboxNetworkGrant[],
    };
    busy = true;
    writing = true;
    render();
    try {
      const next = savedCeiling(
        await context.request(PATH, {
          method: "PUT",
          ...INSTALLATION_ADMINISTRATION,
          body: attempt,
        }),
      );
      if (!current() || !authorized) {
        return;
      }
      if (
        next.installationId !== saved.installationId ||
        next.version !== attempt.expectedVersion + 1 ||
        next.managementMode !== "console" ||
        !sameValue(next.rules, attempt.rules)
      ) {
        throw new Error("The response did not confirm the reviewed ceiling.");
      }
      saved = next;
      draft = structuredClone([...next.rules]);
      reviewed = false;
      editorIndex = undefined;
      notice(
        "success",
        "Network policy ceiling saved",
        `Saved version ${next.version}. Running access is unchanged.`,
      );
    } catch (cause) {
      if (!current()) {
        return;
      }
      const { status } = requestFailure(cause);
      reviewed = false;
      if (status === 403) {
        loseAccess(refusedAsNonAdministrator(cause));
      } else if (status === 409) {
        conflict = true;
        notice(
          "warning",
          "The saved ceiling changed",
          "Your draft is retained. Load the current saved rules and review your draft against them before saving.",
        );
      } else if (status === 400 || status === 422) {
        details = requestErrorDetails(cause);
        notice(
          "danger",
          "The ceiling was not saved",
          "Correct the reported fields, then review again. Your draft is retained.",
        );
      } else {
        // The response may be lost after commit. A read, followed by explicit review, is the
        // only recovery path; repeating this PUT could overwrite another administrator's work.
        uncertain = attempt;
        notice(
          "warning",
          "Save outcome unknown",
          "The controller may have saved your changes. Inspect the saved ceiling before another save. Your draft is retained; no write is repeated automatically.",
        );
      }
    } finally {
      writing = false;
      if (current()) {
        busy = false;
        render();
        focusResult();
      }
    }
  }

  function render() {
    content.replaceChildren();
    section.setAttribute("aria-busy", String(busy));
    if (!saved) {
      content.append(
        element(
          "p",
          { role: "status" },
          busy ? "Loading network policy ceiling…" : "No saved ceiling is available.",
        ),
      );
      if (!busy && authorized) {
        content.append(button("Retry ceiling read", () => void load()));
      }
      return;
    }
    content.append(
      element(
        "p",
        { className: "hint ceiling-version" },
        `Saved version ${saved.version} · Updated ${saved.updatedAt} · By ${saved.updatedBy}`,
      ),
    );
    if (saved.managementMode === "startup") {
      content.append(
        statusBlock(
          "info",
          "Managed by startup configuration",
          "This ceiling is read-only. Ask the operator to change the startup configuration or restore Console management.",
        ),
        ruleList(saved.rules),
      );
      if (dirty()) {
        content.append(
          element("details", {}, element("summary", {}, "Retained draft"), ruleList(draft)),
        );
      }
      return;
    }
    if (!authorized) {
      content.append(element("h3", {}, "Retained draft"), ruleList(draft));
      return;
    }
    if (uncertain) {
      content.append(
        element("h3", {}, "Retained draft"),
        ruleList(draft),
        button("Inspect saved ceiling", () => void load("recover"), { disabled: busy }),
      );
      return;
    }
    if (conflict) {
      content.append(element("h3", {}, "Retained draft"), ruleList(draft));
      if (recovered) {
        content.append(
          element("h3", {}, `Current saved rules · Version ${recovered.version}`),
          ruleList(recovered.rules),
        );
        if (authorized) {
          content.append(
            button("Use current version for review", () => {
              if (!recovered || busy) {
                return;
              }
              saved = recovered;
              recovered = undefined;
              conflict = false;
              reviewed = false;
              notice(
                "info",
                "Review your retained draft",
                "The current saved rules are now the baseline. Review changes before an explicit save.",
              );
              render();
            }),
          );
        }
      } else if (authorized) {
        content.append(
          button("Load current ceiling", () => void load("reload"), { disabled: busy }),
        );
      }
      return;
    }
    if (reviewed) {
      const removed = saved.rules.filter(
        (rule) => !draft.some((candidate) => sameValue(rule, candidate)),
      );
      const baseline = saved.rules;
      const added = draft.filter(
        (rule) => !baseline.some((candidate) => sameValue(rule, candidate)),
      );
      const panel = element(
        "div",
        { className: "ceiling-review", tabIndex: -1 },
        element("h3", {}, "Review changes"),
      );
      if (removed.length) {
        panel.append(
          statusBlock(
            "warning",
            draft.length === 0
              ? "Clear the network policy ceiling"
              : "Ceiling access may be reduced",
            "Future policy saves, deployments, and pending applications must meet the new ceiling. Running access is unchanged.",
          ),
        );
      }
      panel.append(
        element("h4", {}, `Rules to add or change · ${added.length}`),
        added.length ? ruleList(added) : element("p", { className: "hint" }, "None."),
        element("h4", {}, `Rules to remove or replace · ${removed.length}`),
        removed.length ? ruleList(removed) : element("p", { className: "hint" }, "None."),
        element(
          "details",
          {},
          element("summary", {}, `Current saved rules · Version ${saved.version}`),
          ruleList(saved.rules),
        ),
        element(
          "div",
          { className: "ceiling-actions" },
          button(
            "Back to editing",
            () => {
              reviewed = false;
              render();
            },
            { disabled: busy },
          ),
          button("Save ceiling", () => void save(), { tone: "primary", disabled: busy }),
        ),
      );
      content.append(panel);
      return;
    }
    const controls = element("div", { className: "ceiling-actions" });
    const reviewButton = button("Review changes", () => void review(), {
      tone: "primary",
      disabled: busy || !dirty(),
    });
    const draftStatus = element("span", { className: "hint", role: "status" });
    const updateDirty = () => {
      const unsaved = dirty();
      reviewButton.disabled = busy || !unsaved;
      draftStatus.textContent = unsaved ? "Unsaved changes" : "No unsaved changes";
    };
    updateDirty();
    if (editorIndex !== undefined) {
      const index = editorIndex;
      const fields = configurationFields(
        ruleSchema,
        draft[index],
        (candidate) => {
          draft[index] = candidate;
          resetReview();
          updateDirty();
        },
        {
          disabled: busy,
          details: details
            .filter((detail) => detail.path.startsWith(`/rules/${index}/`))
            .map((detail) => ({
              ...detail,
              path: detail.path.slice(`/rules/${index}`.length),
            })),
        },
      );
      content.append(
        fields,
        button(
          "Back to rules",
          () => {
            editorIndex = undefined;
            render();
          },
          { disabled: busy },
        ),
      );
      queueMicrotask(() => {
        if (current() && index < draft.length) {
          fields.querySelector<HTMLElement>('[data-configuration-path="/binary"] input')?.focus();
        }
      });
    } else {
      content.append(
        element("h3", {}, `Ceiling rules · ${draft.length}`),
        ...(draft.length
          ? []
          : [
              element(
                "p",
                { className: "notice" },
                "No additional network access is delegated. Installation defaults still apply.",
              ),
            ]),
        ruleList(draft, (index) =>
          element(
            "div",
            { className: "ceiling-rule-actions" },
            button(
              "Edit rule",
              () => {
                editorIndex = index;
                resetReview();
                render();
              },
              { size: "sm", disabled: busy },
            ),
            button(
              "Remove rule",
              () => {
                if (!editable()) {
                  return;
                }
                draft.splice(index, 1);
                resetReview();
                render();
              },
              { size: "sm", disabled: busy },
            ),
          ),
        ),
        button(
          "Add rule",
          () => {
            if (!editable() || draft.length >= maximumRules) {
              return;
            }
            draft.push({
              id: `network-${crypto.randomUUID()}`,
              binary: "",
              host: "",
              ports: [{ from: 443, to: 443 }],
            });
            editorIndex = draft.length - 1;
            resetReview();
            render();
          },
          { disabled: busy || draft.length >= maximumRules },
        ),
      );
      if (draft.length >= maximumRules) {
        content.append(
          element(
            "p",
            { className: "hint" },
            `The ceiling supports at most ${maximumRules} rules.`,
          ),
        );
      }
    }
    if (details.length) {
      content.append(configurationErrors(details));
    }
    controls.append(draftStatus, reviewButton);
    content.append(controls);
  }
  void load();
  return { section, dirty, writing: () => writing };
}
