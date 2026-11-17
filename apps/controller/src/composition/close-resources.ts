/** Close composition-owned resources in dependency order, preserving the first failure. */
export async function closeResources(
  ...resources: readonly ({ close(): void | Promise<void> } | undefined)[]
): Promise<void> {
  let firstFailure: unknown;
  for (const resource of resources) {
    try {
      await resource?.close();
    } catch (error) {
      // Fastify treats falsey hook rejections as successful shutdown.
      firstFailure ??= error || new Error("Resource cleanup failed.", { cause: error });
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
}
