import { createOpenShellOnlineGitAuthority } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts";
import { openShellOnlineWire } from "./openshell-online-wire.mjs";

// TLS and a fixture-signed identity, not an installed OpenShell sender.
export function openShellOnlineGitWire(t, options) {
  return openShellOnlineWire(
    t,
    options.registrationName ?? "online-git",
    options,
    createOpenShellOnlineGitAuthority,
  );
}
