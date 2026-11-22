export function qaHybridRoutingValues({
  controllerChartImage,
  consoleUrl,
  adminEmail,
  databaseIp,
  nodeIp,
  nodeName,
  agentNativeAdminDomain,
}: {
  controllerChartImage: string;
  consoleUrl: string;
  adminEmail: string;
  databaseIp: string;
  nodeIp: string;
  nodeName: string;
  agentNativeAdminDomain: string | undefined;
}) {
  const remoteNodeCidrs: string[] = [];
  return {
    images: { controller: controllerChartImage },
    auth: { baseUrl: consoleUrl },
    // This routing-only render creates no initializer or credential projection.
    bootstrap: {
      adminEmail,
      credentials: { secretName: "bootstrap-credentials" },
    },
    api: {
      clients: [
        { namespace: "envoy-gateway-system", podLabels: { "app.kubernetes.io/name": "envoy" } },
      ],
    },
    database: { cidrs: [`${databaseIp}/32`] },
    cluster: { cidrs: [`${nodeIp}/32`], port: 6443 },
    agentNativeAdmin: {
      enabled: false,
      domain: agentNativeAdminDomain,
    },
    // Helm validates the whole chart even when we render only workspace routing.
    channelEgress: { enabled: false },
    gatewayRouting: {
      enabled: true,
      gatewayClassName: "eg",
      gatewayName: "openclaw-enterprise-agent-gateways",
      hostname: nodeName,
      serviceType: "NodePort",
      apiKeySecretName: "occ-private-gateway-key",
      remoteNodeCidrs,
    },
  };
}
