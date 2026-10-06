/**
 * Whether the OpenClaw commit pinned in deploy/runtime/Dockerfile accepts the
 * configuration dedicated native OpenClaw writes: required worker placement
 * (`cloudWorkers.requiredProfile`) and native worker inference
 * (`nodeHost.workerRuns.nativeInferenceConfig`). The images-runtime-startup test
 * "runtime image validates the configuration dedicated native OpenClaw renders"
 * checks this value against the built image, so a pin that changes the answer
 * fails CI until this constant, the docs, and admission change with it.
 */
export const PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS: boolean = false;

/**
 * Operator declaration in the Installation startup file (`runtime.nativeWorkerSupport`)
 * that the configured runtime image was built from an OpenClaw source with native
 * worker support. No API or Agent Configuration field can set it.
 */
export type NativeWorkerSupport = "custom-image";

/** Where dedicated native OpenClaw support comes from, when it is available. */
export type NativeWorkerSupportSource = "pinned-runtime" | "custom-image";

export function nativeWorkerSupportSource(
  declared: NativeWorkerSupport | undefined,
): NativeWorkerSupportSource | undefined {
  if (PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS) {
    return "pinned-runtime";
  }
  return declared;
}
