/**
 * Split a native model reference at its first slash. The model ID is everything after it
 * and may contain slashes itself; `id` is undefined when the reference has no slash.
 */
export function splitModelRef(reference: string): { provider: string; id: string | undefined } {
  const separator = reference.indexOf("/");
  return separator < 0
    ? { provider: reference, id: undefined }
    : { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
}
