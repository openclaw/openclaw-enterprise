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
      "digest": "sha256:9ca31b210cb0811db12bb52783de74f1fe279722cbc70cc24588e56811616e0d",
      "pullPolicy": "IfNotPresent"
    }
  },
  "sandboxRuntime": {
    "image": {
      "registry": $registry,
      "repository": $repository,
      "digest": "sha256:c931744fd5755e714972f594dc3d65f917bf41fb89af81d0f8ecad66cdc2adc0",
      "pullPolicy": "IfNotPresent"
    }
  },
  "supervisor": {
    "image": {
      "registry": $registry,
      "repository": $repository,
      "digest": "sha256:8128d88fb564497d6c0281295e87eae57f11d21cdc95ac69025a670de5e52c7d",
      "pullPolicy": "IfNotPresent"
    }
  },
  "pkiInitJob": {
    "enabled": true,
    "serverDnsNames": [
      "openshell-gateway.oce-system.svc",
      "openshell-gateway.oce-system.svc.cluster.local",
      "openshell.localhost",
      "*.openshell.localhost"
    ]
  },
  "server": {
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
    "dataStorageClass": "encrypted-gp3",
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
