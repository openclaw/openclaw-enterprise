// Example inputs never affect the registration fragment.
const actions = [
  ["issues:read", "Read issues"],
  ["issues:create", "Create issues"],
  ["pull_requests:read", "Read pull requests"],
  ["pull_requests:create", "Open pull requests"],
] as const;

function level(label: string, id: string) {
  return `<label>${label}<select aria-label="${label}" name="${id}">
    <option value="none">${id === "grant" ? "No access" : "None"}</option>
    <option value="read">${id === "grant" ? "Read-only" : "Read"}</option>
    <option value="write" selected>${id === "grant" ? "Contributor" : "Write"}</option>
  </select></label>`;
}

function mount(root: HTMLElement) {
  root.innerHTML = `
    <div class="access-title">
      <strong data-title aria-live="polite"></strong>
      <span data-recommended>Recommended</span>
      <button type="button" data-reset hidden>Reset filter</button>
    </div>
    <div class="access-scope">These actions depend on the Agent’s grant and approved Namespace and GitHub App permissions.</div>
    <dl>
      <div><dt>Git</dt><dd>Fetch and push</dd></div>
      <div><dt>Issues</dt><dd data-issues></dd></div>
      <div><dt>Pull requests</dt><dd data-pulls></dd></div>
    </dl>
    <div data-default>For full permitted access, omit <code>apiActions</code>, save <strong>Contributor</strong> (Write) for this repository and deploy.</div>
    <div data-mode hidden></div>
    <details data-advanced>
      <summary>Advanced <span>· Customize access</span></summary>
      <fieldset>
        <legend>API actions to keep</legend>
        <div class="action-options">
          ${actions.map(([id, label]) => `<label><input type="checkbox" value="${id}" checked>${label}</label>`).join("")}
        </div>
        <div class="action-presets">
          <label><input type="checkbox" name="future" checked>Include new eligible actions automatically</label>
          <button type="button" data-git>Git only</button>
        </div>
      </fieldset>
      <div data-config hidden>
        Add or replace only <code>apiActions</code> beside <code>permissions</code> in the repository’s <code>namespaces</code> entry, then redeploy. Git grants stay unchanged.
        <pre><code></code></pre>
      </div>
      <details data-example>
        <summary>Example at next deployment</summary>
        <div>This example assumes native delivery, matching GitHub permissions and no additional Agent restrictions. It reads no running policy.</div>
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
      <div class="action-limits">Issue lists can include pull requests. Creation returns the record even without read access. Opening a pull request can convert an issue. Creating an issue may link a parent in another repository.</div>
    </details>`;

  const advanced = root.querySelector<HTMLDetailsElement>("[data-advanced]")!;
  const reset = root.querySelector<HTMLButtonElement>("[data-reset]")!;
  const options = [...root.querySelectorAll<HTMLInputElement>(".action-options input")];
  const future = root.querySelector<HTMLInputElement>("[name=future]")!;
  const ungranted = root.querySelector<HTMLInputElement>("[name=ungranted]")!;
  const selected = (name: string) =>
    root.querySelector<HTMLSelectElement>(`select[name=${name}]`)!.value;

  function eligibility(option: HTMLInputElement) {
    if (!option.checked) {
      return "Excluded by filter";
    }
    const [resource, operation] = option.value.split(":");
    const create = operation === "create";
    const grant = selected("grant");
    if (grant === "none" || (create && grant !== "write")) {
      return create ? "Needs a Contributor grant" : "Needs a Read-only or Contributor grant";
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
    const gitOnly = !automatic && !ids.length;
    root.querySelector("[data-title]")!.textContent = omit
      ? "Contributor"
      : gitOnly
        ? "Git only"
        : "Custom access";
    reset.hidden = omit;
    root.querySelector<HTMLElement>("[data-recommended]")!.hidden = !omit;
    root.querySelector<HTMLElement>("[data-default]")!.hidden = !omit;

    const allowed = new Set(
      options.filter((option) => option.checked).map((option) => option.value),
    );
    function label(resource: string, verb: string) {
      const read = allowed.has(resource + ":read");
      if (allowed.has(resource + ":create")) {
        return read ? "Read and " + verb.toLowerCase() : verb;
      }
      return read ? "Read" : "None";
    }
    root.querySelector("[data-issues]")!.textContent = label("issues", "Create");
    root.querySelector("[data-pulls]")!.textContent = label("pull_requests", "Open");
    const mode = root.querySelector<HTMLElement>("[data-mode]")!;
    mode.hidden = omit;
    mode.textContent =
      (automatic ? "New eligible actions are included." : "Future actions stay off.") +
      " See Advanced for the registry change.";

    const apiActions = automatic ? { deny: ids } : { allow: ids };
    root.querySelector<HTMLElement>("[data-config]")!.hidden = omit;
    root.querySelector("pre code")!.textContent = omit
      ? ""
      : JSON.stringify({ apiActions }, null, 2);

    preview();
  }

  function preview() {
    for (const option of options) {
      const status = root.querySelector(`[data-action="${option.value}"] span`)!;
      const message = eligibility(option);
      if (status.textContent !== message) {
        status.textContent = message;
      }
    }
  }

  function preset(checked: boolean) {
    for (const option of [...options, future]) {
      option.checked = checked;
    }
    render();
  }

  root.querySelector("[data-git]")!.addEventListener("click", () => preset(false));
  reset.addEventListener("click", () => {
    preset(true);
    advanced.open = false;
    advanced.querySelector("summary")!.focus();
  });
  root.querySelector("fieldset")!.addEventListener("change", render);
  root.querySelector("[data-example]")!.addEventListener("change", preview);
  render();
}

for (const root of document.querySelectorAll<HTMLElement>("[data-repository-actions]")) {
  mount(root);
}
