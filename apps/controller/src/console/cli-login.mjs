import { button, element } from "./dom.mjs";

// RFC-0019 `occ login`: the person types the code occ printed and approves or denies it here.
// The code is only ever typed: this page never reads one from its URL, so a link cannot
// pre-fill a code for someone else's terminal.

function when(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function failureText(error, fallback) {
  if (error?.status === 429) {
    return `Too many attempts. Try again in ${error.retryAfterSeconds ?? 60} seconds.`;
  }
  return error?.serverMessage ?? fallback;
}

/** The approval page at /console/cli-login. */
export function renderCliLogin(view, { request, isCurrent, onSessions }) {
  const feedback = element("p", { className: "error", role: "alert", hidden: true });
  const input = element("input", {
    id: "cli-login-code",
    name: "userCode",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    maxlength: "16",
    placeholder: "BCDF-GHJK",
    required: true,
    "aria-describedby": "cli-login-hint",
  });
  const submit = element("button", { type: "submit", className: "primary" }, "Continue");
  const form = element(
    "form",
    { className: "cli-login-form" },
    element(
      "div",
      { className: "form-field" },
      element("label", { for: "cli-login-code" }, "Code shown by occ login"),
      input,
      element(
        "p",
        { className: "hint", id: "cli-login-hint" },
        "Only enter a code from a terminal you just used yourself. Never enter a code someone sent you.",
      ),
    ),
    feedback,
    element("div", { className: "form-actions" }, submit),
  );
  const panel = element(
    "section",
    { className: "state-panel cli-login" },
    element("h2", {}, "Enter the code"),
    element(
      "p",
      {},
      "Approving gives occ a CLI session that acts as you, with your current permissions. It ends when this browser session ends, after at most 8 hours, or when you revoke it.",
    ),
    form,
  );
  view.append(panel);
  input.focus();

  function fail(error, fallback) {
    feedback.textContent = failureText(error, fallback);
    feedback.hidden = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    feedback.hidden = true;
    submit.disabled = true;
    try {
      const found = await request("/api/auth/cli/device-authorizations/lookup", {
        method: "POST",
        body: { userCode: input.value },
        readOnly: true,
      });
      if (!isCurrent()) {
        return;
      }
      review(input.value, found);
    } catch (error) {
      if (isCurrent()) {
        fail(error, "The code could not be checked.");
      }
    } finally {
      submit.disabled = false;
    }
  });

  function review(userCode, found) {
    const details = element(
      "dl",
      { className: "settings cli-login-details" },
      element("dt", {}, "Client"),
      element("dd", {}, `${found.clientLabel} (reported by the client, not verified)`),
      element("dt", {}, "From"),
      element("dd", {}, found.requesterAddress),
      ...(found.namespaceId
        ? [element("dt", {}, "Namespace"), element("dd", {}, `Pinned to ${found.namespaceId}`)]
        : [element("dt", {}, "Reach"), element("dd", {}, "Everything your account can reach")]),
      element("dt", {}, "Ends"),
      element("dd", {}, `${when(found.sessionExpiresAt)} at the latest`),
    );
    const warning = found.sameAddress
      ? null
      : element(
          "p",
          { className: "notice", role: "alert" },
          "This request came from a different network address than this browser. Deny it unless you started occ login on that machine.",
        );
    const result = element("p", { className: "error", role: "alert", hidden: true });
    const approve = button("Approve", () => void decide("approve"), { className: "primary" });
    const deny = button("Deny", () => void decide("deny"));
    const cancel = button("Cancel", () => {
      panel.replaceChildren(...initial);
      input.value = "";
      input.focus();
    });
    const initial = [...panel.childNodes];
    panel.replaceChildren(
      element("h2", {}, "Approve this sign-in?"),
      element("p", {}, "Check that this is the occ login you just started."),
      details,
      ...(warning === null ? [] : [warning]),
      result,
      element("div", { className: "form-actions" }, approve, deny, cancel),
    );
    approve.focus();

    async function decide(decision) {
      for (const control of [approve, deny, cancel]) {
        control.disabled = true;
      }
      try {
        const decided = await request("/api/auth/cli/device-authorizations/decide", {
          method: "POST",
          body: { userCode, decision },
        });
        if (!isCurrent()) {
          return;
        }
        panel.replaceChildren(
          element("h2", {}, decision === "approve" ? "occ is signed in" : "Sign-in denied"),
          element(
            "p",
            { role: "status" },
            decision === "approve"
              ? `Return to your terminal; occ finishes signing in within a few seconds. The CLI session ends by ${when(decided.sessionExpiresAt)}.`
              : "occ login will stop and report that the request was denied.",
          ),
          element(
            "div",
            { className: "form-actions" },
            button("Review CLI sessions", () => onSessions()),
          ),
        );
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        result.textContent = failureText(error, "The decision could not be recorded.");
        result.hidden = false;
        for (const control of [approve, deny, cancel]) {
          control.disabled = false;
        }
      }
    }
  }
}

/** The signed-in person's own CLI sessions, each with Revoke (Settings). */
export function renderCliSessions(container, { request, isCurrent }) {
  const status = element("p", { role: "status" }, "Reading CLI sessions…");
  const list = element("ul", { className: "cli-sessions", "aria-label": "CLI sessions" });
  const section = element(
    "section",
    { className: "state-panel cli-sessions-panel" },
    element("h2", {}, "CLI sessions"),
    element(
      "p",
      {},
      "Sessions created with occ login. Each acts as you and ends with the browser session that approved it.",
    ),
    status,
    list,
  );
  container.append(section);

  async function load() {
    try {
      const sessions = await request("/api/auth/cli-sessions");
      if (!isCurrent()) {
        return;
      }
      list.replaceChildren(
        ...sessions.map((session) => {
          const revoke = button("Revoke", async () => {
            revoke.disabled = true;
            try {
              await request(`/api/auth/cli-sessions/${encodeURIComponent(session.id)}`, {
                method: "DELETE",
              });
              if (isCurrent()) {
                await load();
              }
            } catch (error) {
              if (isCurrent()) {
                revoke.disabled = false;
                status.textContent = failureText(error, "The CLI session could not be revoked.");
              }
            }
          });
          return element(
            "li",
            { className: "cli-session" },
            element(
              "div",
              {},
              element("strong", {}, session.clientLabel),
              element(
                "p",
                { className: "hint" },
                `Signed in ${when(session.createdAt)}; ends ${when(session.expiresAt)}`,
                session.namespaceId ? `; pinned to ${session.namespaceId}` : "",
              ),
            ),
            revoke,
          );
        }),
      );
      status.textContent = sessions.length ? "" : "No active CLI sessions.";
    } catch (error) {
      if (isCurrent()) {
        status.textContent = failureText(error, "CLI sessions could not be read.");
      }
    }
  }
  void load();
}
