{{/* A Kubernetes label key (qualified name) in a selector caller emits. */}}
{{- define "openclaw.networkPolicy.labelKey" -}}
{{- $key := .key -}}
{{- if not (kindIs "string" $key) -}}
{{- fail (printf "%s contains an invalid Kubernetes label key: %v" .name $key) -}}
{{- end -}}
{{- $parts := splitList "/" $key -}}
{{- $name := last $parts -}}
{{- if or (gt (len $parts) 2) (gt (len $name) 63) (not (regexMatch "^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$" $name)) -}}
{{- fail (printf "%s contains an invalid Kubernetes label key: %s" .name $key) -}}
{{- end -}}
{{- if eq (len $parts) 2 -}}
{{- $prefix := first $parts -}}
{{- /* Kubernetes qualified-name prefixes have a 253-character total bound, without a per-label cap. */ -}}
{{- if or (gt (len $prefix) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $prefix)) -}}
{{- fail (printf "%s contains an invalid Kubernetes label key: %s" .name $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* One NetworkPolicy ipBlock CIDR: IPv4 or IPv6, any prefix, as the API server parses it. */}}
{{- define "openclaw.networkPolicy.cidr" -}}
{{- $value := toString .value -}}
{{- if regexMatch "^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])(?:\\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])){3}/(?:0|[1-9]|[12][0-9]|3[0-2])$" $value -}}
{{- else if regexMatch "^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*/(?:0|[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$" $value -}}
{{- $addr := first (splitList "/" $value) -}}
{{- $tail := regexFind ":(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}$" $addr -}}
{{- range $octet := splitList "." (default ":0.0.0.0" $tail | trimPrefix ":") -}}
{{- if gt (int $octet) 255 -}}{{- fail (printf "%s contains an invalid IPv6 address" $.name) -}}{{- end -}}
{{- end -}}
{{- $hex := ternary (printf "%s:0:0" (trimSuffix $tail $addr)) $addr (ne $tail "") -}}
{{- $groups := len (regexFindAll "[0-9A-Fa-f]+" $hex -1) -}}
{{- if or (not (regexMatch "^(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?:::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?)?$" $hex)) (ternary (gt $groups 7) (ne $groups 8) (contains "::" $hex)) -}}{{- fail (printf "%s contains an invalid IPv6 address" .name) -}}{{- end -}}
{{- else -}}
{{- fail (printf "%s requires an IPv4 or IPv6 CIDR" .name) -}}
{{- end -}}
{{- end -}}

{{/* A namespaceSelector or podSelector in a NetworkPolicy peer from values. */}}
{{- define "openclaw.networkPolicy.selector" -}}
{{- $name := .name -}}
{{- if not (kindIs "map" .value) -}}
{{- fail (printf "%s must be a Kubernetes label selector" $name) -}}
{{- end -}}
{{- range $field, $_ := .value -}}
{{- if not (has $field (list "matchLabels" "matchExpressions")) -}}
{{- fail (printf "%s has unknown field %s" $name $field) -}}
{{- end -}}
{{- end -}}
{{- if hasKey .value "matchLabels" -}}
{{- $_ := include "openclaw.networkPolicy.matchLabels" (dict "name" (printf "%s.matchLabels" $name) "value" .value.matchLabels) -}}
{{- end -}}
{{- $expressions := .value.matchExpressions -}}
{{- if not (or (kindIs "invalid" $expressions) (kindIs "slice" $expressions)) -}}
{{- fail (printf "%s.matchExpressions must be a list" $name) -}}
{{- end -}}
{{- range $index, $expression := $expressions -}}
{{- $at := printf "%s.matchExpressions[%d]" $name $index -}}
{{- if not (kindIs "map" $expression) -}}
{{- fail (printf "%s must be a key, operator and values map" $at) -}}
{{- end -}}
{{- range $field, $_ := $expression -}}
{{- if not (has $field (list "key" "operator" "values")) -}}
{{- fail (printf "%s has unknown field %s" $at $field) -}}
{{- end -}}
{{- end -}}
{{- include "openclaw.networkPolicy.labelKey" (dict "name" $at "key" $expression.key) -}}
{{- $operator := $expression.operator -}}
{{- if not (has $operator (list "In" "NotIn" "Exists" "DoesNotExist")) -}}
{{- fail (printf "%s.operator must be In, NotIn, Exists or DoesNotExist" $at) -}}
{{- end -}}
{{- $values := $expression.values -}}
{{- if not (or (kindIs "invalid" $values) (kindIs "slice" $values)) -}}
{{- fail (printf "%s.values must be a list" $at) -}}
{{- end -}}
{{- if has $operator (list "In" "NotIn") -}}
{{- if not $values -}}
{{- fail (printf "%s.values must list label values for In and NotIn" $at) -}}
{{- end -}}
{{- range $value := $values -}}
{{- if not (kindIs "string" $value) -}}
{{- fail (printf "%s.values must be strings; use --set-string for values that look like numbers or booleans" $at) -}}
{{- end -}}
{{- if or (gt (len $value) 63) (and (ne $value "") (not (regexMatch "^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$" $value))) -}}
{{- fail (printf "%s.values contains an invalid Kubernetes label value" $at) -}}
{{- end -}}
{{- end -}}
{{- else if $values -}}
{{- fail (printf "%s.values must be empty for Exists and DoesNotExist" $at) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* One NetworkPolicy peer from values: an ipBlock, or namespace and Pod selectors. */}}
{{- define "openclaw.networkPolicy.peer" -}}
{{- $name := .name -}}
{{- $peer := .value -}}
{{- if not (kindIs "map" $peer) -}}
{{- fail (printf "%s must set either ipBlock or selectors" $name) -}}
{{- end -}}
{{- /* The API server decodes a null field as unset. */ -}}
{{- $set := dict -}}
{{- range $field, $value := $peer -}}
{{- if not (has $field (list "ipBlock" "namespaceSelector" "podSelector")) -}}
{{- fail (printf "%s has unknown field %s" $name $field) -}}
{{- end -}}
{{- if not (kindIs "invalid" $value) -}}
{{- $_ := set $set $field true -}}
{{- end -}}
{{- end -}}
{{- if not $set -}}
{{- fail (printf "%s must set either ipBlock or selectors" $name) -}}
{{- end -}}
{{- if and (hasKey $set "ipBlock") (or (hasKey $set "namespaceSelector") (hasKey $set "podSelector")) -}}
{{- fail (printf "%s must set either ipBlock or selectors, not both" $name) -}}
{{- end -}}
{{- if hasKey $set "ipBlock" -}}
{{- $block := $peer.ipBlock -}}
{{- if not (kindIs "map" $block) -}}
{{- fail (printf "%s.ipBlock must be a map with cidr" $name) -}}
{{- end -}}
{{- range $field, $_ := $block -}}
{{- if not (has $field (list "cidr" "except")) -}}
{{- fail (printf "%s.ipBlock has unknown field %s" $name $field) -}}
{{- end -}}
{{- end -}}
{{- include "openclaw.networkPolicy.cidr" (dict "name" (printf "%s.ipBlock.cidr" $name) "value" $block.cidr) -}}
{{- if not (or (kindIs "invalid" $block.except) (kindIs "slice" $block.except)) -}}
{{- fail (printf "%s.ipBlock.except must be a list of CIDRs" $name) -}}
{{- end -}}
{{- range $index, $cidr := $block.except -}}
{{- include "openclaw.networkPolicy.cidr" (dict "name" (printf "%s.ipBlock.except[%d]" $name $index) "value" $cidr) -}}
{{- end -}}
{{- end -}}
{{- range $selector := list "namespaceSelector" "podSelector" -}}
{{- if hasKey $set $selector -}}
{{- include "openclaw.networkPolicy.selector" (dict "name" (printf "%s.%s" $name $selector) "value" (index $peer $selector)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Validate only maps a peer caller emits; retain the existing YAML, including native null/empty semantics. */}}
{{- define "openclaw.networkPolicy.matchLabels" -}}
{{- if and (not (kindIs "invalid" .value)) (not (kindIs "map" .value)) -}}
{{- fail (printf "%s must be a Kubernetes matchLabels map" .name) -}}
{{- end -}}
{{- $labelName := "^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$" -}}
{{- range $key, $value := .value -}}
{{- include "openclaw.networkPolicy.labelKey" (dict "name" $.name "key" $key) -}}
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
