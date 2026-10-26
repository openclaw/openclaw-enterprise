{{- define "demo.labels" -}}
app.kubernetes.io/name: openclaw-observability-demo
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}
{{- define "demo.validate" -}}
{{- $_ := required "occ.namespace is required" .Values.occ.namespace -}}
{{- /* NetworkPolicies select these on kubernetes.io/metadata.name, which holds only Namespace names. */ -}}
{{- include "demo.namespaceName" (dict "value" .Values.occ.namespace "path" "occ.namespace") -}}
{{- include "demo.namespaceName" (dict "value" .Values.dns.namespace "path" "dns.namespace") -}}
{{- $_ := required "occ.release is required" .Values.occ.release -}}
{{- $_ := required "grafana.adminSecretName must name an existing private Secret" .Values.grafana.adminSecretName -}}
{{- if empty .Values.cluster.cidrs }}{{ fail "cluster.cidrs must identify Kubernetes API endpoints" }}{{ end -}}
{{- range .Values.cluster.cidrs }}
{{- /* One IPv4 host. The old pattern accepted leading zeros and octets above 255, which Go's ParseCIDR rejects. */ -}}
{{- if not (regexMatch "^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])(?:\\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])){3}/32$" (toString .)) }}{{ fail "cluster.cidrs requires exact IPv4 /32 endpoints" }}{{ end -}}
{{- end -}}
{{- range $name, $image := .Values.images }}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" $image) }}{{ fail (printf "images.%s must use an immutable SHA-256 reference" $name) }}{{ end -}}
{{- /* Docker permits uppercase in the registry host and tag, never in the repository path. Keep the existing reference-shape rule, including IPv6 registry hosts. */ -}}
{{- $remainder := $image -}}
{{- if contains "/" $image -}}
{{- $first := index (splitn "/" 2 $image) "_0" -}}
{{- if or (eq $first "localhost") (regexMatch "[.:]" $first) (ne (lower $first) $first) -}}
{{- $remainder = index (splitn "/" 2 $image) "_1" -}}
{{- end -}}
{{- end -}}
{{- $repository := index (splitn ":" 2 $remainder) "_0" -}}
{{- if ne (lower $repository) $repository -}}
{{- fail (printf "images.%s repository path must be lowercase; Kubernetes refuses to pull an uppercase one" $name) -}}
{{- end -}}
{{- end -}}
{{- range $index, $client := .Values.grafana.clients }}
{{- if or (empty $client.namespace) (empty $client.podLabels) }}{{ fail "grafana.clients requires namespace and nonempty podLabels" }}{{ end -}}
{{- include "demo.namespaceName" (dict "value" $client.namespace "path" (printf "grafana.clients[%d].namespace" $index)) -}}
{{- end -}}
{{- /* NetworkPolicy ports. Sprig int returns 0 past int64, so a longer digit string must fail before that conversion. */ -}}
{{- range $path, $port := dict "cluster.port" .Values.cluster.port "occ.metricsPort" .Values.occ.metricsPort -}}
{{- if or (not (regexMatch "^[1-9][0-9]{0,4}$" (toString $port))) (gt (int $port) 65535) -}}
{{- fail (printf "%s must be an integer TCP port from 1 to 65535" $path) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- define "demo.namespaceName" -}}
{{- if or (gt (len (toString .value)) 63) (not (regexMatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" (toString .value))) -}}
{{- fail (printf "%s must be a Kubernetes namespace name (a DNS label of at most 63 characters)" .path) -}}
{{- end -}}
{{- end -}}

{{- /* Service names are DNS labels, while Helm permits dots and leading digits in release names. Keep admissible short names stable and hash the original release whenever normalization or shortening is needed. */ -}}
{{- define "demo.serviceName" -}}
{{- $name := printf "%s-%s" .root.Release.Name .component -}}
{{- if and (le (len $name) 63) (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" $name) -}}
{{- $name -}}
{{- else -}}
{{- /* End with the hash: a fallback cannot alias an unchanged name ending in -prometheus, -loki or -grafana. */ -}}
{{- $prefix := printf "%s-%s" .component (replace "." "-" .root.Release.Name) -}}
{{- $suffix := printf "-%s" (.root.Release.Name | sha256sum | trunc 12) -}}
{{- printf "%s%s" ($prefix | trunc (int (sub 63 (len $suffix))) | trimSuffix "-") $suffix -}}
{{- end -}}
{{- end -}}
