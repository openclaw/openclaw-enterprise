"""Render the strict-CNI service peers for the OpenShell quickstart as a Kubernetes List."""
import argparse
import hashlib
import ipaddress
import json
import os
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--tenant", required=True)
parser.add_argument("--namespace-id", required=True)
parser.add_argument("--agent-id")
parser.add_argument("--repository-credentials", action="store_true")
args = parser.parse_args()
system = "oce-system"
envoy = "envoy-gateway-system"
items = []


def resource(namespace, kind, *selection):
    return json.loads(subprocess.check_output(
        ["kubectl", "--kubeconfig", os.environ["KUBECONFIG"], "--context", os.environ["CONTEXT"], "-n", namespace, "get", kind, *selection, "-o", "json"], text=True
    ))


def peer(namespace, labels):
    if not labels:
        raise ValueError("A concrete Pod selector is required")
    return {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": namespace}},
            "podSelector": {"matchLabels": labels}}


def tenant_peer(labels):
    selected = peer(args.tenant, labels)
    selected["namespaceSelector"]["matchLabels"]["openclaw.dev/namespace"] = args.namespace_id
    return selected


def port(number):
    return {"protocol": "TCP", "port": number}


def service_edges(namespace, service, number):
    spec = service["spec"]
    target, = [p["targetPort"] for p in spec["ports"] if p["port"] == number]
    return [{"to": [{"ipBlock": {"cidr": spec["clusterIP"] + "/32"}}], "ports": [port(number)]},
            {"to": [peer(namespace, spec["selector"])], "ports": [port(target)]}]


def api_edges():
    service = resource("default", "service", "kubernetes")["spec"]
    https, = [p for p in service["ports"] if p["port"] == 443 and p["protocol"] == "TCP"]
    slices = resource("default", "endpointslices", "-l", "kubernetes.io/service-name=kubernetes")
    backends = []
    for endpoint_slice in slices["items"]:
        ready = [endpoint for endpoint in endpoint_slice["endpoints"]
                 if endpoint.get("conditions", {}).get("ready") is not False]
        if not ready:
            continue
        target, = [p["port"] for p in endpoint_slice["ports"]
                   if p.get("name") == https.get("name") and p.get("protocol", "TCP") == "TCP"]
        if not isinstance(target, int) or not 1 <= target <= 65535:
            raise ValueError("The Kubernetes API endpoint must declare its TCP port")
        for endpoint in ready:
            for address in endpoint["addresses"]:
                ip = ipaddress.ip_address(address)
                backends.append({"to": [{"ipBlock": {"cidr": f"{ip}/{ip.max_prefixlen}"}}],
                                 "ports": [port(target)]})
    if not backends:
        print("No ready Kubernetes API endpoint was found; rendering only the API Service grant. "
              "Check endpoint readiness before retrying reconciliation.", file=sys.stderr)
    return [{"to": [{"ipBlock": {"cidr": service["clusterIP"] + "/32"}}],
             "ports": [port(443)]}] + backends


def policy(namespace, name, selector, direction, rules):
    items.append({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
                  "metadata": {"name": name, "namespace": namespace},
                  "spec": {"podSelector": selector, "policyTypes": [direction.title()], direction: rules}})


tenant = resource(args.tenant, "namespace", args.tenant)
if tenant["metadata"]["labels"].get("openclaw.dev/namespace") != args.namespace_id:
    raise ValueError("Namespace ownership does not match")
management = resource(system, "service", "openshell-gateway")
management_selector = {"matchLabels": management["spec"]["selector"]}
hook = service_edges(system, resource(system, "service", "openclaw-enterprise-openshell-git"), 8445) if args.repository_credentials else []
private = resource(envoy, "service", "occ-gateway-362888b35fce")
proxy = {"matchLabels": private["spec"]["selector"]}
controller = resource(envoy, "service", "envoy-gateway")
api = resource(system, "service", "openclaw-enterprise-api")
supervisor = {"matchLabels": {"openshell.ai/boundary-role": "supervisor", "openshell.ai/managed-by": "openshell"}}
# Agent ingress isolates the management Pods, so preserve their other callers too.
controller_peer = peer(system, {key: value for key, value in api["spec"]["selector"].items()
                                if key != "app.kubernetes.io/component"})
