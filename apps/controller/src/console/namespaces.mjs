import { button, dismissOnBackdrop, element, field, statusBlock, validateFields } from "./dom.mjs";

export function renderNamespaces(context, items, renderRows) {
  const collection = element("div");
  const create = button("Create Namespace", openCreate, { tone: "primary" });
  context.view.replaceChildren(
    element(
      "div",
      { className: "namespace-toolbar" },
      element(
        "p",
        { className: "muted" },
        "Separate teams and workloads with their own Agents, Secrets, and access rules.",
      ),
      create,
    ),
    collection,
  );
  if (items.length) {
    renderRows(collection, "namespaces", items);
  } else {
    collection.append(
      element(
        "section",
        { className: "state-panel" },
        element("h2", {}, "No accessible namespaces"),
        element(
          "p",
          {},
          "Create a Namespace to get started, or ask an administrator for access to an existing one.",
        ),
      ),
    );
  }

  function openCreate() {
    const dialog = element("dialog", {
      className: "dialog",
      "aria-labelledby": "create-namespace-title",
      "aria-describedby": "create-namespace-description",
    });
    const title = element("h2", { id: "create-namespace-title" }, "Create Namespace");
    const description = element(
      "p",
      { id: "create-namespace-description", className: "muted" },
      "A Namespace keeps a team's Agents and resources together, with its own access rules.",
    );
    const name = element("input", {
      id: "namespace-name",
      type: "text",
      required: "",
      "data-trim": "",
      maxlength: "200",
      autocomplete: "off",
      placeholder: "e.g. Support",
    });
    const feedback = element("div");
    const cancel = button("Cancel", close);
    const submit = element(
      "button",
      { type: "submit", className: "button button--primary" },
      "Create Namespace",
    );
    const form = element(
      "form",
      { novalidate: "" },
      field({
        label: "Namespace name",
        control: name,
        help: "Unique within this Installation. Names cannot currently be changed.",
      }),
      feedback,
      element("div", { className: "dialog-actions" }, cancel, submit),
    );
    let pending = false;
    let unknown = false;
    let forbidden = false;
    let created = null;

    function close() {
      if (pending) {
        return;
      }
      dialog.close();
      if (created || unknown) {
        void context.reload();
      }
    }

    context.setLeaveGuard(() => {
      if (pending) {
        feedback.replaceChildren(
          statusBlock("info", null, "Wait for Namespace creation to finish before leaving."),
        );
      }
      return pending;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending || unknown || forbidden || !validateFields([name])) {
        return;
      }
      pending = true;
      form.setAttribute("aria-busy", "true");
      name.disabled = true;
      cancel.disabled = true;
      submit.disabled = true;
      submit.textContent = "Creating…";
      feedback.replaceChildren();
      try {
        const result = await context.request("/namespaces", {
          method: "POST",
          body: { name: name.value.trim() },
          expectedStatus: 201,
        });
        if (!context.isCurrent()) {
          return;
        }
        if (
          typeof result?.id !== "string" ||
          typeof result?.name !== "string" ||
          result.status !== "provisioning"
        ) {
          throw new Error("Invalid Namespace creation response");
        }
        created = result;
        title.textContent = "Namespace created";
        description.textContent = `${created.name} has been created. Provisioning is in progress; Agents can be saved as drafts, but deployment waits until the Namespace is ready.`;
        dialog.replaceChildren(
          title,
          description,
          element(
            "div",
            { className: "dialog-actions" },
            button("Done", close),
            button(
              "Open Agents",
              () => {
                dialog.close();
                context.navigate("agents", created.id);
              },
              { tone: "primary" },
            ),
          ),
        );
        dialog.querySelector("button:last-child").focus();
      } catch (error) {
        if (!context.isCurrent()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        forbidden = error.status === 403;
        unknown = ![400, 403, 404, 409, 429].includes(error.status);
        let message;
        if (unknown) {
          message =
            "Outcome unknown. Namespace creation could not be confirmed. Check Namespaces for this name before trying again.";
        } else if (forbidden) {
          message =
            "You do not have permission to create Namespaces in this Installation. Ask an administrator for access.";
        } else if (error.status === 409) {
          message =
            "This Namespace name is already in use or reserved by a deleted Namespace. Choose a different name.";
        } else if (error.status === 429) {
          message = "Too many requests. Wait before trying again.";
        } else {
          message = "Namespace creation was refused. Check the name and try again.";
        }
        feedback.replaceChildren(
          statusBlock("danger", null, message),
          ...(error.requestId
            ? [element("p", { className: "request-id" }, `Request ID: ${error.requestId}`)]
            : []),
        );
        name.disabled = unknown || forbidden;
        submit.disabled = unknown || forbidden;
        submit.textContent = "Create Namespace";
        cancel.disabled = false;
        cancel.textContent = unknown ? "Check Namespaces" : "Cancel";
        (unknown || forbidden ? cancel : name).focus();
      } finally {
        pending = false;
        form.removeAttribute("aria-busy");
      }
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dismissOnBackdrop(dialog);
    dialog.append(title, description, form);
    context.view.append(dialog);
    dialog.showModal();
    name.focus();
  }
}
