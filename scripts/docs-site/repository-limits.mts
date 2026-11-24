const resources = [
  { key: "issues", name: "Issues", write: "Read and create" },
  { key: "pull_requests", name: "Pull requests", write: "Read and open" },
] as const;

function mount(root: HTMLElement) {
  root.innerHTML = `
    <div class="grant">
      <label>Example Agent grant
        <select name="grant">
          <option value="read">Read-only</option>
          <option value="write" selected>Contributor</option>
        </select>
      </label>
      <button type="button" data-reset hidden>Reset limits</button>
    </div>
    <div aria-live="polite" aria-atomic="true">
      <dl>
        <div><dt>Git</dt><dd data-git></dd></div>
        ${resources.map(({ key, name }) => `<div><dt>${name}</dt><dd data-level="${key}"></dd></div>`).join("")}
      </dl>
      <div data-mixed hidden>Opening pull requests is blocked because another bound repository has no grant.</div>
    </div>
    <details data-example>
      <summary>Example permissions <span data-permissions></span></summary>
      <div>This example assumes native Git, Contents write, matching GitHub App permissions and no extra Agent limits.</div>
      <div class="levels">
        ${resources
          .map(
            ({ key, name }) => `
          <label>${name} permission
            <select name="${key}">
              <option value="none">None</option>
              <option value="read">Read</option>
              <option value="write" selected>Write</option>
            </select>
          </label>`,
          )
          .join("")}
      </div>
      <label><input type="checkbox" name="ungranted">Another bound repository has no Agent grant</label>
    </details>
    <details data-advanced>
      <summary>Advanced <span data-mode></span></summary>
      <div>These limits apply to every Agent using the registration. They cannot add permissions or change Git access.</div>
      <div class="levels">
        ${resources
          .map(
            ({ key, name, write }) => `
          <label>${name}
            <select name="limit-${key}">
              <option value="">Use permissions</option>
              <option value="none">No access</option>
              <option value="read">Read-only</option>
              <option value="write">${write}</option>
            </select>
          </label>`,
          )
          .join("")}
      </div>
      <label><input type="checkbox" name="block">Block API access unless listed</label>
      <div class="hint">Includes future resources. For Git only, select this option and leave both resources blocked by default.</div>
      <div data-omit>Omit <code>apiLimits</code> to use the approved permissions and each Agent’s grant.</div>
      <div data-config hidden>
        Set <code>apiLimits</code> beside <code>permissions</code> in this repository’s <code>namespaces</code> entry. Redeploy affected Agents.
        <pre><code></code></pre>
      </div>
    </details>`;

  const select = (name: string) => root.querySelector<HTMLSelectElement>(`[name="${name}"]`)!;
  const block = root.querySelector<HTMLInputElement>("[name=block]")!;
  const ungranted = root.querySelector<HTMLInputElement>("[name=ungranted]")!;
  const reset = root.querySelector<HTMLButtonElement>("[data-reset]")!;
  const advanced = root.querySelector<HTMLDetailsElement>("[data-advanced]")!;

  function render() {
    // Only explicit Namespace limits belong in the fragment.
    const apiLimits: Record<string, string> = block.checked ? { default: "none" } : {};
    const grant = select("grant").value;
    root.querySelector("[data-git]")!.textContent = grant === "write" ? "Fetch and push" : "Fetch";
    let blocked = false;
    let customPermissions = ungranted.checked;
    for (const { key, write } of resources) {
      const permission = select(key).value;
      customPermissions ||= permission !== "write";
      const limit = select("limit-" + key);
      limit.options[0]!.text = block.checked ? "Blocked by default" : "Use permissions";
      if (limit.value) {
        apiLimits[key] = limit.value;
      }
      const levels = [grant, permission, limit.value || apiLimits.default];
      const result = root.querySelector(`[data-level="${key}"]`)!;
      if (levels.includes("none")) {
        result.textContent = "No access";
      } else if (levels.includes("read")) {
        result.textContent = "Read-only";
      } else if (key === "pull_requests" && ungranted.checked) {
        result.textContent = "Read-only";
        blocked = true;
      } else {
        result.textContent = write;
      }
    }
    root.querySelector<HTMLElement>("[data-mixed]")!.hidden = !blocked;
    root.querySelector("[data-permissions]")!.textContent = customPermissions
      ? "· Custom"
      : "· Write for both";
    const custom = Object.keys(apiLimits).length !== 0;
    reset.hidden = !custom;
    root.querySelector("[data-mode]")!.textContent = custom
      ? "· Custom limits"
      : "· No extra limits";
    root.querySelector<HTMLElement>("[data-omit]")!.hidden = custom;
    root.querySelector<HTMLElement>("[data-config]")!.hidden = !custom;
    root.querySelector("pre code")!.textContent = custom
      ? JSON.stringify({ apiLimits }, null, 2)
      : "";
  }

  reset.addEventListener("click", () => {
    for (const { key } of resources) {
      select("limit-" + key).value = "";
    }
    block.checked = false;
    render();
    advanced.open = false;
    advanced.querySelector("summary")!.focus();
  });
  root.addEventListener("change", render);
  render();
}

for (const root of document.querySelectorAll<HTMLElement>("[data-repository-limits]")) {
  mount(root);
}
