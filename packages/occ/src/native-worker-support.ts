/**
 * Whether the OpenClaw commit pinned in deploy/runtime/Dockerfile is qualified for
 * the complete dedicated native OpenClaw flow: required worker placement
 * (`cloudWorkers.requiredProfile`), node enrollment, workspace access, and native
 * model execution from canonical `models.providers` configuration. No test derives
 * this value: tests/integration/runtime-image-startup.test.mjs only checks that the
 * image accepts the configuration native OpenClaw renders, and schema acceptance does
 * not qualify the flow. Flip it by hand, together with the assertion in
 * tests/conformance/configuration-occ.test.mjs and the native worker notes in
 * docs/reference/harness-execution.md and deploy/runtime/README.md.
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
