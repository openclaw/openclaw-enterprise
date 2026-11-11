import { createHash } from "node:crypto";
import type { OpenClawController, PostgresPool } from "@openclaw-enterprise/occ";
import type { InstallationStartupConfiguration } from "./installation-config.ts";

const gate = "occ.installation.ceiling-startup-ownership";
const live = "occ.installation.ceiling-startup-live";

/** Live API replicas agree on startup-managed rules. A changed configuration requires draining them. */
export async function acquireInstallationCeilingStartup(
  pool: PostgresPool,
  controller: OpenClawController,
  configuration:
    | Pick<
        InstallationStartupConfiguration,
        "sandboxNetworkPolicyCeiling" | "sandboxNetworkPolicyCeilingOverwriteOnStartup"
      >
    | undefined,
) {
  const client = await pool.connect();
  let lost = false;
  let released = false;
  const onError = () => {
    lost = true;
  };
  client.on?.("error", onError);
  // Console seeds have no runtime authority. Only startup-managed rules take part in agreement.
  const managed = configuration?.sandboxNetworkPolicyCeilingOverwriteOnStartup === true;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        managed
          ? {
              mode: "startup",
              rules: configuration?.sandboxNetworkPolicyCeiling?.map(
                ({ id, binary, host, ports }) => ({
                  id,
                  binary,
                  host,
                  ports: ports.map(({ from, to }) => ({ from, to })),
                }),
              ),
            }
          : { mode: "console" },
      ),
    )
    .digest("hex");
  const unlock = async () => {
    if (released) {
      return;
    }
    released = true;
    try {
      await client.query("SELECT pg_advisory_unlock_all()");
    } finally {
      client.removeListener?.("error", onError);
      client.release(lost);
    }
  };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gate]);
    const result = await client.query(
      "SELECT startup_configuration FROM occ.installation_network_policy_ceiling WHERE installation_id = $1",
      [controller.installation.id],
    );
    const same =
      (result.rows[0] as { startup_configuration?: string } | undefined)?.startup_configuration ===
      fingerprint;
    const locked = await client.query(
      same
        ? "SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0)) AS locked"
        : "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [live],
    );
    if ((locked.rows[0] as { locked?: boolean } | undefined)?.locked !== true) {
      throw new Error(
        "Conflicting Installation ceiling startup configuration. Stop existing API replicas before changing the startup management mode or rules.",
      );
    }
    await controller.initializeSandboxNetworkPolicyCeiling();
    await client.query(
      "UPDATE occ.installation_network_policy_ceiling SET startup_configuration = $2 WHERE installation_id = $1",
      [controller.installation.id, fingerprint],
    );
    if (!same) {
      // The startup gate prevents another API from entering between exclusive and shared holds.
      await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", [live]);
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [live]);
    }
    await client.query("COMMIT");
    return {
      async assertCurrent() {
        if (lost || released) {
          throw new Error(
            "Installation ceiling startup ownership was lost. Restart this API instance.",
          );
        }
        try {
          await client.query("SELECT 1");
        } catch {
          lost = true;
          throw new Error(
            "Installation ceiling startup ownership was lost. Restart this API instance.",
          );
        }
      },
      close: unlock,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      lost = true;
    });
    await unlock().catch(() => undefined);
    throw error;
  }
}
