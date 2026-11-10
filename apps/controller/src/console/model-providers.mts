import type {
  ConnectionTemplate,
  CredentialSourceMetadata,
  InferencePrivatePeer,
  InferencePrivatePeerInput,
  ModelProvider,
  ModelProviderView,
  SecretMetadata,
} from "@openclaw-enterprise/contracts";
import { button, element, field } from "./dom.mjs";
import { requestFailure, responseFields } from "./api-client.mjs";
import { oauthCatalog } from "./oauth-catalog.mjs";
import type { ConsolePageContext } from "./page-context.mjs";

type Context = Pick<ConsolePageContext, "request" | "isCurrent">;
type CatalogModel = ModelProvider["models"][number];

const administration = { installationAdministration: "required" as const };
const option = (value: string, label: string) => element("option", { value }, label);

function failure(cause: unknown, fallback: string) {
  return requestFailure(cause).serverMessage || fallback;
}

function route(baseUrl: string, protocol: string) {
  return (
    baseUrl.replace(/\/$/, "") +
    (protocol === "openai-responses" ? "/responses" : "/chat/completions")
  );
}

function describePrivatePeer(peer: InferencePrivatePeer): string {
  return peer.kind === "private_ipv4"
    ? "Private server at " + peer.address
    : "Kubernetes Service " +
        peer.namespace +
        "/" +
        peer.name +
        " at " +
        peer.address +
        " (target port " +
        peer.targetPort +
        ")";
}

function modelRow(initial: CatalogModel | undefined, remove: () => void) {
  const modelId = element("input", {
    required: true,
    value: initial?.id ?? "",
    placeholder: "Model ID",
  });
  const name = element("input", { value: initial?.name ?? "" });
  function number(value?: number, min = 1) {
    return element("input", {
      type: "number",
      min,
      step: min ? "1" : "any",
      value: value?.toString() ?? "",
    });
  }
  const contextWindow = number(initial?.contextWindow);
  const maxTokens = number(initial?.maxTokens);
  const costKeys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const costs = costKeys.map((key) => number(initial?.cost?.[key], 0));
  const costLabels = ["Input", "Output", "Cache read", "Cache write"];
  const advanced = element(
    "details",
    {},
    element("summary", {}, "Model metadata"),
    field({ label: "Display name", control: name }),
    field({ label: "Context window (tokens)", control: contextWindow }),
    field({ label: "Maximum output tokens", control: maxTokens }),
    element(
      "fieldset",
      {},
      element("legend", {}, "Cost per million tokens"),
      ...costs.map((input, i) => field({ label: costLabels[i]!, control: input })),
    ),
  );
  const node = element(
    "fieldset",
    { className: "connection-template-fields" },
    field({ label: "Model ID", control: modelId }),
    advanced,
    button("Remove model", remove, { size: "sm" }),
  );
  return {
    node,
    modelId,
    read(): CatalogModel {
      return {
        id: modelId.value.trim(),
        ...(name.value.trim() ? { name: name.value.trim() } : {}),
        ...(contextWindow.value ? { contextWindow: contextWindow.valueAsNumber } : {}),
        ...(maxTokens.value ? { maxTokens: maxTokens.valueAsNumber } : {}),
        ...(costs.every((input) => input.value !== "")
          ? {
              cost: {
                input: costs[0]!.valueAsNumber,
                output: costs[1]!.valueAsNumber,
                cacheRead: costs[2]!.valueAsNumber,
                cacheWrite: costs[3]!.valueAsNumber,
              },
            }
          : {}),
      };
    },
    complete() {
      return !costs.some((input) => input.value) || costs.every((input) => input.value !== "");
    },
  };
}

