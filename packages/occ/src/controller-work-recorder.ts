import type { AsyncLocalStorage } from "node:async_hooks";

import type { PlatformOperation } from "./ports/platform-operations.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

export function createControllerWorkRecorder(
  request: Pick<AsyncLocalStorage<string>, "getStore" | "run">,
  recordOperations: boolean,
) {
  function withRequestAuditId<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    return request.run(requestId, work);
  }

  async function record(
    state: Pick<PlatformUnitOfWork, "operations">,
    operation: PlatformOperation,
  ): Promise<void> {
    if (recordOperations) {
      await state.operations.append(operation, request.getStore());
    }
  }

  return { withRequestAuditId, record };
}

export type ControllerWorkRecorder = ReturnType<typeof createControllerWorkRecorder>;
