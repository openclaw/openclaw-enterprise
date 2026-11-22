{
  "fullnameOverride": "openshell-gateway",
  "service": {
    "type": "ClusterIP"
  },
  "serviceAccount": {
    "name": "openshell-gateway"
  },
  "sandboxServiceAccount": {
    "name": "openshell-sandbox"
  },
  "workspaceResources": {
    "enabled": false
  },
  "nodeSelector": {
    "oce-role": "control"
  },
  "podSecurityContext": {
    "seccompProfile": {
      "type": "RuntimeDefault"
    }
  },
  "gateway": {
    "image": {
      "registry": $registry,
      "repository": $repository,
      "digest": "sha256:493cfd8a2697534e69b781755d4adbd54cab50eb39f0a564635f865da3cfcc57",
      "pullPolicy": "IfNotPresent"
    }
  },
  "sandboxRuntime": {
    "image": {
      "registry": $registry,
      "repository": $repository,
      "digest": "sha256:a22db0292463d7bbdbbac0bc16625c1d2fc60a1d86b77638169f9d6c11035920",
      "pullPolicy": "IfNotPresent"
    }
  },
  "supervisor": {
    "image": {
      "registry": $registry,
      "repository": $repository,
      "digest": "sha256:e93c39c4afe715ae5409b19d20cea74db767c51ac8cf1f92970d7925efe925e5",
      "pullPolicy": "IfNotPresent"
    }
  },
  "pkiInitJob": {
    "enabled": true,
    "serverDnsNames": [
      "openshell-gateway.oce-system.svc",
      ("openshell-gateway.oce-system.svc." + $clusterDomain),
      "openshell.localhost",
      "*.openshell.localhost"
    ]
  },
  "server": {
    "sandboxUid": 10001,
    "sandboxGid": 10001,
    "disableTls": false,
    "auth": {
      "allowUnauthenticatedUsers": false
    },
    "tls": {
      "enableMtls": true,
      "certSecretName": "openshell-server-tls",
      "clientTlsSecretName": "openshell-client-tls"
    },
    "sandboxJwt": {
      "signingSecretName": "openshell-jwt-signing-key",
      "gatewayId": "openshell-gateway"
    },
    "dataStorageClass": $storageClass,
    "dataStorageSize": "1Gi",
    "drivers": {
      "kubernetes": {
        "allowDriverConfig": true,
        "resourceAdmission": {
          "enabled": false
        },
        "workspaceMode": "operator",
        "operatorNamespaceLabel": "openshell.ai/openclaw-workspace=true"
      }
    }
  },
  "gatewayConfig": {
    "openshell.gateway": {
      "mutation_admission_limit_per_caller": 5000
    },
    "openshell.drivers.kubernetes": {
      "allowed_pod_labels": [
        "openclaw.dev/*",
        "app.kubernetes.io/name",
        "app.kubernetes.io/managed-by"
      ]
    }
  }
}