export function renderModelProviders(context: Context) {
  let templates: ConnectionTemplate[] = [];
  const add = button("Add model provider", () => edit(), { tone: "primary", size: "sm" });
  const { section, list, notice, showRows } = oauthCatalog("Model providers", add, "Provider", [
    "Endpoint",
    "Models",
  ]);
  async function load(saved = "") {
    add.disabled = true;
    notice.textContent = "Loading model providers…";
    try {
      const [providers, available] = await Promise.all([
        context.request("/model-providers", administration) as Promise<ModelProviderView[]>,
        context.request("/connection-templates", administration) as Promise<ConnectionTemplate[]>,
      ]);
      if (!context.isCurrent()) {
        return;
      }
      templates = available;
      showRows(
        providers.map((provider) => ({
          name: provider.displayName,
          details: [provider.baseUrl, provider.models.map((model) => model.id).join(", ")],
          actions: [
            button("Edit", () => edit(provider), {
              size: "sm",
              "aria-label": "Edit " + provider.displayName,
            }),
          ],
        })),
      );
      notice.textContent = saved || (providers.length ? "" : "No model providers configured.");
      add.disabled = false;
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      notice.textContent = failure(error, "Could not load model providers.");
      list.replaceChildren(button("Retry", () => void load()));
    }
  }

  function edit(provider?: ModelProviderView) {
    const dialog = element("dialog", {
      className: "dialog dialog--framed connection-template-dialog",
      "aria-labelledby": "provider-editor-title",
    });
    const name = element("input", { required: true, value: provider?.displayName ?? "" });
    const baseUrl = element("input", {
      type: "url",
      required: true,
      placeholder: "https://inference.example.com/v1",
      value: provider?.baseUrl ?? "",
    });
    const protocol = element(
      "select",
      {},
      option("openai-responses", "OpenAI Responses"),
      option("openai-completions", "OpenAI Chat Completions"),
    );
    protocol.value = provider?.protocol ?? "openai-responses";
    const models = element("div", { className: "form-fields" });
    const rows: ReturnType<typeof modelRow>[] = [];
    const defaultModel = element("select");
    let selectedDefault = provider?.defaultModelId ?? "";
    defaultModel.addEventListener("change", () => {
      selectedDefault = defaultModel.value;
    });
    function syncModels() {
      defaultModel.replaceChildren(
        option("", "No default"),
        ...rows
          .filter((row) => row.modelId.value.trim())
          .map((row) => option(row.modelId.value.trim(), row.modelId.value.trim())),
      );
      defaultModel.value = selectedDefault;
    }
    function addModel(initial?: CatalogModel) {
      const row = modelRow(initial, () => {
        rows.splice(rows.indexOf(row), 1);
        row.node.remove();
        syncModels();
      });
      row.modelId.addEventListener("input", syncModels);
      rows.push(row);
      models.append(row.node);
      syncModels();
    }
    for (const model of provider?.models ?? []) {
      addModel(model);
    }
    if (!rows.length) {
      addModel();
    }
    const template = element("select", { required: true });
    const templateName = element("input", { required: true });
    const newName = field({ label: "New static-key template name", control: templateName });
    const destination = element("p", { className: "hint" });
    const network = element(
      "select",
      {},
      option("public", "Public endpoint"),
      option("private_ipv4", "Private server"),
      option("kubernetes_service", "Kubernetes Service"),
    );
    const networkField = field({ label: "Network destination", control: network });
    const address = element("input", { required: true, placeholder: "10.20.30.40" });
    const addressField = field({ label: "Private IPv4 address", control: address });
    const serviceHelp = element(
      "p",
      { className: "hint" },
      "Use the Service DNS name in the inference URL, for example https://inference.research.svc.cluster.local/v1.",
    );
    function refreshDestination() {
      const creating = template.value === "new";
      newName.hidden = templateName.disabled = !creating;
      networkField.hidden = network.disabled = !creating;
      addressField.hidden = address.disabled = !creating || network.value !== "private_ipv4";
      serviceHelp.hidden = !creating || network.value !== "kubernetes_service";
      const saved = templates.find((item) => item.id === template.value)?.current;
      const privatePeer = saved?.mode === "static_bearer" ? saved.privatePeer : undefined;
      destination.textContent = baseUrl.value.trim()
        ? "Allowed request: POST " +
          route(baseUrl.value.trim(), protocol.value) +
          (privatePeer ? ". " + describePrivatePeer(privatePeer) + "." : "")
        : "";
    }
    network.addEventListener("change", refreshDestination);
    function syncTemplates(preferred = template.value) {
      const matching = templates.filter(
        (t) =>
          !t.namespaceId &&
          t.current.mode === "static_bearer" &&
          t.current.protocol === protocol.value &&
          t.current.baseUrl === baseUrl.value.trim().replace(/\/$/, ""),
      );
      template.replaceChildren(
        ...matching.map((t) => option(t.id, t.displayName)),
        option("new", "Create a static-key template"),
      );
      template.value = matching.some((t) => t.id === preferred)
        ? preferred
        : (matching[0]?.id ?? "new");
      refreshDestination();
    }
    baseUrl.addEventListener("input", () => syncTemplates());
    protocol.addEventListener("change", () => syncTemplates());
    template.addEventListener("change", refreshDestination);
    syncTemplates(provider?.connectionTemplateId);
    const status = element("p", { role: "status", className: "hint" });
    const cancel = button("Cancel", () => dialog.close());
    const reload = button("Reload provider list", () => {
      dialog.close();
      void load();
    });
    reload.hidden = true;
    const save = element(
      "button",
      { type: "submit", className: "button button--primary" },
      "Save provider",
    );
    const fields = element(
      "fieldset",
      { className: "connection-template-fields" },
      field({ label: "Provider name", control: name }),
      field({ label: "Inference base URL", control: baseUrl }),
      field({ label: "Inference API format", control: protocol }),
      element("h3", {}, "Models offered by this provider"),
      models,
      button("Add model", () => addModel(), { size: "sm" }),
      field({ label: "Default model", control: defaultModel }),
      field({ label: "Static-key connection template", control: template }),
      newName,
      networkField,
      addressField,
      serviceHelp,
      destination,
    );
    const form = element(
      "form",
      {},
      element("div", { className: "dialog-body" }, fields, status),
      element("div", { className: "dialog-actions" }, cancel, reload, save),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (save.disabled) {
        return;
      }
      if (!rows.length || rows.some((row) => !row.complete())) {
        status.textContent =
          "Add at least one model. For model pricing, enter all four costs or leave them empty.";
        return;
      }
      fields.disabled = save.disabled = cancel.disabled = true;
      try {
        let connectionTemplateId = template.value;
        if (connectionTemplateId === "new") {
          let privatePeer: InferencePrivatePeerInput | undefined;
          if (network.value === "private_ipv4") {
            privatePeer = { kind: "private_ipv4", address: address.value.trim() };
          } else if (network.value === "kubernetes_service") {
            const service = /^([^.]+)\.([^.]+)\.svc\.cluster\.local$/.exec(
              new URL(baseUrl.value).hostname,
            );
            if (!service) {
              status.textContent =
                "Enter the Service URL using service.namespace.svc.cluster.local.";
              return;
            }
            privatePeer = { kind: "kubernetes_service", name: service[1]!, namespace: service[2]! };
          }
          const created = (await context.request("/connection-templates", {
            ...administration,
            method: "POST",
            body: {
              mode: "static_bearer",
              ...(privatePeer && { privatePeer }),
              displayName: templateName.value.trim(),
              baseUrl: baseUrl.value.trim(),
              protocol: protocol.value,
            },
          })) as ConnectionTemplate;
          if (!context.isCurrent()) {
            return;
          }
          templates.push(created);
          syncTemplates(created.id);
          connectionTemplateId = created.id;
        }
        const body = {
          displayName: name.value.trim(),
          baseUrl: baseUrl.value.trim(),
          protocol: protocol.value,
          models: rows.map((row) => row.read()),
          ...(defaultModel.value ? { defaultModelId: defaultModel.value } : {}),
          connectionTemplateId,
        };
        await context.request(
          provider ? "/model-providers/" + encodeURIComponent(provider.id) : "/model-providers",
          {
            ...administration,
            method: provider ? "PUT" : "POST",
            body: provider
              ? { ...body, expectedSettingsFingerprint: provider.settingsFingerprint }
              : body,
          },
        );
        if (!context.isCurrent()) {
          return;
        }
        dialog.close();
        await load("Saved " + body.displayName + ".");
      } catch (error) {
        status.textContent = failure(error, "Could not confirm that the provider was saved.");
        const paths = responseFields(error).detailPaths;
        if (
          requestFailure(error).status === 409 &&
          Array.isArray(paths) &&
          paths.includes("/expectedSettingsFingerprint")
        ) {
          reload.hidden = false;
        }
      } finally {
        fields.disabled = cancel.disabled = false;
        save.disabled = !reload.hidden;
      }
    });
    dialog.addEventListener("cancel", (event) => {
      if (fields.disabled) {
        event.preventDefault();
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.append(
      element(
        "h2",
        { id: "provider-editor-title" },
        provider ? "Edit model provider" : "Add model provider",
      ),
      form,
    );
    section.append(dialog);
    dialog.showModal();
  }
  void load();
  return section;
}

export function renderInferenceCredential(
  context: Context,
  namespaceId: string,
  readSecrets: () => readonly Pick<SecretMetadata, "id" | "name">[],
) {
  const section = element(
    "details",
    { className: "section" },
    element("summary", {}, "Register an inference credential"),
  );
  const contents = element("div", { className: "form-fields" });
  section.append(contents);
  const root = "/namespaces/" + encodeURIComponent(namespaceId);
  async function load() {
    contents.textContent = "Loading static-key templates…";
    try {
      const templates = (await context.request(
        root + "/connection-templates",
      )) as ConnectionTemplate[];
      if (!context.isCurrent()) {
        return;
      }
      const secrets = readSecrets();
      const available = templates.filter((t) => t.current.mode === "static_bearer");
      if (!available.length || !secrets.length) {
        contents.textContent = !available.length
          ? "An Installation administrator must configure a static-key connection template first."
          : "Create a Secret for the inference key first.";
        return;
      }
      const name = element("input", { required: true });
      const template = element("select", {}, ...available.map((t) => option(t.id, t.displayName)));
      const secret = element(
        "select",
        { required: true },
        option("", "Choose a saved Secret"),
        ...secrets.map((s) => option(s.id, s.name)),
      );
      const destination = element("p", { className: "hint" });
      function showGrant() {
        const grant = available.find((t) => t.id === template.value)?.current;
        destination.textContent =
          grant?.mode === "static_bearer"
            ? "Approve POST " +
              route(grant.baseUrl, grant.protocol) +
              " (template version " +
              grant.version +
              ")." +
              (grant.privatePeer ? " " + describePrivatePeer(grant.privatePeer) + "." : "")
            : "";
      }
      template.addEventListener("change", showGrant);
      showGrant();
      const save = element(
        "button",
        { type: "submit", className: "button button--primary" },
        "Approve and register key",
      );
      const fields = element(
        "fieldset",
        { className: "connection-template-fields" },
        field({ label: "Credential name", control: name }),
        field({ label: "Connection template", control: template }),
        field({ label: "API key Secret", control: secret }),
        destination,
        save,
      );
      const status = element("p", { role: "status" });
      const form = element("form", {}, fields, status);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const approved = available.find((t) => t.id === template.value);
        const selected = secrets.find((s) => s.id === secret.value);
        if (
          fields.disabled ||
          !selected ||
          !approved ||
          approved.current.mode !== "static_bearer"
        ) {
          return;
        }
        fields.disabled = true;
        try {
          const source = (await context.request(root + "/credential-sources", {
            method: "POST",
            body: {
              type: "openai",
              name: name.value.trim(),
              secrets: { api_key: { kind: "secret", id: selected.id, namespaceId } },
              connectionTemplateId: approved.id,
              connectionTemplateVersion: approved.current.version,
            },
          })) as CredentialSourceMetadata;
          if (!context.isCurrent()) {
            return;
          }
          if (
            source.state !== "ready" ||
            source.namespaceId !== namespaceId ||
            source.staticKeyGrant?.connectionTemplateId !== approved.id ||
            source.staticKeyGrant.connectionTemplateVersion !== approved.current.version
          ) {
            throw new Error("The credential has not confirmed the approved template version.");
          }
          status.textContent = "Registered " + source.name + ". Select it in Create Agent.";
          form.reset();
          showGrant();
        } catch (error) {
          status.textContent = failure(
            error,
            "Could not confirm registration. Check the credential before retrying.",
          );
        } finally {
          fields.disabled = false;
        }
      });
      contents.replaceChildren(form);
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      contents.replaceChildren(
        failure(error, "Could not load connection templates."),
        button("Retry", () => void load()),
      );
    }
  }
  section.addEventListener("toggle", () => {
    if (section.open) {
      void load();
    }
  });
  return section;
}
