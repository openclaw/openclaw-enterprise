import type { RuntimeDiagnosticCheck } from "@openclaw-enterprise/contracts";

type Container = "agent" | "gateway";

export async function collectDeploymentChecks({
  containers,
  deadline,
  ownerSignal,
  readChecks,
  readHeldFailure,
}: {
  readonly containers: readonly Container[];
  readonly deadline: AbortSignal;
  readonly ownerSignal: AbortSignal | undefined;
  readonly readChecks: (
    container: Container,
  ) => Promise<readonly RuntimeDiagnosticCheck[] | undefined>;
  readonly readHeldFailure: (container: Container) => Promise<RuntimeDiagnosticCheck | undefined>;
}): Promise<RuntimeDiagnosticCheck[]> {
  function observe<T>(read: Promise<T>, source: "diagnostics" | "startup"): Promise<T | undefined> {
    return read.catch((error: unknown) => {
      ownerSignal?.throwIfAborted();
      // Startup evidence is supplementary. At the collection deadline, let the Gateway
      // diagnostics read finish classifying its own transport before choosing an error.
      if (source === "startup" || (deadline.aborted && error === deadline.reason)) {
        return undefined;
      }
      throw error;
    });
  }

  const reports = await Promise.all(
    containers.map(async (component) => {
      const [checks, held] = await Promise.all([
        observe(readChecks(component), "diagnostics"),
        observe(readHeldFailure(component), "startup"),
      ]);
      return { component, checks, held };
    }),
  );
  deadline.throwIfAborted();

  // A held startup failure must survive the cap even when channel checks fill the report.
  const held = reports.flatMap((report) => (report.held === undefined ? [] : [report.held]));
  const checks = reports.flatMap(
    ({ component, checks }) =>
      checks ?? [
        {
          component,
          check: "runtime-status",
          state: "unknown",
          checkedAt: null,
          code: "UNAVAILABLE",
        } satisfies RuntimeDiagnosticCheck,
      ],
  );
  return [...held, ...checks].slice(0, 32);
}
