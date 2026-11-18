export async function runQaHttpChatWithCleanup<Handle>({
  verify,
  record,
  cleanupHandles,
  dispose,
}: {
  verify: () => Promise<void>;
  record: () => Promise<unknown>;
  cleanupHandles: readonly Handle[];
  dispose: (handle: Handle) => Promise<unknown>;
}): Promise<void> {
  let bodyFailure: { error: unknown } | undefined;
  try {
    await verify();
  } catch (error) {
    bodyFailure = { error };
  }

  // Verification can change which handles still need disposal.
  const finalizers = [record, ...cleanupHandles.map((handle) => () => dispose(handle))];
  const failures: unknown[] = [];
  for (const finalize of finalizers) {
    try {
      await finalize();
    } catch (error) {
      failures.push(error);
    }
  }

  if (bodyFailure !== undefined) {
    throw bodyFailure.error;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "QA HTTP chat finalization failed");
  }
}
