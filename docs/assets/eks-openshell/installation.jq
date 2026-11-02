{
  "occ": {
    "cluster": $cluster
  },
  "backend": [
    {
      "id": "openshell",
      "type": "openshell",
      "configuration": {
        "endpoint": "https://openshell-gateway.oce-system.svc:8080",
        "rootCertificatePath": "/etc/openclaw/openshell/ca.crt",
        "requestTimeoutMs": 30000,
        "auth": {
          "mode": "mtls",
          "certificatePath": "/etc/openclaw/openshell/tls.crt",
          "privateKeyPath": "/etc/openclaw/openshell/tls.key"
        }
      },
      "drivers": {
        "sandbox": "openshell-sandbox",
        "credential_gateway": "openshell-credentials"
      }
    }
  ],
  "presets": {
    "includeDefaults": true
  },
  "drivers": {
    "plugin": {
      "id": "codex-plugin",
      "configuration": {
        "catalogSource": "openai-curated"
      }
    },
    "configuration": {
      "id": "config-kubernetes",
      "configuration": {
        "authentication": {
          "mode": "inCluster"
        }
      }
    },
    "iam": {
      "id": "native-iam",
      "configuration": {}
    },
    "compute": {
      "id": "compute-kubernetes",
      "configuration": {
        "authentication": {
          "mode": "inCluster"
        },
        "images": {
          "gateway": $runtime,
          "agent": $runtime,
          "requireImmutableDigest": true
        },
        "resources": {
          "gateway": {
            "requests": {
              "cpu": "100m",
              "memory": "2560Mi"
            },
            "limits": {
              "cpu": "4",
              "memory": "4Gi"
            }
          },
          "agent": {
            "requests": {
              "cpu": "100m",
              "memory": "768Mi"
            },
            "limits": {
              "cpu": "4",
              "memory": "6Gi"
            }
          },
          "namespace": {
            "quota": {
              "pods": "10"
            },
            "containerDefaults": {
              "requests": {
                "cpu": "100m",
                "memory": "128Mi"
              },
              "limits": {
                "cpu": "4",
                "memory": "2Gi"
              }
            }
          }
        },
        "network": {
          "dns": {
            "namespace": "kube-system",
            "podLabels": {
              "k8s-app": "kube-dns"
            }
          },
          "gatewayPort": 8080,
          "gatewayTrustedProxyCidrs": $proxyCidrs,
          "providerHarness": {
            "namespace": "oce-system",
            "podLabels": {
              "app.kubernetes.io/name": "openshell",
              "app.kubernetes.io/instance": "openshell-gateway"
            },
            "address": $openshellIP,
            "port": 8080
          }
        },
        "gatewayRouting": {
          "gatewayName": "oce-agent-gateways",
          "gatewayNamespace": "oce-system",
          "envoyNamespace": "envoy-gateway-system",
          "hostname": $hostname
        },
        "servicePrincipalCredentials": {
          "mode": "disabled"
        },
        "runtime": {
          "gatewayStorageClassName": "encrypted-gp3",
          "nativeOpenClawSessionCapacity": 8,
          "nodeSelector": {
            "oce-role": "agents"
          },
          "gatewayNodeSelector": {
            "oce-role": "control"
          },
          "transportSecretPrefix": "openclaw-agent-transport"
        }
      }
    },
    "secret": {
      "id": "secret-kubernetes",
      "configuration": {
        "authentication": {
          "mode": "inCluster"
        }
      }
    },
    "sandbox": {
      "id": "openshell-sandbox",
      "configuration": {
        "gateway": {
          "workspaceMode": "operator",
          "operatorNamespaceLabels": {
            "openshell.ai/openclaw-workspace": "true"
          },
          "operatorWorkspaceResources": [
            {
              "apiVersion": "networking.k8s.io/v1",
              "kind": "NetworkPolicy",
              "metadata": {
                "labels": {
                  "helm.sh/chart": "openshell-workspace-0.1.6",
                  "app.kubernetes.io/name": "openshell-workspace",
                  "app.kubernetes.io/instance": "openshell-workspace",
                  "app.kubernetes.io/version": "0.1.6",
                  "app.kubernetes.io/managed-by": "Helm"
                },
                "name": "openshell-workspace-sandbox-ssh"
              },
              "spec": {
                "ingress": [
                  {
                    "_from": [
                      {
                        "namespaceSelector": {
                          "matchLabels": {
                            "kubernetes.io/metadata.name": "oce-system"
                          }
                        },
                        "podSelector": {
                          "matchLabels": {
                            "app.kubernetes.io/instance": "openshell-gateway",
                            "app.kubernetes.io/name": "openshell"
                          }
                        }
                      }
                    ],
                    "ports": [
                      {
                        "port": 2222,
                        "protocol": "TCP"
                      }
                    ]
                  }
                ],
                "podSelector": {
                  "matchLabels": {
                    "openshell.ai/managed-by": "openshell"
                  }
                },
                "policyTypes": [
                  "Ingress"
                ]
              }
            },
            {
              "apiVersion": "v1",
              "kind": "ServiceAccount",
              "metadata": {
                "labels": {
                  "helm.sh/chart": "openshell-workspace-0.1.6",
                  "app.kubernetes.io/name": "openshell-workspace",
                  "app.kubernetes.io/instance": "openshell-workspace",
                  "app.kubernetes.io/version": "0.1.6",
                  "app.kubernetes.io/managed-by": "Helm"
                },
                "name": "openshell-sandbox"
              }
            },
            {
              "apiVersion": "rbac.authorization.k8s.io/v1",
              "kind": "Role",
              "metadata": {
                "labels": {
                  "helm.sh/chart": "openshell-workspace-0.1.6",
                  "app.kubernetes.io/name": "openshell-workspace",
                  "app.kubernetes.io/instance": "openshell-workspace",
                  "app.kubernetes.io/version": "0.1.6",
                  "app.kubernetes.io/managed-by": "Helm"
                },
                "name": "openshell-workspace-sandbox"
              },
              "rules": [
                {
                  "apiGroups": [
                    ""
                  ],
                  "resources": [
                    "persistentvolumeclaims"
                  ],
                  "verbs": [
                    "get"
                  ]
                },
                {
                  "apiGroups": [
                    "agents.x-k8s.io"
                  ],
                  "resources": [
                    "sandboxes",
                    "sandboxes/status"
                  ],
                  "verbs": [
                    "create",
                    "delete",
                    "get",
                    "list",
                    "patch",
                    "update",
                    "watch"
                  ]
                },
                {
                  "apiGroups": [
                    ""
                  ],
                  "resources": [
                    "events"
                  ],
                  "verbs": [
                    "get",
                    "list",
                    "watch"
                  ]
                },
                {
                  "apiGroups": [
                    ""
                  ],
                  "resources": [
                    "pods"
                  ],
                  "verbs": [
                    "get"
                  ]
                },
                {
                  "apiGroups": [
                    ""
                  ],
                  "resources": [
                    "secrets"
                  ],
                  "verbs": [
                    "create",
                    "delete"
                  ]
                }
              ]
            },
            {
              "apiVersion": "rbac.authorization.k8s.io/v1",
              "kind": "RoleBinding",
              "metadata": {
                "labels": {
                  "helm.sh/chart": "openshell-workspace-0.1.6",
                  "app.kubernetes.io/name": "openshell-workspace",
                  "app.kubernetes.io/instance": "openshell-workspace",
                  "app.kubernetes.io/version": "0.1.6",
                  "app.kubernetes.io/managed-by": "Helm"
                },
                "name": "openshell-workspace-sandbox"
              },
              "roleRef": {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": "Role",
                "name": "openshell-workspace-sandbox"
              },
              "subjects": [
                {
                  "kind": "ServiceAccount",
                  "name": "openshell-gateway",
                  "namespace": "oce-system"
                }
              ]
            }
          ],
          "networkPolicyResources": [
            {
              "apiVersion": "networking.k8s.io/v1",
              "kind": "NetworkPolicy",
              "metadata": {
                "name": "allow-openshell-sandbox-callback"
              },
              "spec": {
                "podSelector": {
                  "matchLabels": {
                    "openshell.ai/managed-by": "openshell",
                    "openshell.ai/boundary-role": "supervisor"
                  }
                },
                "policyTypes": [
                  "Egress"
                ],
                "egress": [
                  {
                    "to": [
                      {
                        "namespaceSelector": {
                          "matchLabels": {
                            "kubernetes.io/metadata.name": "oce-system"
                          }
                        },
                        "podSelector": {
                          "matchLabels": {
                            "app.kubernetes.io/name": "openshell",
                            "app.kubernetes.io/instance": "openshell-gateway"
                          }
                        }
                      }
                    ],
                    "ports": [
                      {
                        "protocol": "TCP",
                        "port": 8080
                      }
                    ]
                  }
                ]
              }
            }
          ]
        },
        "kubernetes": {
          "runtimeClassName": "openshell-sandbox",
          "userNamespaces": false,
          "agentResources": {
            "requests": {
              "cpu": "100m",
              "memory": "768Mi"
            },
            "limits": {
              "cpu": "4",
              "memory": "6Gi"
            }
          },
          "serviceAccount": {
            "mode": "gatewayConfigured"
          },
          "sandboxDataMount": {
            "subPath": "workspace",
            "mountPath": "/sandbox/enterprise",
            "readOnly": false
          }
        },
        "policy": {
          "process": {
            "runAsUser": "10001",
            "runAsGroup": "10001"
          },
          "codexArtifactRuleNames": [
            "codex-plugin-artifacts"
          ],
          "networkPolicies": [
            {
              "name": "codex-plugin-artifacts",
              "binaries": [
                {
                  "path": "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex"
                },
                {
                  "path": "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex"
                }
              ],
              "endpoints": [
                {
                  "host": "sdmntprsouthcentralus.oaiusercontent.com",
                  "ports": [
                    443
                  ],
                  "protocol": "rest",
                  "enforcement": "enforce",
                  "access": "read_only"
                },
                {
                  "host": "sdmntprwestcentralus.oaiusercontent.com",
                  "ports": [
                    443
                  ],
                  "protocol": "rest",
                  "enforcement": "enforce",
                  "access": "read_only"
                },
                {
                  "host": "sdmntprcentralus.oaiusercontent.com",
                  "ports": [
                    443
                  ],
                  "protocol": "rest",
                  "enforcement": "enforce",
                  "access": "read_only"
                },
                {
                  "host": "sdmntprwestus.oaiusercontent.com",
                  "ports": [
                    443
                  ],
                  "protocol": "rest",
                  "enforcement": "enforce",
                  "access": "read_only"
                },
                {
                  "host": "sdmntprbrazilsouth.oaiusercontent.com",
                  "ports": [
                    443
                  ],
                  "protocol": "rest",
                  "enforcement": "enforce",
                  "access": "read_only"
                },
                {
                  "host": "sdmntprwestus2.oaiusercontent.com",
                  "ports": [
                    443
                  ],
                  "protocol": "rest",
                  "enforcement": "enforce",
                  "access": "read_only"
                }
              ]
            }
          ]
        },
        "sandboxNamePrefix": "os"
      }
    },
    "credential_gateway": {
      "id": "openshell-credentials",
      "configuration": {
        "binaries": [
          "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
          "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex",
          "/usr/local/bin/node"
        ]
      }
    }
  }
}
