import { sha256Hex } from "@openclaw-enterprise/utils";

export function gatewayRoutingHostname(routing: {
  readonly hostname?: string;
  readonly gatewayName: string;
  readonly gatewayNamespace: string;
  readonly envoyNamespace: string;
}): string {
  if (routing.hostname !== undefined && routing.hostname.length > 0) {
    return routing.hostname;
  }
  return `occ-gateway-${sha256Hex(
    `${routing.gatewayNamespace}/${routing.gatewayName}`,
    12,
  )}.${routing.envoyNamespace}.svc`;
}
