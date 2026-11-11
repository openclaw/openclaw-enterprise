export function singleReplicaReadyDeploymentStatus(observedGeneration: number | undefined) {
  return {
    observedGeneration,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
  };
}

export function readyServiceEndpointSliceList(serviceName: string) {
  return {
    items: [
      {
        metadata: {
          labels: { "kubernetes.io/service-name": serviceName },
          ownerReferences: [{ kind: "Service", name: serviceName, uid: `${serviceName}-uid` }],
        },
        endpoints: [{ conditions: { ready: true } }],
      },
    ],
  };
}
