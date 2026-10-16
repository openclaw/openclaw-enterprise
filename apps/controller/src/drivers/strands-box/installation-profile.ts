import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { observePinnedStrandsContainer } from "./pinned-container.ts";
import type { ExecutionKubernetes } from "./kubernetes.ts";

const registration = "oce-strands-installation-0";
const profile = "strands-credential-proxy-v1";
// Required by this controller, independent of the capabilities the installed binary was built to support.
const required = [
  "execution-policy-and-sender-proof-v1",
  "signed-credential-proxy-exchange-v1",
  "final-send-and-response-custody-v1",
  "explicit-no-material-v1",
  "warm-repository-metadata-v1",
  "dogwood-private-attempt-history-v1",
];

/**
 * Negotiate with the actual sender binary installed by the operator in the trusted platform namespace.
 * The authenticated execution API binds Pod, image, UID and proxy destination. No bearer, execution key,
 * provider material, or workload input crosses this endpoint. This is live compatibility, not a release or lease.
 */
export async function assertStrandsInstallationProfile(
  kube: Pick<ExecutionKubernetes, "path" | "read" | "text">,
  {
    installationNamespace: ns,
    gatewayImage,
  }: { installationNamespace: string; gatewayImage: string },
  signal: AbortSignal,
): Promise<void> {
  const unavailable = () =>
    new DependencyUnavailableError(
      "The selected Strands installation has no compatible live Credential Proxy profile.",
    );
  async function observe() {
    const pod = await kube.read(ns, "Pod", registration, signal);
    const spec = pod?.spec;
    const [container, extra] = Array.isArray(spec?.containers) ? spec.containers : [];
    if (
      pod?.metadata.name !== registration ||
      pod?.metadata.namespace !== ns ||
      spec?.automountServiceAccountToken !== false ||
      spec.volumes ||
      spec.initContainers ||
      spec.ephemeralContainers ||
      !container ||
      extra ||
      container.name !== "installation" ||
      container.image !== gatewayImage ||
      container.command ||
      container.envFrom ||
      container.volumeMounts ||
      !isDeepStrictEqual(container.args, ["--installation-profile"]) ||
      !isDeepStrictEqual(container.env, [
        {
          name: "OCE_INSTALLATION_POD_UID",
          valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: "metadata.uid" } },
        },
      ])
    ) {
      throw unavailable();
    }
    return pod;
  }
  try {
    const proof = await observePinnedStrandsContainer(
      observe,
      "installation",
      gatewayImage,
      async (running) => {
        const challenge = randomBytes(32).toString("hex");
        const path =
          kube.path(ns, "Pod", registration + ":8081") +
          "/proxy/profile/" +
          profile +
          "?challenge=" +
          challenge;
        const response = await kube.text(path, signal);
        const peer = JSON.parse(response.text);
        // Both sides select this exact protocol/profile. The binary derives its UID from the downward API,
        // and sends its own required/supported sets, never capability strings supplied by the controller.
        if (
          response.status !== 200 ||
          peer.podUid !== running.podUid ||
          peer.challenge !== challenge ||
          peer.protocolMajor !== 1 ||
          peer.profile !== profile ||
          !Array.isArray(peer.supported) ||
          !required.every((cap) => peer.supported.includes(cap)) ||
          !Array.isArray(peer.required) ||
          !peer.required.length ||
          !peer.required.every((cap: string) => required.includes(cap)) ||
          !required.every((cap) => peer.required.includes(cap))
        ) {
          throw unavailable();
        }
        return true;
      },
    );
    if (!proof) {
      throw unavailable();
    }
  } catch {
    signal.throwIfAborted();
    throw unavailable();
  }
}
