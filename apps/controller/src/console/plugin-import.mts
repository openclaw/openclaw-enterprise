import type { InspectedPluginPackage } from "@openclaw-enterprise/contracts";
import { type RequestOptions, requestFailure, responseFields } from "./api-client.mjs";
import { button, element, field, withRequestId } from "./dom.mjs";

interface PluginImportContext {
  namespaceId: string;
  request(path: string, options?: RequestOptions & { readOnly?: true }): Promise<unknown>;
  isCurrent(): boolean;
  onExpired(): void;
}

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

export function pluginImportControl(
  context: PluginImportContext,
  onPublished: () => void,
  options: { expanded?: boolean; onWritingChange?(writing: boolean): void } = {},
) {
  const archive = element("input", { type: "file", accept: ".tar,.tgz,.tar.gz" });
  const entry = element("input", { type: "text", placeholder: "Entry name", maxLength: 64 });
  const status = element("p", { className: "hint", role: "status" });
  const review = element("div");
  const preview = button("Preview package", () => void submit(false));
  const publish = button("Publish to Namespace", () => void submit(true), { tone: "primary" });
  publish.hidden = true;
  const content = element(
    "div",
    { className: "plugin-import" },
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
  );
  const panel = options.expanded
    ? content
    : element(
        "details",
        { className: "plugin-import" },
        element("summary", {}, "Import plugin"),
        content,
      );
  let approved:
    | { archiveBase64: string; marketplaceEntry?: string; digest: string; archiveSha256: string }
    | undefined;
  let pending = false;
  function setBusy(value: boolean) {
    pending = value;
    options.onWritingChange?.(value);
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
    if (data.mcpServers.length) {
      review.append(
        element(
          "p",
          { className: "hint" },
          "Publishing records these hosted MCP servers. They cannot run until Plugin credential delivery supports an enrolled Source and Connection Template.",
        ),
      );
    }
    if (data.skills.length) {
      review.append(
        element(
          "p",
          { className: "hint" },
          "Imported skills cannot deploy until the pinned OpenClaw runtime supports skill installation. Deploying a release that contains skills is refused.",
        ),
      );
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
    const base = `/namespaces/${encodeURIComponent(context.namespaceId)}/plugin-releases`;
    if (!publishing) {
      reset();
    }
    setBusy(true);
    status.textContent = publishing ? "Publishing release…" : "Inspecting package…";
    try {
      if (publishing) {
        const result = responseFields(
          await context.request(base, { method: "POST", body: approved }),
        );
        if (context.isCurrent()) {
          const confirmed =
            result.digest === approved?.digest && result.archiveSha256 === approved?.archiveSha256;
          reset();
          archive.value = "";
          entry.value = "";
          status.textContent = confirmed
            ? "Release published to this Namespace’s plugin catalog."
            : "Publication outcome is unknown. Refresh the Namespace plugin catalog to check whether the release was saved.";
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
