{{- define "demo.labels" -}}
app.kubernetes.io/name: openclaw-observability-demo
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}
{{- define "demo.validate" -}}
{{- $_ := required "occ.namespace is required" .Values.occ.namespace -}}
{{- $_ := required "occ.release is required" .Values.occ.release -}}
{{- $_ := required "grafana.adminSecretName must name an existing private Secret" .Values.grafana.adminSecretName -}}
{{- if empty .Values.cluster.cidrs }}{{ fail "cluster.cidrs must identify Kubernetes API endpoints" }}{{ end -}}
{{- range .Values.cluster.cidrs }}
{{- if not (regexMatch "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/32$" .) }}{{ fail "cluster.cidrs requires exact IPv4 /32 endpoints" }}{{ end -}}
{{- end -}}
{{- range $name, $image := .Values.images }}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" $image) }}{{ fail (printf "images.%s must use an immutable SHA-256 reference" $name) }}{{ end -}}
{{- end -}}
{{- range .Values.grafana.clients }}
{{- if or (empty .namespace) (empty .podLabels) }}{{ fail "grafana.clients requires namespace and nonempty podLabels" }}{{ end -}}
{{- end -}}
{{- end -}}
