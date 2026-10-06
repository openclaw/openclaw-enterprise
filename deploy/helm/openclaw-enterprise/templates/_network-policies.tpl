{{/* Keep both selectors in one peer so DNS access requires both to match. */}}
{{- define "openclaw.networkPolicy.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ .Values.dns.namespace | quote }}
      podSelector:
        matchLabels:
          {{- toYaml .Values.dns.podLabels | nindent 10 }}
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
