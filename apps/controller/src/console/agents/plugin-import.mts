import type { InspectedPluginPackage } from "@openclaw-enterprise/contracts";
import { requestFailure } from "../api-client.mjs";
import { button, element, field, withRequestId } from "../dom.mjs";
import { namespacePath } from "./list.mjs";
import type { PluginDiscoveryContext } from "./plugin-discovery.mjs";

type Preview = Omit<InspectedPluginPackage, "skills"> & {
  skills: readonly string[];
};

function fileContents(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function pluginImportControl(context: PluginDiscoveryContext, onPublished: () => void) {
  const archive = element("input", { type: "file", accept: ".tar,.tgz,.tar.gz" });
  const entry = element("input", { type: "text", placeholder: "Entry name", maxLength: 64 });
  const status = element("p", { className: "hint", role: "status" });
  const review = element("div");
  const preview = button("Preview package", () => void submit(false));
  const publish = button("Publish to Namespace", () => void submit(true), { tone: "primary" });
  publish.hidden = true;
  const panel = element(
    "details",
    { className: "plugin-import" },
    element("summary", {}, "Import plugin"),
    element(
      "div",
      {},
      field({
        label: "Package archive",
        control: archive,
        help: "Choose a .tar, .tgz or .tar.gz file.",
      }),
      field({ label: "Marketplace entry (optional)", control: entry }),
      element("div", { className: "form-actions" }, preview),
      review,
      element("div", { className: "form-actions" }, publish),
      status,
    ),
  );
  let approved:
    | { archiveBase64: string; marketplaceEntry?: string; digest: string; archiveSha256: string }
    | undefined;
  let pending = false;
  function setBusy(value: boolean) {
    pending = value;
    for (const control of [archive, entry, preview, publish]) {
      control.disabled = value;
    }
  }
  function reset() {
    approved = undefined;
    review.replaceChildren();
    publish.hidden = true;
    status.textContent = "";
  }
  archive.addEventListener("change", reset);
  entry.addEventListener("input", reset);
  function render(data: Preview) {
    review.replaceChildren(element("h3", {}, data.name + (data.version ? " " + data.version : "")));
    if (data.description) {
      review.append(element("p", {}, data.description));
    }
    for (const [heading, rows] of [
      ["Skills", data.skills],
      [
        "Hosted MCP servers",
        data.mcpServers.map(
          (s) => s.name + " · " + s.url + (s.bearerEnv ? " · Requires " + s.bearerEnv : ""),
        ),
      ],
      ["Excluded components", data.unsupported.map((s) => s.component + " · " + s.reason)],
    ] as const) {
      if (rows.length) {
        review.append(
          element("h4", {}, heading),
          element("ul", {}, ...rows.map((row) => element("li", {}, row))),
        );
      }
    }
    publish.hidden = !data.skills.length && !data.mcpServers.length;
  }
  async function submit(publishing: boolean) {
    if (pending || !context.isCurrent() || (publishing && !approved)) {
      return;
    }
    const file = archive.files?.[0];
    if (!file || file.size > 16 * 1024 * 1024) {
      reset();
      status.textContent = "Choose a package archive of at most 16 MiB.";
      archive.focus();
      return;
    }
    const base = namespacePath(context.namespaceId) + "/plugin-releases";
    if (!publishing) {
      reset();
    }
    setBusy(true);
    status.textContent = publishing ? "Publishing release…" : "Inspecting package…";
    try {
      if (publishing) {
        await context.request(base, { method: "POST", body: approved });
        if (context.isCurrent()) {
          reset();
          archive.value = "";
          entry.value = "";
          status.textContent = "Release published to this Namespace’s plugin catalog.";
          onPublished();
        }
      } else {
        const marketplaceEntry = entry.value.trim();
        const body = {
          archiveBase64: await fileContents(file),
          ...(marketplaceEntry ? { marketplaceEntry } : {}),
        };
        if (!context.isCurrent()) {
          return;
        }
        const result = (await context.request(base + "/preview", {
          method: "POST",
          body,
          readOnly: true,
        })) as Preview;
        if (context.isCurrent()) {
          render(result);
          approved = { ...body, digest: result.digest, archiveSha256: result.archiveSha256 };
          status.textContent = publish.hidden
            ? "This package has no components supported on this Harness."
            : "Review the components before publishing this release.";
        }
      }
    } catch (cause) {
      if (context.isCurrent()) {
        const error = requestFailure(cause);
        if (error.status === 401) {
          context.onExpired();
        } else {
          status.textContent = withRequestId(
            error.serverMessage ??
              (publishing
                ? "Could not publish this release. Retry publication."
                : "Could not preview the selected package. Check the archive and marketplace entry."),
            error.requestId,
          );
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return panel;
}
