{{- define "openclaw.validate" -}}
{{- if hasKey .Values "integrations" -}}{{- fail "integrations is retired; configure ChatGPT packaging under backend.chatgpt" -}}{{- end -}}
{{- if hasKey .Values "workspaceFiles" -}}{{- fail "workspaceFiles is retired; configure private Envoy Gateway routing under gatewayRouting" -}}{{- end -}}
{{- range $name, $image := .Values.images -}}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-fA-F0-9]{64}$" $image) -}}
{{- fail (printf "images.%s must be an approved immutable SHA-256 image reference" $name) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.auth.baseUrl -}}{{- fail "auth.baseUrl must identify the public Better Auth base URL" -}}{{- end -}}
{{- if or (not .Values.auth.secretName) (not .Values.auth.secretKey) -}}{{- fail "auth must reference an operator-created Better Auth signing Secret" -}}{{- end -}}
{{- $github := .Values.auth.github -}}
{{- $recoveryUserId := toString (default "" .Values.auth.recoveryUserId) -}}
{{- if hasKey (default dict $github) "recoveryUserId" -}}{{- fail "auth.github.recoveryUserId is not a chart value; set auth.recoveryUserId" -}}{{- end -}}
{{- if and $recoveryUserId (not (regexMatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" $recoveryUserId)) -}}{{- fail "auth.recoveryUserId must be the existing local password administrator's user ID" -}}{{- end -}}
{{- $google := .Values.auth.google -}}
{{- if and $recoveryUserId (not (or (and $github $github.enabled) (and $google $google.enabled))) -}}{{- fail "auth.recoveryUserId requires auth.github.enabled or auth.google.enabled" -}}{{- end -}}
{{- if and $github $github.enabled -}}
{{- if not $recoveryUserId -}}{{- fail "auth.github.enabled requires auth.recoveryUserId: install without GitHub first, then upgrade with the administrator's user ID" -}}{{- end -}}
{{- if or (not $github.secretName) (not $github.clientIdKey) (not $github.clientSecretKey) -}}{{- fail "auth.github requires a dedicated operator-created Secret name, client ID key, and client secret key" -}}{{- end -}}
{{- if eq $github.clientIdKey $github.clientSecretKey -}}{{- fail "auth.github client ID and client secret must use different Secret keys" -}}{{- end -}}
{{- if or (eq $github.secretName .Values.installation.secretName) (eq $github.secretName .Values.database.secretName) (eq $github.secretName .Values.auth.secretName) (and .Values.backend.chatgpt.enabled (eq $github.secretName .Values.backend.chatgpt.secretName)) (and .Values.gatewayRouting.enabled (eq $github.secretName .Values.gatewayRouting.apiKeySecretName)) -}}
{{- fail "auth.github credentials must use a dedicated Secret" -}}
{{- end -}}
{{- if .Values.repositoryCredentials.enabled -}}
{{- range $name := list "serviceConfigSecretName" "appKeySecretName" "tlsSecretName" "publicCaSecretName" -}}
{{- if eq $github.secretName (index $.Values.repositoryCredentials $name) -}}{{- fail (printf "auth.github credentials must use a Secret distinct from repositoryCredentials.%s" $name) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (hasPrefix "https://" .Values.auth.baseUrl) -}}{{- fail "auth.github requires an HTTPS auth.baseUrl" -}}{{- end -}}
{{- if .Values.agentNativeAdmin.enabled -}}{{- fail "auth.github requires agentNativeAdmin.enabled: false; GitHub sign-in supports host-only cookies only" -}}{{- end -}}
{{- if not (kindIs "slice" (default list $github.egressCidrs)) -}}{{- fail "auth.github.egressCidrs must be a list of IPv4 CIDRs; leave it empty for HTTPS egress to any address" -}}{{- end -}}
{{- range $cidr := $github.egressCidrs -}}
{{- if not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" (toString $cidr)) -}}{{- fail "auth.github.egressCidrs requires explicit IPv4 CIDRs with prefixes 1 through 32" -}}{{- end -}}
{{- range $octet := splitList "." (first (splitList "/" (toString $cidr))) -}}
{{- if gt (int $octet) 255 -}}{{- fail "auth.github.egressCidrs contains an invalid IPv4 address" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and $google $google.enabled -}}
{{- if not $recoveryUserId -}}{{- fail "auth.google.enabled requires auth.recoveryUserId: install without Google first, then upgrade with the administrator's user ID" -}}{{- end -}}
{{- if or (not $google.secretName) (not $google.clientIdKey) (not $google.clientSecretKey) -}}{{- fail "auth.google requires a dedicated operator-created Secret name, client ID key, and client secret key" -}}{{- end -}}
{{- if eq $google.clientIdKey $google.clientSecretKey -}}{{- fail "auth.google client ID and client secret must use different Secret keys" -}}{{- end -}}
{{- if or (eq $google.secretName .Values.installation.secretName) (eq $google.secretName .Values.database.secretName) (eq $google.secretName .Values.auth.secretName) (and .Values.backend.chatgpt.enabled (eq $google.secretName .Values.backend.chatgpt.secretName)) (and .Values.gatewayRouting.enabled (eq $google.secretName .Values.gatewayRouting.apiKeySecretName)) (and $github $github.enabled (eq $google.secretName $github.secretName)) -}}
{{- fail "auth.google credentials must use a dedicated Secret" -}}
{{- end -}}
{{- if .Values.repositoryCredentials.enabled -}}
{{- range $name := list "serviceConfigSecretName" "appKeySecretName" "tlsSecretName" "publicCaSecretName" -}}
{{- if eq $google.secretName (index $.Values.repositoryCredentials $name) -}}{{- fail (printf "auth.google credentials must use a Secret distinct from repositoryCredentials.%s" $name) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (hasPrefix "https://" .Values.auth.baseUrl) -}}{{- fail "auth.google requires an HTTPS auth.baseUrl" -}}{{- end -}}
{{- if .Values.agentNativeAdmin.enabled -}}{{- fail "auth.google requires agentNativeAdmin.enabled: false; Google sign-in supports host-only cookies only" -}}{{- end -}}
{{- if not (kindIs "slice" (default list $google.allowedDomains)) -}}{{- fail "auth.google.allowedDomains must be a list of DNS domain names" -}}{{- end -}}
{{- range $domain := $google.allowedDomains -}}
{{- $name := lower (trim (toString $domain)) -}}
{{- if or (gt (len $name) 253) (not (regexMatch "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$" $name)) -}}{{- fail "auth.google.allowedDomains requires DNS domain names such as example.com" -}}{{- end -}}
{{- end -}}
{{- if not (kindIs "slice" (default list $google.egressCidrs)) -}}{{- fail "auth.google.egressCidrs must be a list of IPv4 CIDRs; leave it empty for HTTPS egress to any address" -}}{{- end -}}
{{- range $cidr := $google.egressCidrs -}}
{{- if not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" (toString $cidr)) -}}{{- fail "auth.google.egressCidrs requires explicit IPv4 CIDRs with prefixes 1 through 32" -}}{{- end -}}
{{- range $octet := splitList "." (first (splitList "/" (toString $cidr))) -}}
{{- if gt (int $octet) 255 -}}{{- fail "auth.google.egressCidrs contains an invalid IPv4 address" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $proxy := default dict .Values.api.trustedProxy -}}
{{- $preset := toString (default "" $proxy.preset) -}}
{{- if not (has $preset (list "" "ingress-nginx" "aws" "generic")) -}}{{- fail "api.trustedProxy.preset must be empty, ingress-nginx, aws, or generic" -}}{{- end -}}
{{- if not $preset -}}
{{- if or $proxy.cidrs $proxy.clientAddressHeader -}}{{- fail "api.trustedProxy.cidrs and clientAddressHeader require api.trustedProxy.preset" -}}{{- end -}}
{{- else -}}
{{- if or (not (kindIs "slice" $proxy.cidrs)) (not $proxy.cidrs) -}}{{- fail (printf "api.trustedProxy.preset %s requires api.trustedProxy.cidrs: the proxy addresses the API Pod sees as the connecting peer" $preset) -}}{{- end -}}
{{- range $cidr := $proxy.cidrs -}}
{{- $value := toString $cidr -}}
{{- if regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" $value -}}
{{- range $octet := splitList "." (first (splitList "/" $value)) -}}
{{- if gt (int $octet) 255 -}}{{- fail "api.trustedProxy.cidrs contains an invalid IPv4 address" -}}{{- end -}}
{{- end -}}
{{- else if not (regexMatch "^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*/([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$" $value) -}}
{{- fail "api.trustedProxy.cidrs requires IPv4 or IPv6 CIDRs with a nonzero prefix" -}}
{{- end -}}
{{- end -}}
{{- if and (eq $preset "generic") (not $proxy.clientAddressHeader) -}}{{- fail "api.trustedProxy.preset generic requires api.trustedProxy.clientAddressHeader" -}}{{- end -}}
{{- $header := lower (toString (default "" $proxy.clientAddressHeader)) -}}
{{- if $header -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]{0,63}$" $header) -}}{{- fail "api.trustedProxy.clientAddressHeader must be a single HTTP header name of at most 64 characters" -}}{{- end -}}
{{- if has $header (list "x-occ-client-ip" "cookie" "forwarded" "authorization" "host" "origin" "x-api-key") -}}{{- fail (printf "api.trustedProxy.clientAddressHeader cannot be %s; use a header that carries plain client addresses, such as x-forwarded-for or x-real-ip" $header) -}}{{- end -}}
{{- if and (ne $preset "generic") (ne $header "x-forwarded-for") -}}{{- fail (printf "api.trustedProxy.preset %s reads x-forwarded-for; use the generic preset for %s" $preset $header) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if .Values.agentNativeAdmin.enabled -}}
{{- if not .Values.agentNativeAdmin.domain -}}{{- fail "agentNativeAdmin.domain must identify the public Agent native admin DNS suffix when agentNativeAdmin.enabled is true" -}}{{- end -}}
{{- if not (regexMatch "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$" .Values.agentNativeAdmin.domain) -}}{{- fail "agentNativeAdmin.domain must be a DNS hostname without a wildcard, port, scheme, or path" -}}{{- end -}}
{{- if not .Values.agentNativeAdmin.sharedCookieDomain -}}{{- fail "agentNativeAdmin.sharedCookieDomain must identify the trusted shared OCE cookie parent when agentNativeAdmin.enabled is true" -}}{{- end -}}
{{- if not (regexMatch "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$" .Values.agentNativeAdmin.sharedCookieDomain) -}}{{- fail "agentNativeAdmin.sharedCookieDomain must be a DNS hostname without a wildcard, port, scheme, or path" -}}{{- end -}}
{{- $agentNativeAdminDomain := lower .Values.agentNativeAdmin.domain -}}
{{- $sharedCookieDomain := lower .Values.agentNativeAdmin.sharedCookieDomain -}}
{{- if not (or (eq $agentNativeAdminDomain $sharedCookieDomain) (hasSuffix (printf ".%s" $sharedCookieDomain) $agentNativeAdminDomain)) -}}{{- fail "agentNativeAdmin.domain must be inside agentNativeAdmin.sharedCookieDomain" -}}{{- end -}}
{{- if not .Values.gatewayRouting.enabled -}}{{- fail "agentNativeAdmin.enabled requires gatewayRouting.enabled so the API can reach private Agent gateways" -}}{{- end -}}
{{- end -}}
{{- if not .Values.bootstrap.adminEmail -}}{{- fail "bootstrap.adminEmail must identify the first administrator account" -}}{{- end -}}
{{- if or (not .Values.bootstrap.password.claimName) (not .Values.bootstrap.password.mountPath) (not .Values.bootstrap.password.fileName) -}}
{{- fail "bootstrap.password must reference an existing protected PVC output path" -}}
{{- end -}}
{{- if or (not .Values.bootstrap.serviceKey) (not .Values.bootstrap.serviceKey.fileName) -}}
{{- fail "bootstrap.serviceKey.fileName must identify the service key output file name" -}}
{{- end -}}
{{- range $label, $fileName := dict "bootstrap.password.fileName" .Values.bootstrap.password.fileName "bootstrap.serviceKey.fileName" .Values.bootstrap.serviceKey.fileName -}}
{{- if or (eq $fileName ".") (eq $fileName "..") (not (regexMatch "^[A-Za-z0-9._-]+$" $fileName)) -}}
{{- fail (printf "%s must be a simple basename" $label) -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.bootstrap.password.fileName .Values.bootstrap.serviceKey.fileName -}}
{{- fail "bootstrap service key and password output file names must be distinct" -}}
{{- end -}}
{{- if not .Values.api.clients -}}{{- fail "api.clients must contain exact approved client selectors" -}}{{- end -}}
{{- range $index, $client := .Values.api.clients -}}
{{- if or (not $client.namespace) (not $client.podLabels) -}}
{{- fail (printf "api.clients[%d] requires an exact namespace and nonempty Pod selector" $index) -}}
{{- end -}}
{{- end -}}
{{- if or (not .Values.dns.namespace) (not .Values.dns.podLabels) -}}
{{- fail "dns requires an exact namespace and nonempty Pod selector" -}}
{{- end -}}
{{- if hasKey .Values.database "cidr" -}}{{- fail "database.cidr is retired; configure database.cidrs with explicit IPv4 /32 hosts" -}}{{- end -}}
{{- if hasKey .Values.cluster "cidr" -}}{{- fail "cluster.cidr is retired; configure cluster.cidrs with explicit IPv4 /32 hosts" -}}{{- end -}}
{{- range $name, $cidrs := dict "database" .Values.database.cidrs "cluster" .Values.cluster.cidrs -}}
{{- if or (not (kindIs "slice" $cidrs)) (eq (len $cidrs) 0) -}}
{{- fail (printf "%s.cidrs must contain at least one explicit IPv4 /32 host" $name) -}}
{{- end -}}
{{- range $index, $cidr := $cidrs -}}
{{- if not (regexMatch "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/32$" $cidr) -}}
{{- fail (printf "%s.cidrs[%d] must identify exactly one IPv4 host with /32" $name $index) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (hasKey .Values.controlPlane "nodeSelector") (not (kindIs "invalid" .Values.controlPlane.nodeSelector)) (not (kindIs "map" .Values.controlPlane.nodeSelector)) -}}{{- fail "controlPlane.nodeSelector must be a map of Kubernetes node labels" -}}{{- end -}}
{{- if and .Values.controlPlane.installationChecksum (not (regexMatch "^[a-f0-9]{64}$" .Values.controlPlane.installationChecksum)) -}}{{- fail "controlPlane.installationChecksum must be an empty string or a lowercase SHA-256 digest" -}}{{- end -}}
{{- if eq .Values.database.appUrlKey .Values.database.migrationUrlKey -}}
{{- fail "database application and migration credentials must use different Secret keys" -}}
{{- end -}}
{{- if .Values.database.caSecretName -}}
{{- if or (not .Values.database.caKey) (not .Values.database.caMountPath) -}}
{{- fail "database CA Secret mounts require database.caKey and database.caMountPath" -}}
{{- end -}}
{{- if or (eq .Values.database.caKey ".") (eq .Values.database.caKey "..") (not (regexMatch "^[A-Za-z0-9._-]+$" .Values.database.caKey)) -}}
{{- fail "database.caKey must be a simple basename" -}}
{{- end -}}
{{- end -}}
{{- if or (eq .Values.installation.secretName .Values.database.secretName) (eq .Values.installation.secretName .Values.auth.secretName) -}}
{{- fail "installation startup configuration must use a dedicated Secret" -}}
{{- end -}}
{{- if eq .Values.database.secretName .Values.auth.secretName -}}
{{- fail "Better Auth signing material must use a dedicated Secret" -}}
{{- end -}}
{{- if .Values.executionCluster.enabled -}}
{{- $execution := .Values.executionCluster -}}
{{- if or (not $execution.apiKubeconfigSecretName) (not $execution.workerKubeconfigSecretName) (eq $execution.apiKubeconfigSecretName $execution.workerKubeconfigSecretName) -}}
{{- fail "executionCluster requires separate API and worker kubeconfig Secrets" -}}
{{- end -}}
{{- if or (not $execution.apiCidrs) (not $execution.kubeconfigKey) -}}
{{- fail "executionCluster requires explicit API CIDRs and kubeconfig key" -}}
{{- end -}}
{{- range $name := list $execution.apiKubeconfigSecretName $execution.workerKubeconfigSecretName -}}
{{- if has $name (list $.Values.installation.secretName $.Values.database.secretName $.Values.auth.secretName $.Values.gatewayRouting.apiKeySecretName) -}}
{{- fail "executionCluster kubeconfigs require dedicated Secrets distinct from platform credentials" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if .Values.slackProxy.enabled -}}
{{- $proxy := .Values.slackProxy -}}
{{- if .Values.api.channelDirectoryProxyUrl -}}{{- fail "api.channelDirectoryProxyUrl must be empty when slackProxy.enabled uses the chart-managed Service" -}}{{- end -}}
{{- if not (kindIs "bool" $proxy.enabled) -}}{{- fail "slackProxy.enabled must be a boolean" -}}{{- end -}}
{{- if or (gt (len $proxy.serviceName) 63) (not (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" $proxy.serviceName)) -}}
{{- fail "slackProxy.serviceName must be a DNS-1035 Service name" -}}
{{- end -}}
{{- if or (not (regexMatch "^[0-9]+$" (toString $proxy.port))) (lt (int $proxy.port) 1) (gt (int $proxy.port) 65535) -}}
{{- fail "slackProxy.port must be an integer TCP port from 1 to 65535" -}}
{{- end -}}
{{- end -}}
{{- if .Values.repositoryCredentials.enabled -}}
{{- $credentials := .Values.repositoryCredentials -}}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-fA-F0-9]{64}$" $credentials.image) -}}
{{- fail "repositoryCredentials.image must be an approved immutable SHA-256 image reference" -}}
{{- end -}}
{{- $serviceName := include "openclaw.repositoryCredentials.serviceName" . -}}
{{- if and .Release.IsUpgrade (not $credentials.serviceName) -}}
{{- fail "repositoryCredentials.serviceName must be explicit during upgrades; keep the current Service name until active repository sessions drain, then switch deliberately" -}}
{{- end -}}
{{- if or (gt (len $serviceName) 63) (not (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" $serviceName)) -}}
{{- fail "repositoryCredentials.serviceName must be a valid Kubernetes Service DNS-1035 label" -}}
{{- end -}}
{{- if not (kindIs "string" $credentials.clusterDomain) -}}
{{- fail "repositoryCredentials.clusterDomain must be a valid Kubernetes cluster DNS domain" -}}
{{- end -}}
{{- $clusterDomain := include "openclaw.repositoryCredentials.clusterDomain" . -}}
{{- if or (gt (len $clusterDomain) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $clusterDomain)) -}}
{{- fail "repositoryCredentials.clusterDomain must be a valid Kubernetes cluster DNS domain" -}}
{{- end -}}
{{- range $label := splitList "." $clusterDomain -}}
{{- if gt (len $label) 63 -}}
{{- fail "repositoryCredentials.clusterDomain must be a valid Kubernetes cluster DNS domain" -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "string" $credentials.hostname) -}}
{{- fail "repositoryCredentials.hostname must be a string" -}}
{{- end -}}
{{- $serviceHost := printf "%s.%s.svc" $serviceName .Release.Namespace -}}
{{- if and $credentials.hostname (ne $credentials.hostname $serviceHost) (ne $credentials.hostname (printf "%s.%s" $serviceHost $clusterDomain)) -}}
{{- fail "repositoryCredentials.hostname must match this Service's namespace-qualified or cluster-qualified DNS name" -}}
{{- end -}}
{{- $hostname := include "openclaw.repositoryCredentials.hostname" . -}}
{{- if gt (len $hostname) 253 -}}
{{- fail "repository credential broker hostname must not exceed 253 characters" -}}
{{- end -}}
{{- range $name := list "backendId" "registryConfigMapName" "registryKey" "serviceConfigSecretName" "serviceConfigKey" "appKeySecretName" "appKeyKey" "tlsSecretName" "publicCaSecretName" "publicCaKey" -}}
{{- if not (index $credentials $name) -}}{{- fail (printf "repositoryCredentials.%s is required when enabled" $name) -}}{{- end -}}
{{- end -}}
{{- $secrets := dict "installation" .Values.installation.secretName "database" .Values.database.secretName "auth" .Values.auth.secretName -}}
{{- if .Values.backend.chatgpt.enabled -}}{{- $_ := set $secrets "chatgpt" .Values.backend.chatgpt.secretName -}}{{- end -}}
{{- if .Values.executionCluster.enabled -}}
{{- $_ := set $secrets "executionApi" .Values.executionCluster.apiKubeconfigSecretName -}}
{{- $_ := set $secrets "executionWorker" .Values.executionCluster.workerKubeconfigSecretName -}}
{{- end -}}
{{- if .Values.gatewayRouting.enabled -}}
{{- $_ := set $secrets "gatewayApiKey" .Values.gatewayRouting.apiKeySecretName -}}
{{- $_ := set $secrets "gatewayTls" (include "openclaw.gatewayRouting.tlsSecretName" .) -}}
{{- $_ := set $secrets "gatewayRoot" (include "openclaw.gatewayRouting.rootSecretName" .) -}}
{{- if .Values.gatewayRouting.caSecretName -}}{{- $_ := set $secrets "gatewayCa" .Values.gatewayRouting.caSecretName -}}{{- end -}}
{{- end -}}
{{- range $name := list "serviceConfigSecretName" "appKeySecretName" "tlsSecretName" "publicCaSecretName" -}}
{{- $secret := index $credentials $name -}}
{{- range $other, $value := $secrets -}}
{{- if eq $secret $value -}}{{- fail (printf "repositoryCredentials.%s must use a dedicated Secret distinct from %s" $name $other) -}}{{- end -}}
{{- end -}}
{{- $_ := set $secrets $name $secret -}}
{{- end -}}
{{- if not $credentials.upstreamCidrs -}}{{- fail "repositoryCredentials.upstreamCidrs must contain approved provider IPv4 CIDRs" -}}{{- end -}}
{{- range $cidr := $credentials.upstreamCidrs -}}
{{- if not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" $cidr) -}}
{{- fail "repositoryCredentials.upstreamCidrs requires explicit IPv4 CIDRs with prefixes 1 through 32" -}}
{{- end -}}
{{- range $octet := splitList "." (first (splitList "/" $cidr)) -}}
{{- if gt (int $octet) 255 -}}{{- fail "repositoryCredentials.upstreamCidrs contains an invalid IPv4 address" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and .Values.gatewayRouting.sandbox.enabled (not .Values.gatewayRouting.enabled) -}}{{- fail "gatewayRouting.sandbox requires gatewayRouting.enabled" -}}{{- end -}}
{{- if .Values.gatewayRouting.enabled -}}
{{- $routing := .Values.gatewayRouting -}}
{{- $tlsSecretName := include "openclaw.gatewayRouting.tlsSecretName" . -}}
{{- $rootSecretName := include "openclaw.gatewayRouting.rootSecretName" . -}}
{{- if and (hasKey $routing "hostname") (not (kindIs "string" $routing.hostname)) -}}{{- fail "gatewayRouting.hostname must be a string when supplied" -}}{{- end -}}
{{- if not $routing.gatewayClassName -}}{{- fail "gatewayRouting.gatewayClassName must reference an operator-created GatewayClass" -}}{{- end -}}
{{- if not $routing.envoyNamespace -}}{{- fail "gatewayRouting.envoyNamespace must identify the existing Envoy Gateway controller namespace" -}}{{- end -}}
{{- if not $routing.issuerRef -}}{{- fail "gatewayRouting.issuerRef must be configured" -}}{{- end -}}
{{- if and (hasKey $routing.issuerRef "name") (not (kindIs "string" $routing.issuerRef.name)) -}}{{- fail "gatewayRouting.issuerRef.name must be a string when supplied" -}}{{- end -}}
{{- if $routing.issuerRef.name -}}
{{- if or (not $routing.issuerRef.kind) (not $routing.issuerRef.group) -}}{{- fail "gatewayRouting.issuerRef kind and group must be set with an external issuer" -}}{{- end -}}
{{- else -}}
{{- if or $routing.caSecretName $routing.caSecretKey -}}{{- fail "gatewayRouting.caSecretName and gatewayRouting.caSecretKey require an external issuerRef.name" -}}{{- end -}}
{{- end -}}
{{- if not $routing.apiKeySecretName -}}{{- fail "gatewayRouting.apiKeySecretName must reference an operator-created Opaque Secret with key 'occ'" -}}{{- end -}}
{{- if or (eq $routing.apiKeySecretName .Values.installation.secretName) (eq $routing.apiKeySecretName .Values.database.secretName) (eq $routing.apiKeySecretName .Values.auth.secretName) -}}
{{- fail "gatewayRouting.apiKeySecretName must use a dedicated Secret" -}}
{{- end -}}
{{- if eq $routing.apiKeySecretName $tlsSecretName -}}{{- fail "gatewayRouting.apiKeySecretName must differ from the Gateway TLS Secret" -}}{{- end -}}
{{- if or (eq $tlsSecretName .Values.installation.secretName) (eq $tlsSecretName .Values.database.secretName) (eq $tlsSecretName .Values.auth.secretName) -}}
{{- fail "gatewayRouting.tlsSecretName must differ from installation, database, and auth Secrets" -}}
{{- end -}}
{{- if and .Values.backend.chatgpt.enabled (eq $tlsSecretName .Values.backend.chatgpt.secretName) -}}{{- fail "gatewayRouting.tlsSecretName must differ from the ChatGPT Backend Secret" -}}{{- end -}}
{{- if or (eq $rootSecretName $tlsSecretName) (eq $rootSecretName $routing.apiKeySecretName) (eq $rootSecretName .Values.installation.secretName) (eq $rootSecretName .Values.database.secretName) (eq $rootSecretName .Values.auth.secretName) -}}
{{- fail "generated gatewayRouting root CA Secret must differ from leaf TLS, API key, installation, database, and auth Secrets" -}}
{{- end -}}
{{- if and .Values.backend.chatgpt.enabled (eq $rootSecretName .Values.backend.chatgpt.secretName) -}}{{- fail "generated gatewayRouting root CA Secret must differ from the ChatGPT Backend Secret" -}}{{- end -}}
{{- if or $routing.caSecretName $routing.caSecretKey -}}
{{- if or (not $routing.caSecretName) (not $routing.caSecretKey) -}}{{- fail "gatewayRouting.caSecretName and gatewayRouting.caSecretKey must be set together" -}}{{- end -}}
{{- if or (eq $routing.caSecretName $tlsSecretName) (eq $routing.caSecretName $routing.apiKeySecretName) (eq $routing.caSecretName .Values.installation.secretName) (eq $routing.caSecretName .Values.database.secretName) (eq $routing.caSecretName .Values.auth.secretName) -}}
{{- fail "gatewayRouting.caSecretName must differ from leaf TLS, API key, installation, database, and auth Secrets" -}}
{{- end -}}
{{- if and .Values.backend.chatgpt.enabled (eq $routing.caSecretName .Values.backend.chatgpt.secretName) -}}{{- fail "gatewayRouting.caSecretName must differ from the ChatGPT Backend Secret" -}}{{- end -}}
{{- end -}}
{{- if or (lt (int $routing.tenantGatewayPort) 1) (gt (int $routing.tenantGatewayPort) 65535) -}}
{{- fail "gatewayRouting.tenantGatewayPort must be a valid TCP port" -}}
{{- end -}}
{{- if or (lt (int $routing.envoyHttpsTargetPort) 1) (gt (int $routing.envoyHttpsTargetPort) 65535) -}}
{{- fail "gatewayRouting.envoyHttpsTargetPort must be a valid TCP port" -}}
{{- end -}}
{{- if not $routing.envoyGatewayPodLabels -}}{{- fail "gatewayRouting.envoyGatewayPodLabels must select the Envoy Gateway control-plane Pods for xDS egress" -}}{{- end -}}
{{- if $routing.sandbox.enabled -}}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\\.[a-z0-9-]+$" $routing.sandbox.domain) -}}{{- fail "gatewayRouting.sandbox.domain must be a DNS hostname without wildcard, scheme, port or path" -}}{{- end -}}
{{- if not $routing.sandbox.tlsSecretName -}}{{- fail "gatewayRouting.sandbox.tlsSecretName must reference a wildcard certificate Secret" -}}{{- end -}}
{{- if or (lt (int $routing.sandbox.listenerPort) 1024) (gt (int $routing.sandbox.listenerPort) 65535) (eq (int $routing.sandbox.listenerPort) (int $routing.envoyHttpsTargetPort)) -}}{{- fail "gatewayRouting.sandbox.listenerPort must be an unprivileged port distinct from private Envoy HTTPS" -}}{{- end -}}
{{- if ge (int $routing.tenantGatewayPort) 65535 -}}{{- fail "gatewayRouting.tenantGatewayPort must leave room for the adjacent sandbox port" -}}{{- end -}}
{{- if not $routing.sandbox.ingressPeers -}}{{- fail "gatewayRouting.sandbox.ingressPeers must explicitly select public ingress sources" -}}{{- end -}}
{{- $cookieDomain := trimPrefix "." (lower .Values.agentNativeAdmin.sharedCookieDomain) -}}
{{- if and $cookieDomain (or (eq $routing.sandbox.domain $cookieDomain) (hasSuffix (printf ".%s" $cookieDomain) $routing.sandbox.domain) (hasSuffix (printf ".%s" $routing.sandbox.domain) $cookieDomain)) -}}{{- fail "gatewayRouting.sandbox.domain must be outside the OCE shared session cookie domain" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openclaw.trustedProxy.header" -}}
{{- $proxy := default dict .Values.api.trustedProxy -}}
{{- if eq (toString $proxy.preset) "generic" -}}{{- lower (toString $proxy.clientAddressHeader) -}}{{- else -}}x-forwarded-for{{- end -}}
{{- end -}}

{{- define "openclaw.labels" -}}
app.kubernetes.io/name: openclaw-enterprise
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{- define "openclaw.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "openclaw.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "openclaw.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ .key }}
{{- end -}}

{{- define "openclaw.slackProxy.serviceName" -}}
{{- .Values.slackProxy.serviceName -}}
{{- end -}}

{{- define "openclaw.slackProxy.url" -}}
{{- printf "http://%s.%s.svc:%v" (include "openclaw.slackProxy.serviceName" .) .Release.Namespace (int .Values.slackProxy.port) -}}
{{- end -}}

{{- define "openclaw.gatewayRouting.gatewayName" -}}
{{- default (printf "%s-agent-gateways" .Release.Name | trunc 63 | trimSuffix "-") .Values.gatewayRouting.gatewayName -}}
{{- end -}}

{{- define "openclaw.gatewayRouting.tlsSecretName" -}}
{{- default (printf "%s-tls" (include "openclaw.gatewayRouting.gatewayName" .) | trunc 63 | trimSuffix "-") .Values.gatewayRouting.tlsSecretName -}}
{{- end -}}

{{- define "openclaw.gatewayRouting.routeNamespaceLabel" -}}
{{- printf "%s/%s" .Release.Namespace (include "openclaw.gatewayRouting.gatewayName" .) | sha256sum | trunc 12 -}}
{{- end -}}

{{- define "openclaw.gatewayRouting.serviceName" -}}
{{- printf "occ-gateway-%s" (include "openclaw.gatewayRouting.routeNamespaceLabel" .) -}}
{{- end -}}


{{- define "openclaw.gatewayRouting.rootSecretName" -}}
{{- printf "%s-root" (include "openclaw.gatewayRouting.serviceName" .) -}}
{{- end -}}

{{- define "openclaw.repositoryCredentials.serviceName" -}}
{{- default "git" .Values.repositoryCredentials.serviceName -}}
{{- end -}}

{{- define "openclaw.repositoryCredentials.clusterDomain" -}}
{{- .Values.repositoryCredentials.clusterDomain -}}
{{- end -}}

{{- define "openclaw.repositoryCredentials.hostname" -}}
{{- default (printf "%s.%s.svc.%s" (include "openclaw.repositoryCredentials.serviceName" .) .Release.Namespace (include "openclaw.repositoryCredentials.clusterDomain" .)) .Values.repositoryCredentials.hostname -}}
{{- end -}}

{{- define "openclaw.repositoryCredentials.origin" -}}
{{- printf "https://%s" (include "openclaw.repositoryCredentials.hostname" .) -}}
{{- end -}}

{{- define "openclaw.gatewayRouting.envoyNetworkPolicyName" -}}
{{- printf "%s-%s-envoy-dataplane" (.Release.Name | trunc 34 | trimSuffix "-") (include "openclaw.gatewayRouting.routeNamespaceLabel" .) -}}
{{- end -}}
