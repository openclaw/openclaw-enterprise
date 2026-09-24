import { element } from "./dom.mjs";

export async function renderRuntimeImages(target, { request, namespaceId, lifetime, active }) {
  const content = element(
    "div",
    { className: "runtime-debug-images", "aria-live": "polite" },
    "Loading runtime images…",
  );
  target.append(content);
  const current = () => lifetime.isCurrent(active) && target.isConnected;
  if (namespaceId === null) {
    content.textContent = "Select a readable Namespace to inspect runtime images.";
    return;
  }
  try {
    const path = `/namespaces/${encodeURIComponent(namespaceId)}/agents`;
    const agents = await request(path);
    if (!current()) {
      return;
    }
    content.replaceChildren();
    if (!agents.length) {
      content.textContent = "No accessible Agents in this Namespace.";
    }
    // Bound concurrent driver reads; a failed Agent must not hide other results.
    const pending = [...agents];
    const rows = new Map(
      agents.map((agent) => {
        const row = element(
          "details",
          {},
          element("summary", {}, agent.name),
          element("p", {}, "Loading…"),
        );
        content.append(row);
        return [agent.id, row];
      }),
    );
    async function worker() {
      while (pending.length && current()) {
        const agent = pending.shift();
        const row = rows.get(agent.id);
        try {
          const result = await request(`${path}/${encodeURIComponent(agent.id)}/runtime-images`);
          if (!current()) {
            return;
          }
          row.querySelector("p").remove();
          if (result.status !== "observed" || !result.images.length) {
            row.append(
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
            const details = element("dl", {});
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
            ]) {
              details.append(
                element("dt", {}, label),
                element("dd", {}, element("code", {}, value)),
              );
            }
            row.append(details);
          }
        } catch {
          if (current()) {
            row.replaceChildren(
              element("summary", {}, agent.name),
              element("p", {}, "Runtime image metadata unavailable. Refresh to retry."),
            );
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, agents.length) }, worker));
  } catch {
    if (current()) {
      content.textContent = "Runtime image metadata unavailable. Refresh to retry.";
    }
  }
}
