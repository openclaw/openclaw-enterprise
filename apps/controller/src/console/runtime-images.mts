import type { Agent, RuntimeImage } from "@openclaw-enterprise/contracts";
import { element } from "./dom.mjs";
import { type AccessNeed, namespaceListNeed, readFailure } from "./agents/list.mjs";
import type { NamespacePageContext } from "./namespaces.mjs";

// Each Agent's images authorize Agent read on it; the Agent list, Namespace read. A failed read
// says which, or how long to wait, instead of one "unavailable, retry" (finding 2538).
const RUNTIME_IMAGES_NEED: AccessNeed = {
  task: "reading this Agent's runtime images",
  grant: "Agent read on it",
};

type RuntimeImagesContext = Pick<NamespacePageContext, "request" | "isCurrent"> & {
  namespaceId: string | null;
};

export async function renderRuntimeImages(
  target: HTMLElement,
  { request, namespaceId, isCurrent }: RuntimeImagesContext,
) {
  const content = element(
    "div",
    { className: "runtime-debug-images", "aria-live": "polite" },
    "Loading runtime images…",
  );
  target.append(content);
  const current = () => isCurrent() && target.isConnected;
  if (namespaceId === null) {
    content.textContent = "Select a readable Namespace to inspect runtime images.";
    return;
  }
  try {
    const path = `/namespaces/${encodeURIComponent(namespaceId)}/agents`;
    const agents = (await request(path)) as readonly Pick<Agent, "id" | "name">[];
    if (!current()) {
      return;
    }
    content.replaceChildren();
    if (!agents.length) {
      content.textContent = "No accessible Agents in this Namespace.";
    }
    // Bound concurrent driver reads; a failed Agent must not hide other results.
    const pending = agents.map(({ id, name }) => {
      const loading = element("p", {}, "Loading…");
      const row = element("details", {}, element("summary", {}, name), loading);
      content.append(row);
      return { id, loading };
    });
    async function worker() {
      while (current()) {
        const next = pending.shift();
        if (!next) {
          return;
        }
        const { id, loading } = next;
        try {
          const result = (await request(`${path}/${encodeURIComponent(id)}/runtime-images`)) as {
            status: "observed" | "undeployed" | "unsupported";
            images: readonly RuntimeImage[];
          };
          if (!current()) {
            return;
          }
          const details = document.createDocumentFragment();
          if (result.status !== "observed" || !result.images.length) {
            details.append(
              element(
                "p",
                {},
                result.status === "unsupported"
                  ? "Image inspection is unavailable for this Compute Driver."
                  : "No deployed runtime images observed.",
              ),
            );
          }
          for (const image of result.images) {
            const list = element("dl", {});
            for (const [label, value] of [
              ["Container", image.container],
              ["Workload", image.workload],
              ["Docker image", image.image],
              ["Image ID / digest", image.imageId ?? "Unavailable"],
              ["Source commit", image.commit ?? "Unavailable (image has no provenance)"],
              [
                "OpenClaw commit",
                image.openclawCommit ?? "Unavailable (image has no OpenClaw provenance)",
              ],
            ] as const) {
              list.append(element("dt", {}, label), element("dd", {}, element("code", {}, value)));
            }
            details.append(list);
          }
          loading.replaceWith(details);
        } catch (cause) {
          if (current()) {
            loading.textContent = readFailure("Runtime image metadata", cause, RUNTIME_IMAGES_NEED);
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, agents.length) }, worker));
  } catch (cause) {
    if (current()) {
      content.textContent = readFailure("Agents", cause, namespaceListNeed("Agents"));
    }
  }
}
