/** Select only Driver-approved fields that were present in the accepted input. */
export function pickConfiguredFields<T extends object>(
  configuration: Readonly<T>,
  keys: readonly (keyof T & string)[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    keys.flatMap((key) => (configuration[key] === undefined ? [] : [[key, configuration[key]]])),
  );
}
