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
