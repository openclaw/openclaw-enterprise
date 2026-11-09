/** GitHub wire syntax only; this does not establish credential authority or scope. */
export function isGitHubWireCredential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 16384 &&
    !/[^\x21-\x7e]/.test(value)
  );
}
