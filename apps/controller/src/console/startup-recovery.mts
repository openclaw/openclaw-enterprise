// An independent async classic script must never hold up the parser-created entry module.
(() => {
  const entry = document.getElementById("console-entry");
  if (!(entry instanceof HTMLScriptElement)) {
    return;
  }

  const failed = () => {
    const status = document.querySelector("#app > p.startup[role='status']");
    const recovery = document.querySelector("#app > .startup-recovery");
    const reload = recovery?.querySelector(":scope > button");
    const help = recovery?.querySelector(":scope > p");
    if (
      !(status instanceof HTMLParagraphElement) ||
      !(recovery instanceof HTMLDivElement) ||
      !(reload instanceof HTMLButtonElement) ||
      !(help instanceof HTMLParagraphElement) ||
      !reload.hidden
    ) {
      return;
    }
    reload.addEventListener("click", () => location.reload());
    status.textContent = "OpenClaw Enterprise could not load. Reload the page to try again.";
    help.hidden = true;
    reload.hidden = false;
  };

  entry.addEventListener("error", failed, { once: true });

  // The entry removes this marker synchronously before session reads. After window
  // load, a remaining marker catches a missed entry error without loading any module.
  if (document.readyState === "complete") {
    failed();
  } else {
    window.addEventListener("load", failed, { once: true });
  }
})();
