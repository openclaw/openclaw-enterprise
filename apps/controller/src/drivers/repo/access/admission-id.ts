export function admissionIdTimestamp(id: string): string | undefined {
  return /^([0-9]{13})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(
    id,
  )?.[1];
}
