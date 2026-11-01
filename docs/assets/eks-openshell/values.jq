{
  "images": {
    "controller": $controller
  },
  "auth": {
    "baseUrl": "http://127.0.0.1:18080",
    "secretName": "occ-auth",
    "secretKey": "secret"
  },
  "agentNativeAdmin": {
    "enabled": false
  },
  "bootstrap": {
    "adminEmail": $email,
    "password": {
      "claimName": "occ-bootstrap-admin-password"
    }
  },
  "database": {
    "secretName": "occ-database",
    "appUrlKey": "application-url",
    "migrationUrlKey": "migration-url",
    "caSecretName": "occ-rds-ca",
    "caKey": "ca.pem",
    "caMountPath": "/etc/openclaw/database-ca",
    "cidrs": $databaseCidrs,
    "port": 5432
  },
  "api": {
    "modelDiscoveryCidrs": [],
    "clients": [
      {
        "namespace": "oce-system",
        "podLabels": {
          "app": "occ-operator"
        }
      }
    ]
  },
  "cluster": {
    "cidrs": $apiCidrs,
    "port": 443
  },
  "controlPlane": {
    "nodeSelector": {
      "oce-role": "control"
    }
  },
  "gatewayRouting": {
    "enabled": true,
    "gatewayClassName": "eg",
    "gatewayName": "oce-agent-gateways",
    "envoyNamespace": "envoy-gateway-system",
    "hostname": $hostname,
    "serviceType": "ClusterIP",
    "apiKeySecretName": "occ-private-gateway-key"
  },
  "repositoryCredentials": {
    "enabled": false
  },
  "slackProxy": {
    "enabled": false
  },
  "metrics": {
    "enabled": true,
    "scraperNamespaceLabels": {},
    "scraperPodLabels": {}
  },
  "installation": {
    "name": "openclaw-enterprise",
    "secretName": "occ-installation-startup",
    "key": "installation.yaml"
  },
  "backend": {
    "openshell": {
      "clientSecretName": "openshell-client-tls"
    }
  },
  "worker": {
    "replicaCount": 0
  },
  "egressAuthority": {
    "enabled": false
  },
  "openshellGit": {
    "enabled": false
  }
}
