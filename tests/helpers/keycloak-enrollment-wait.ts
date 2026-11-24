type Operation =
  | "close-console"
  | "close-ingress"
  | "close-context"
  | "prepare-installation"
  | "delete-realm-resource"
  | "configure-realm"
  | "query-users"
  | "serve-console"
  | "open-page"
  | "sign-in"
  | "wait-for-callback"
  | "wait-for-console";
type Wait = <T>(operation: Operation, promise: Promise<T>) => Promise<T>;

interface EnrollmentParent {
  signal: AbortSignal;
  diagnostic(message: string): void;
}

// Enrollment awaits each row and its hooks serially. Snapshot synchronously:
// Node can start cleanup while the cancelled body is still settling.
export function enrollmentWait(parent: EnrollmentParent): (row: number) => Wait {
  let active: { row: number; operation: Operation } | undefined;
  parent.signal.addEventListener(
    "abort",
    () => {
      if (active) {
        try {
          parent.diagnostic(
            "openclaw-ci-measurement " +
              JSON.stringify({
                kind: "keycloak-enrollment-interrupted",
                ...active,
              }),
          );
        } catch {
          // Optional reporting must preserve the original cancellation.
        }
      }
    },
    { once: true },
  );

  return (row) =>
    async <T>(operation: Operation, promise: Promise<T>): Promise<T> => {
      active = { row, operation };
      try {
        return await promise;
      } finally {
        active = undefined;
      }
    };
}
