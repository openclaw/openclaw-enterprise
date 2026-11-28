import { button, element, validateFields } from "./dom.mjs";

// The API credential material rule is UTF-8 without NUL, at most 65,536 bytes. An empty
// value is reported by the control's required check.
export const CREDENTIAL_VALUE_MAX_BYTES = 65536;

/**
 * Why the API would refuse `value` as credential material, or "" when it would accept it. An empty
 * value is the required check's to report. The console sends the value as the browser reports
 * it: a textarea's line endings are normalized to LF.
 */
export function credentialValueProblem(value: string) {
  if (value.includes("\0") || /\p{Cs}/u.test(value)) {
    return "Use valid UTF-8 without NUL characters.";
  }
  if (new TextEncoder().encode(value).length > CREDENTIAL_VALUE_MAX_BYTES) {
    return "Use at most 65,536 UTF-8 bytes.";
  }
  return "";
}

/**
 * A masked credential value control and its Show value toggle. Put `reveal` just before `value` in a
 * `.secret-value-field`. A textarea keeps multiline credential material, with CRLF as LF. Browsers
 * without masking support get a native password field that refuses a line-break paste rather
 * than dropping its line breaks. Each edit checks the value against the API's rule.
 */
export function credentialValueControl(id: string, attributes: Record<string, string> = {}) {
  const multiline = CSS.supports("-webkit-text-security", "disc");
  const value = element(multiline ? "textarea" : "input", {
    id,
    required: true,
    autocomplete: "off",
    spellcheck: "false",
    className: "secret-value secret-value--masked",
    "data-secret-value": "",
    ...attributes,
    ...(multiline ? { rows: "3" } : { type: "password" }),
  });
  value.addEventListener("input", () =>
    value.setCustomValidity(credentialValueProblem(value.value)),
  );
  if (value instanceof HTMLInputElement) {
    value.addEventListener("paste", (event) => {
      if (/[\r\n]/.test(event.clipboardData?.getData("text") ?? "")) {
        event.preventDefault();
        value.setCustomValidity(
          "This browser cannot mask multiline values. Use a browser with multiline masking support.",
        );
        validateFields([value]);
      }
    });
  }
  const reveal = button(
    "Show value",
    () => setMasked(!value.classList.contains("secret-value--masked")),
    { tone: "ghost", size: "sm", "aria-pressed": "false", "aria-controls": id },
  );
  function setMasked(masked: boolean) {
    value.classList.toggle("secret-value--masked", masked);
    if (value instanceof HTMLInputElement) {
      value.type = masked ? "password" : "text";
    }
    reveal.textContent = masked ? "Show value" : "Hide value";
    reveal.setAttribute("aria-pressed", String(!masked));
  }
  function reset() {
    value.value = "";
    value.setCustomValidity("");
    setMasked(true);
  }
  return { value, reveal, multiline, reset };
}
