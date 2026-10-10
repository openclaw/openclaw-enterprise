{{/* Validate only maps a peer caller emits; retain the existing YAML, including native null/empty semantics. */}}
{{- define "openclaw.networkPolicy.matchLabels" -}}
{{- if and (not (kindIs "invalid" .value)) (not (kindIs "map" .value)) -}}
{{- fail (printf "%s must be a Kubernetes matchLabels map" .name) -}}
{{- end -}}
{{- $labelName := "^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$" -}}
{{- range $key, $value := .value -}}
{{- $parts := splitList "/" $key -}}
{{- $name := last $parts -}}
{{- if or (gt (len $parts) 2) (gt (len $name) 63) (not (regexMatch $labelName $name)) -}}
{{- fail (printf "%s contains an invalid Kubernetes label key: %s" $.name $key) -}}
{{- end -}}
{{- if eq (len $parts) 2 -}}
{{- $prefix := first $parts -}}
{{- /* Kubernetes qualified-name prefixes have a 253-character total bound, without a per-label cap. */ -}}
{{- if or (gt (len $prefix) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $prefix)) -}}
{{- fail (printf "%s contains an invalid Kubernetes label key: %s" $.name $key) -}}
{{- end -}}
{{- end -}}
{{- /* The native API decodes a null label value as an empty string; preserve that accepted input. */ -}}
{{- if not (kindIs "invalid" $value) -}}
{{- if not (kindIs "string" $value) -}}
{{- fail (printf "%s label values must be strings" $.name) -}}
{{- end -}}
{{- if or (gt (len $value) 63) (and (ne $value "") (not (regexMatch $labelName $value))) -}}
{{- fail (printf "%s contains an invalid Kubernetes label value for %s" $.name $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- toYaml .value -}}
{{- end -}}

{{/* Keep both selectors in one peer so DNS access requires both to match. */}}
{{- define "openclaw.networkPolicy.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ .Values.dns.namespace | quote }}
      podSelector:
        matchLabels:
          {{- include "openclaw.networkPolicy.matchLabels" (dict "name" "dns.podLabels" "value" .Values.dns.podLabels) | nindent 10 }}
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
    # Allow port 5353 for compatibility with OpenShift DNS backends.
    - { protocol: UDP, port: 5353 }
    - { protocol: TCP, port: 5353 }
{{- end -}}

{{/*
HTTPS peers for an API sign-in egress policy, given the provider's egressCidrs list.
Empty allows any IPv4 address except link-local 169.254.0.0/16 (cloud metadata);
a non-empty list replaces that default entirely. Each entry after the first starts on a
new line, so the output has no blank first line under nindent.
*/}}
{{- define "openclaw.networkPolicy.signInEgressPeers" -}}
{{- range $index, $cidr := . }}{{ if $index }}{{ "\n" }}{{ end -}}
- ipBlock:
    cidr: {{ $cidr | quote }}
{{- else -}}
- ipBlock:
    cidr: "0.0.0.0/0"
    except:
      - "169.254.0.0/16"
{{- end -}}
{{- end -}}
