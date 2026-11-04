/**
 * A Kubernetes resource name: a DNS subdomain of at most 253 characters.
 * The Compute driver applies this to Gateway names and Secret names.
 */
const KUBERNETES_RESOURCE_NAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function isKubernetesResourceName(value: string): boolean {
  return value.length <= 253 && KUBERNETES_RESOURCE_NAME.test(value);
}

/**
 * A Kubernetes Namespace name: a DNS-1123 label of at most 63 characters, with no dots.
 * The Compute driver applies this to the Gateway and Envoy namespaces and to every
 * NetworkPolicy peer namespace. The Gateway namespace is also written into the
 * gateway.envoyproxy.io/owning-gateway-namespace label value.
 */
const KUBERNETES_NAMESPACE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isKubernetesNamespaceName(value: string): boolean {
  return value.length <= 63 && KUBERNETES_NAMESPACE_NAME.test(value);
}