controller_peer["podSelector"]["matchExpressions"] = [
    {"key": "app.kubernetes.io/component", "operator": "In", "values": ["api", "worker"]}]
policy(system, "oce-management-from-controller", management_selector, "ingress",
       [{"from": [controller_peer], "ports": [port(8080)]}])
# Each tenant retains its own grant when another tenant's policies are applied.
tenant_suffix = hashlib.sha256(args.namespace_id.encode()).hexdigest()[:12]
policy(system, "oce-management-from-supervisors-" + tenant_suffix, management_selector, "ingress",
       [{"from": [tenant_peer(supervisor["matchLabels"])], "ports": [port(8080)]}])
policy(args.tenant, "oce-supervisor-services", supervisor, "egress",
       hook + service_edges(envoy, private, 443) + service_edges(system, management, 8080))
policy(envoy, "oce-proxy-control", proxy, "egress", service_edges(envoy, controller, 18000))
policy(envoy, "oce-control-from-proxy", {"matchLabels": controller["spec"]["selector"]}, "ingress",
       [{"from": [peer(envoy, private["spec"]["selector"])], "ports": [port(18000)]}])
policy(system, "oce-api-private-route", {"matchLabels": api["spec"]["selector"]}, "egress",
       service_edges(envoy, private, 443))
policy(envoy, "oce-private-route-from-api", proxy, "ingress",
       [{"from": [peer(system, api["spec"]["selector"])], "ports": [port(10443)]}])
dns_service = resource("kube-system", "service", "kube-dns")["spec"]
dns = dns_service["clusterIP"]
dns_rule = [{"to": [{"ipBlock": {"cidr": dns + "/32"}}],
             "ports": [{"port": 53, "protocol": p} for p in ["UDP", "TCP"]]}]
if hook:
    # This is the Gateway's first egress policy: retain DNS and Kubernetes reconciliation.
    dns_ports = [{"port": p["targetPort"], "protocol": p["protocol"]}
                 for p in dns_service["ports"] if p["port"] == 53 and p["protocol"] in ["UDP", "TCP"]]
    if {p["protocol"] for p in dns_ports} != {"UDP", "TCP"}:
        raise ValueError("The DNS Service must expose both UDP and TCP port 53")
    dns_backends = [{"to": [peer("kube-system", dns_service["selector"])], "ports": dns_ports}]
    policy(system, "oce-hook-sender", management_selector, "egress",
           hook + dns_rule + dns_backends + api_edges())
policy(envoy, "oce-proxy-dns-vip", proxy, "egress", dns_rule)
if args.agent_id:
    suffix = hashlib.sha256(args.agent_id.encode()).hexdigest()[:12]
    gateway = resource(args.tenant, "service", "gateway-" + suffix)
    labels = gateway["spec"]["selector"]
    if labels.get("openclaw.dev/agent") != args.agent_id:
        raise ValueError("Gateway ownership does not match")
    gateway_peer = tenant_peer(labels)
    policy(args.tenant, "oce-gateway-management-" + suffix, gateway_peer["podSelector"],
           "egress", service_edges(system, management, 8080))
    policy(system, "oce-management-from-" + suffix, management_selector, "ingress",
           [{"from": [gateway_peer], "ports": [port(8080)]}])
    policy(envoy, "oce-proxy-to-" + suffix, proxy, "egress", service_edges(args.tenant, gateway, 8080))
    dns_selector = resource(args.tenant, "networkpolicy", "allow-dns")["spec"]["podSelector"]
    policy(args.tenant, "oce-tenant-dns-service-vip", dns_selector, "egress", dns_rule)
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}, indent=2))
