export function findResource<T extends { kind: string; metadata: { name: string } }>(
  objects: readonly T[],
  kind: string,
  name: string,
): T | undefined {
  return objects.find((object) => object.kind === kind && object.metadata.name === name);
}
