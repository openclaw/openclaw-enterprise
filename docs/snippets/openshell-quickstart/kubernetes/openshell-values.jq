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
      "digest": "sha256:ed4fe731bb7c3a7fca794b0671e618b60170a42a4c8107b2567ed596621a8014",
      "pullPolicy": "IfNotPresent"
    }
  },
  "sandboxRuntime": {
    "image": {
      "registry": $registry,
      "repository": $repository,
      "digest": "sha256:d833a81ff771feeb2067dc9958595ee1cceec1903d4513fc57997972ae4d2bf3",
      "pullPolicy": "IfNotPresent"
    }
  },
  "supervisor": {
    "image": {
      "registry": $registry,
      "repository": $repository,
      "digest": "sha256:21c0c9000f4eaf3fb7c5b97b3e0a3bb1c01a77fb3f773b4aa7b7c90ff6db2b98",
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
    "defaultRuntimeClassName": "openshell-sandbox",
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
    "openshell.drivers.kubernetes": {
      "allowed_pod_labels": [
        "openclaw.dev/*",
        "app.kubernetes.io/name",
        "app.kubernetes.io/managed-by"
      ]
    }
  }
}
