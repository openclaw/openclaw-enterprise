// Example inputs never affect the registration fragment.
const actions = [
  ["issues:read", "Read issues"],
  ["issues:create", "Create issues"],
  ["pull_requests:read", "Read pull requests"],
  ["pull_requests:create", "Open pull requests"],
] as const;

function level(label: string, id: string) {
  return `<label>${label}<select aria-label="${label}" name="${id}">
    <option value="none">None</option>
    <option value="read">Read</option>
    <option value="write" selected>Write</option>
  </select></label>`;
}

function mount(root: HTMLElement) {
  root.innerHTML = `
    <fieldset>
      <legend>Actions to keep for this Namespace registration</legend>
      <div class="action-options">
        ${actions.map(([id, label]) => `<label><input type="checkbox" value="${id}" checked>${label}</label>`).join("")}
      </div>
      <label><input type="checkbox" name="future" checked>Include new eligible actions automatically</label>
      <button type="button" data-git>Git only</button>
      <button type="button" data-reset>Reset filter</button>
    </fieldset>
    <div aria-live="polite">
      <div data-mode></div>
      <pre hidden><code></code></pre>
    </div>
    <details>
      <summary>Example at next deployment</summary>
      <div>Choose example Namespace permissions and an Agent grant. This assumes native delivery and matching GitHub permissions. It does not read or change a running policy.</div>
      <div class="example-levels">
        ${level("Issues permission", "issues")}
        ${level("Pull requests permission", "pull_requests")}
        ${level("Agent grant", "grant")}
      </div>
      <label><input type="checkbox" name="ungranted">Another bound repository has no Agent grant</label>
      <div aria-live="polite">
        ${actions.map(([id, label]) => `<div aria-atomic="true" data-action="${id}"><strong>${label}</strong><span></span></div>`).join("")}
      </div>
    </details>
    <div class="action-limits">Issue lists can include pull requests. Creation returns the record even without read access. Opening a pull request can convert an issue. Creating an issue may link a parent in another repository.</div>`;

  const options = [...root.querySelectorAll<HTMLInputElement>(".action-options input")];
  const future = root.querySelector<HTMLInputElement>("[name=future]")!;
  const ungranted = root.querySelector<HTMLInputElement>("[name=ungranted]")!;
  const selected = (name: string) =>
    root.querySelector<HTMLSelectElement>(`select[name=${name}]`)!.value;

  function eligibility(option: HTMLInputElement) {
    if (!option.checked) return "Excluded by filter";
    const [resource, operation] = option.value.split(":");
    const create = operation === "create";
    const grant = selected("grant");
    if (grant === "none" || (create && grant !== "write")) {
      return create ? "Needs a Write grant" : "Needs a Read or Write grant";
    }
    const permission = selected(resource!);
    if (permission === "none" || (create && permission !== "write")) {
      return `Needs ${resource === "issues" ? "Issues" : "Pull requests"} ${create ? "write" : "read or write"} permission`;
    }
    if (option.value === "pull_requests:create" && ungranted.checked) {
      return "Blocked. Another bound repository lacks a grant, even if set to Git only.";
    }
    return "Eligible";
  }

  function render() {
    const automatic = future.checked;
    const ids = options
      .filter((option) => option.checked !== automatic)
      .map((option) => option.value);
    const omit = automatic && !ids.length;
    const mode = automatic
      ? "New eligible actions are included on deployment."
      : ids.length
        ? "Future actions stay off until listed."
        : "Git only. Future actions stay off.";
    root.querySelector("[data-mode]")!.textContent = omit
      ? `Default. Omit apiActions or remove the existing filter. ${mode}`
      : `${mode} Add or replace only the apiActions field in the registration.`;
    const apiActions = automatic ? { deny: ids } : { allow: ids };
    root.querySelector("pre")!.hidden = omit;
    root.querySelector("code")!.textContent = omit ? "" : JSON.stringify({ apiActions }, null, 2);

    preview();
  }

  function preview() {
    for (const option of options) {
      const status = root.querySelector(`[data-action="${option.value}"] span`)!;
      const message = eligibility(option);
      if (status.textContent !== message) status.textContent = message;
    }
  }

  function preset(checked: boolean) {
    for (const option of [...options, future]) option.checked = checked;
    render();
  }

  root.querySelector("[data-git]")!.addEventListener("click", () => preset(false));
  root.querySelector("[data-reset]")!.addEventListener("click", () => preset(true));
  root.querySelector("fieldset")!.addEventListener("change", render);
  root.querySelector("details")!.addEventListener("change", preview);
  render();
}

for (const root of document.querySelectorAll<HTMLElement>("[data-repository-actions]")) mount(root);
