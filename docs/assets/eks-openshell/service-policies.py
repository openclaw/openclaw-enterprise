"""Render the strict-CNI service peers for the EKS OpenShell example as a Kubernetes List."""
import argparse
import hashlib
import json
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--tenant", required=True)
parser.add_argument("--namespace-id", required=True)
parser.add_argument("--agent-id")
args = parser.parse_args()
system = "oce-system"
envoy = "envoy-gateway-system"
items = []


def resource(namespace, kind, name):
    return json.loads(subprocess.check_output(
        ["kubectl", "-n", namespace, "get", kind, name, "-o", "json"], text=True
    ))


def peer(namespace, labels):
    if not labels:
        raise ValueError("A concrete Pod selector is required")
    return {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": namespace}},
            "podSelector": {"matchLabels": labels}}


def port(number):
    return {"protocol": "TCP", "port": number}


def service_edges(namespace, service, number):
    spec = service["spec"]
    target, = [p["targetPort"] for p in spec["ports"] if p["port"] == number]
    return [{"to": [{"ipBlock": {"cidr": spec["clusterIP"] + "/32"}}], "ports": [port(number)]},
            {"to": [peer(namespace, spec["selector"])], "ports": [port(target)]}]


def policy(namespace, name, selector, direction, rules):
    items.append({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
                  "metadata": {"name": name, "namespace": namespace},
                  "spec": {"podSelector": selector, "policyTypes": [direction.title()], direction: rules}})


tenant = resource(args.tenant, "namespace", args.tenant)
if tenant["metadata"]["labels"].get("openclaw.dev/namespace") != args.namespace_id:
    raise ValueError("Namespace ownership does not match")
management = resource(system, "service", "openshell-gateway")
management_selector = {"matchLabels": management["spec"]["selector"]}
hook = service_edges(system, resource(system, "service", "openclaw-enterprise-openshell-git"), 8445)
private = resource(envoy, "service", "occ-gateway-362888b35fce")
proxy = {"matchLabels": private["spec"]["selector"]}
controller = resource(envoy, "service", "envoy-gateway")
api = resource(system, "service", "openclaw-enterprise-api")
supervisor = {"matchLabels": {"openshell.ai/boundary-role": "supervisor", "openshell.ai/managed-by": "openshell"}}
policy(system, "oce-hook-sender", management_selector, "egress", hook)
policy(args.tenant, "oce-supervisor-services", supervisor, "egress",
       hook + service_edges(envoy, private, 443) + service_edges(system, management, 8080))
policy(envoy, "oce-proxy-control", proxy, "egress", service_edges(envoy, controller, 18000))
policy(envoy, "oce-control-from-proxy", {"matchLabels": controller["spec"]["selector"]}, "ingress",
       [{"from": [peer(envoy, private["spec"]["selector"])], "ports": [port(18000)]}])
policy(system, "oce-api-private-route", {"matchLabels": api["spec"]["selector"]}, "egress",
       service_edges(envoy, private, 443))
policy(envoy, "oce-private-route-from-api", proxy, "ingress",
       [{"from": [peer(system, api["spec"]["selector"])], "ports": [port(10443)]}])
dns = resource("kube-system", "service", "kube-dns")["spec"]["clusterIP"]
dns_rule = [{"to": [{"ipBlock": {"cidr": dns + "/32"}}],
             "ports": [{"port": 53, "protocol": p} for p in ["UDP", "TCP"]]}]
policy(envoy, "oce-proxy-dns-vip", proxy, "egress", dns_rule)
if args.agent_id:
    suffix = hashlib.sha256(args.agent_id.encode()).hexdigest()[:12]
    gateway = resource(args.tenant, "service", "gateway-" + suffix)
    labels = gateway["spec"]["selector"]
    if labels.get("openclaw.dev/agent") != args.agent_id:
        raise ValueError("Gateway ownership does not match")
    gateway_peer = peer(args.tenant, labels)
    policy(args.tenant, "oce-gateway-management-" + suffix, gateway_peer["podSelector"],
           "egress", service_edges(system, management, 8080))
    policy(system, "oce-management-from-" + suffix, management_selector, "ingress",
           [{"from": [gateway_peer], "ports": [port(8080)]}])
    policy(envoy, "oce-proxy-to-" + suffix, proxy, "egress", service_edges(args.tenant, gateway, 8080))
    dns_selector = resource(args.tenant, "networkpolicy", "allow-dns")["spec"]["podSelector"]
    policy(args.tenant, "oce-tenant-dns-service-vip", dns_selector, "egress", dns_rule)
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}, indent=2))
