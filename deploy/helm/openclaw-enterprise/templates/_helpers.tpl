{{- /* One IPv4 host. Go's ParseCIDR rejects an octet above 255 and a leading zero. */ -}}
{{- define "openclaw.ipv4Host32" -}}^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])){3}/32${{- end -}}
{{- define "openclaw.validate" -}}
{{- if or (gt (len .Release.Namespace) 63) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" .Release.Namespace)) -}}
{{- fail "Helm release namespace must be a DNS-1123 label of at most 63 characters" -}}
{{- end -}}
{{- if hasKey .Values "integrations" -}}{{- fail "integrations is retired; configure ChatGPT packaging under backend.chatgpt" -}}{{- end -}}
{{- if hasKey .Values "workspaceFiles" -}}{{- fail "workspaceFiles is retired; configure private Envoy Gateway routing under gatewayRouting" -}}{{- end -}}
{{- range $name, $image := .Values.images -}}
{{- /* prepare-bootstrap-volume --image: a letter or digit, then letters, digits, dot, underscore, colon, slash, or hyphen, and a lowercase sha256 digest. */ -}}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$" $image) -}}
{{- fail (printf "images.%s must be an approved immutable SHA-256 image reference" $name) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.auth.baseUrl -}}{{- fail "auth.baseUrl must identify the public Better Auth base URL" -}}{{- end -}}
{{- /* URL parsing strips only C0 controls and spaces from the ends, so other Unicode spaces and invisible characters there (NBSP, U+3000, U+FEFF, U+200B) reach the API's parser, which refuses most of them. Both ends must be a letter, mark, number, punctuation or symbol (not Z or C, including unassigned code points). */ -}}
{{- $baseUrlText := regexReplaceAll "^[\\x00-\\x20]+|[\\x00-\\x20]+$" (toString .Values.auth.baseUrl) "" -}}
{{- if regexMatch "^[^\\pL\\pM\\pN\\pP\\pS]|[^\\pL\\pM\\pN\\pP\\pS]$" $baseUrlText -}}{{- fail "auth.baseUrl must not begin or end with Unicode spaces or invisible characters; the API's URL parser keeps them" -}}{{- end -}}
{{- /* Inside, the host parser refuses spaces, < and > (Go's URL parser keeps < and >), and drops most invisible characters. Only the joiners U+200C and U+200D, which some IDN labels need, may appear besides L, M, N, P and S; this also covers the ends, except for a joiner there. */ -}}
{{- /* A joiner outside an IDNA ContextJ position (U+200D not after a virama, U+200C not after a virama or in an Arabic joining context) renders: RE2 has no combining-class property. The API, the bootstrap Job and the profile renderer refuse it, so install or upgrade fails at the bootstrap Job. */ -}}
{{- if regexMatch "[^\\pL\\pM\\pN\\pP\\pS\\x{200C}\\x{200D}]|[<>]" $baseUrlText -}}{{- fail "auth.baseUrl must not contain spaces, invisible characters, < or >; the API's URL parser refuses or drops them in a host" -}}{{- end -}}
{{- /* The host parser maps compatibility characters (UTS #46, close to NFKC) before it checks them, and refuses those that map to a forbidden host code point (full-width ? # / : @, spacing accents that map to a space) or that UTS #46 disallows (dotted numbers such as U+2488, ideographic description characters, U+FFFC, U+FFFD). Go's URL parser keeps them all. The list is generated from Node; sign-in-chart-parity.test.mjs re-derives it. */ -}}
{{- $baseUrlHostRefused := "[\\x{00A8}\\x{00AF}\\x{00B4}\\x{00B8}\\x{02D8}-\\x{02DD}\\x{037A}\\x{0384}\\x{0385}\\x{1FBD}\\x{1FBF}-\\x{1FC1}\\x{1FCD}-\\x{1FCF}\\x{1FDD}-\\x{1FDF}\\x{1FED}\\x{1FEE}\\x{1FFD}\\x{1FFE}\\x{2017}\\x{2024}-\\x{2026}\\x{203E}\\x{2047}-\\x{2049}\\x{2100}\\x{2101}\\x{2105}\\x{2106}\\x{2488}-\\x{249B}\\x{2A74}\\x{2FF0}-\\x{2FFF}\\x{309B}\\x{309C}\\x{31EF}\\x{33C2}\\x{33C7}\\x{33D8}\\x{FC5E}-\\x{FC63}\\x{FDFA}\\x{FDFB}\\x{FE12}\\x{FE13}\\x{FE16}\\x{FE19}\\x{FE30}\\x{FE47}-\\x{FE4C}\\x{FE52}\\x{FE55}\\x{FE56}\\x{FE5F}\\x{FE64}\\x{FE65}\\x{FE68}\\x{FE6A}\\x{FE6B}\\x{FE70}\\x{FE72}\\x{FE74}\\x{FE76}\\x{FE78}\\x{FE7A}\\x{FE7C}\\x{FE7E}\\x{FF03}\\x{FF05}\\x{FF0F}\\x{FF1A}\\x{FF1C}\\x{FF1E}-\\x{FF20}\\x{FF3B}-\\x{FF3E}\\x{FF5C}\\x{FFE3}\\x{FFFC}\\x{FFFD}\\x{1F100}]" -}}
{{- if regexMatch $baseUrlHostRefused $baseUrlText -}}{{- fail "auth.baseUrl must not contain compatibility characters such as full-width ? # / : @ or dotted numbers; the API's URL parser refuses them" -}}{{- end -}}
{{- /* The API and the bootstrap Job accept only an absolute HTTP(S) origin (validHttpBaseURL). They also refuse a bare ? or #, which urlParse reads as an empty query or fragment. Go keeps an extra port colon in the host name and accepts an IPv6 zone ID; Node refuses both. */ -}}
{{- $baseUrl := urlParse $baseUrlText -}}
{{- $baseUrlPort := trimPrefix ":" (regexFind ":[0-9]+$" $baseUrl.host) -}}
{{- if or (not (has $baseUrl.scheme (list "http" "https"))) (not $baseUrl.hostname) (and (contains ":" $baseUrl.hostname) (or (not (hasPrefix "[" $baseUrl.host)) (contains "%" $baseUrl.hostname))) $baseUrl.userinfo (not (has $baseUrl.path (list "" "/"))) $baseUrl.query $baseUrl.fragment (regexMatch "[?#]" $baseUrlText) (and $baseUrlPort (gt (atoi $baseUrlPort) 65535)) -}}
{{- fail "auth.baseUrl must be an absolute HTTP(S) origin such as https://console.example.com, without a path, query, fragment or user info" -}}
{{- end -}}
{{- /* Both parsers percent-decode the host, so the character checks above also run on the decoded host name (https://ex%C2%A0ample.com), with the same deliberate strictness for the invisible characters the API drops. */ -}}
{{- if regexMatch "[^\\pL\\pM\\pN\\pP\\pS\\x{200C}\\x{200D}]|[<>]" $baseUrl.hostname -}}{{- fail "auth.baseUrl must not contain spaces, invisible characters, < or >; the API's URL parser refuses or drops them in a host" -}}{{- end -}}
{{- if regexMatch $baseUrlHostRefused $baseUrl.hostname -}}{{- fail "auth.baseUrl must not contain compatibility characters such as full-width ? # / : @ or dotted numbers; the API's URL parser refuses them" -}}{{- end -}}
{{- /* Go's URL parser keeps the written host. Node treats a host whose last label (after one trailing dot) is a number, decimal or 0x hex, as IPv4: it reads a leading zero as octal and also accepts hex (a bare 0x is 0), shorthand, a single integer and a trailing dot, then publishes that other address, and refuses a host such as example.123 or foo.1.0.0.1 that is not one. Before that check it maps compatibility characters (UTS #46): it drops variation selectors and Hangul fillers, maps the dots U+3002, U+FF0E and U+FF61, and maps digits such as １, ①, ⑩, 𝟏 and ¹ and letters such as ｘ, Ａ, ⓕ and ㏈ to ASCII. The chart maps the same characters, enough to decide whether the last label is a number; such a host must then be written as four ASCII decimal octets. A DNS name that only borrows those characters elsewhere is left alone. The lists are generated from Node; sign-in-chart-parity.test.mjs re-derives them. */ -}}
{{- $ipv4Ignored := "[\\x{034F}\\x{115F}\\x{1160}\\x{17B4}\\x{17B5}\\x{180B}-\\x{180D}\\x{180F}\\x{3164}\\x{FE00}-\\x{FE0F}\\x{FFA0}\\x{E0100}-\\x{E01EF}]" -}}
{{- $ipv4Dots := "[\\x{3002}\\x{FF0E}\\x{FF61}]" -}}
{{- $ipv4Zeros := "[\\x{2070}\\x{2080}\\x{24EA}\\x{FF10}\\x{1CCF0}\\x{1D7CE}\\x{1D7D8}\\x{1D7E2}\\x{1D7EC}\\x{1D7F6}\\x{1FBF0}]" -}}
{{- $ipv4Digits := "[\\x{00B2}\\x{00B3}\\x{00B9}\\x{2074}-\\x{2079}\\x{2081}-\\x{2089}\\x{2460}-\\x{2473}\\x{3251}-\\x{325F}\\x{32B1}-\\x{32BF}\\x{FF11}-\\x{FF19}\\x{1CCF1}-\\x{1CCF9}\\x{1D7CF}-\\x{1D7D7}\\x{1D7D9}-\\x{1D7E1}\\x{1D7E3}-\\x{1D7EB}\\x{1D7ED}-\\x{1D7F5}\\x{1D7F7}-\\x{1D7FF}\\x{1FBF1}-\\x{1FBF9}]" -}}
{{- $ipv4X := "[\\x{02E3}\\x{2093}\\x{2169}\\x{2179}\\x{24CD}\\x{24E7}\\x{FF38}\\x{FF58}\\x{1CCED}\\x{1D417}\\x{1D431}\\x{1D44B}\\x{1D465}\\x{1D47F}\\x{1D499}\\x{1D4B3}\\x{1D4CD}\\x{1D4E7}\\x{1D501}\\x{1D51B}\\x{1D535}\\x{1D54F}\\x{1D569}\\x{1D583}\\x{1D59D}\\x{1D5B7}\\x{1D5D1}\\x{1D5EB}\\x{1D605}\\x{1D61F}\\x{1D639}\\x{1D653}\\x{1D66D}\\x{1D687}\\x{1D6A1}\\x{1F147}]" -}}
{{- $ipv4Hex := "[\\x{00AA}\\x{1D2C}\\x{1D2E}\\x{1D30}\\x{1D31}\\x{1D43}\\x{1D47}-\\x{1D49}\\x{1D9C}\\x{1DA0}\\x{2090}\\x{2091}\\x{2102}\\x{212C}\\x{212D}\\x{212F}-\\x{2131}\\x{2145}-\\x{2147}\\x{216D}\\x{216E}\\x{217D}\\x{217E}\\x{24B6}-\\x{24BB}\\x{24D0}-\\x{24D5}\\x{3372}\\x{33C4}\\x{33C5}\\x{33C8}\\x{A7F2}\\x{A7F3}\\x{FB00}\\x{FF21}-\\x{FF26}\\x{FF41}-\\x{FF46}\\x{1CCD6}-\\x{1CCDB}\\x{1D400}-\\x{1D405}\\x{1D41A}-\\x{1D41F}\\x{1D434}-\\x{1D439}\\x{1D44E}-\\x{1D453}\\x{1D468}-\\x{1D46D}\\x{1D482}-\\x{1D487}\\x{1D49C}\\x{1D49E}\\x{1D49F}\\x{1D4B6}-\\x{1D4B9}\\x{1D4BB}\\x{1D4D0}-\\x{1D4D5}\\x{1D4EA}-\\x{1D4EF}\\x{1D504}\\x{1D505}\\x{1D507}-\\x{1D509}\\x{1D51E}-\\x{1D523}\\x{1D538}\\x{1D539}\\x{1D53B}-\\x{1D53D}\\x{1D552}-\\x{1D557}\\x{1D56C}-\\x{1D571}\\x{1D586}-\\x{1D58B}\\x{1D5A0}-\\x{1D5A5}\\x{1D5BA}-\\x{1D5BF}\\x{1D5D4}-\\x{1D5D9}\\x{1D5EE}-\\x{1D5F3}\\x{1D608}-\\x{1D60D}\\x{1D622}-\\x{1D627}\\x{1D63C}-\\x{1D641}\\x{1D656}-\\x{1D65B}\\x{1D670}-\\x{1D675}\\x{1D68A}-\\x{1D68F}\\x{1F12B}\\x{1F12D}\\x{1F130}-\\x{1F135}]" -}}
{{- $ipv4Written := $baseUrl.hostname -}}
{{- /* Digits and digit runs other than a lone zero become 1 and hex letter runs become a: only whether the label is a number matters here. */ -}}
{{- $ipv4Mapped := regexReplaceAll $ipv4Ignored $ipv4Written "" -}}
{{- range $map := list (list $ipv4Dots ".") (list $ipv4Zeros "0") (list $ipv4Digits "1") (list $ipv4X "x") (list $ipv4Hex "a") -}}
{{- $ipv4Mapped = regexReplaceAll (index $map 0) $ipv4Mapped (index $map 1) -}}
{{- end -}}
{{- $ipv4Labels := splitList "." $ipv4Mapped -}}
{{- if and (gt (len $ipv4Labels) 1) (eq (last $ipv4Labels) "") -}}{{- $ipv4Labels = initial $ipv4Labels -}}{{- end -}}
{{- if and (not (contains ":" $ipv4Written)) (regexMatch "^(?i)(?:[0-9]+|0x[0-9a-f]*)$" (last $ipv4Labels)) -}}
{{- if not (regexMatch "^(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}$" $ipv4Written) -}}
{{- fail "auth.baseUrl IPv4 host must be four decimal octets from 0 to 255 with no leading zeros, and a DNS name must not end in a number; the API's URL parser rewrites or refuses other spellings" -}}
{{- end -}}
{{- range $octet := splitList "." $ipv4Written -}}
{{- if gt (atoi $octet) 255 -}}
{{- fail "auth.baseUrl IPv4 host must be four decimal octets from 0 to 255 with no leading zeros, and a DNS name must not end in a number; the API's URL parser rewrites or refuses other spellings" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if not .Values.installation.secretName -}}{{- fail "installation.secretName must name the operator-created installation startup Secret" -}}{{- end -}}
{{- if not .Values.database.secretName -}}{{- fail "database.secretName must name the operator-created database URL Secret" -}}{{- end -}}
{{- if or (not .Values.auth.secretName) (not .Values.auth.secretKey) -}}{{- fail "auth must reference an operator-created Better Auth signing Secret" -}}{{- end -}}
{{- $github := .Values.auth.github -}}
{{- $recoveryUserId := toString (default "" .Values.auth.recoveryUserId) -}}
{{- if hasKey (default dict $github) "recoveryUserId" -}}{{- fail "auth.github.recoveryUserId is not a chart value; set auth.recoveryUserId" -}}{{- end -}}
{{- if and $recoveryUserId (not (regexMatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" $recoveryUserId)) -}}{{- fail "auth.recoveryUserId must be the existing local password administrator's user ID" -}}{{- end -}}
{{- $google := .Values.auth.google -}}
{{- $oidc := .Values.auth.oidc -}}
{{- $external := or (and $github $github.enabled) (and $google $google.enabled) (and $oidc $oidc.enabled) -}}
{{- if and $recoveryUserId (not $external) -}}{{- fail "auth.recoveryUserId requires auth.github.enabled, auth.google.enabled or auth.oidc.enabled" -}}{{- end -}}
{{- $passwordSignIn := toString (default "all" .Values.auth.passwordSignIn) -}}
{{- if not (has $passwordSignIn (list "all" "recovery-only")) -}}{{- fail "auth.passwordSignIn must be all or recovery-only" -}}{{- end -}}
{{- if and (eq $passwordSignIn "recovery-only") (not $external) -}}{{- fail "auth.passwordSignIn: recovery-only requires auth.github.enabled, auth.google.enabled or auth.oidc.enabled" -}}{{- end -}}
{{- /* JavaScript's trim for the allowlists below and the OIDC URLs: ASCII whitespace, Unicode Zs, U+2028, U+2029 and U+FEFF. Go's TrimSpace also drops U+0085, which the API keeps and then rejects, and keeps U+FEFF, which the API trims. The rendered env keeps the value as written. Go's lower maps U+0130 (İ) to i, but JavaScript's toLowerCase maps it to i and U+0307, which the API then refuses, so the allowlists below map it that way first. */ -}}
{{- $jsTrim := "^[\\t\\n\\x0B\\f\\r\\p{Zs}\\x{2028}\\x{2029}\\x{FEFF}]+|[\\t\\n\\x0B\\f\\r\\p{Zs}\\x{2028}\\x{2029}\\x{FEFF}]+$" -}}
{{- /* Allowlists are checked whether or not their provider is enabled, as the API does, and
an allowlist without its provider is refused: the API treats it as a startup error. */ -}}
{{- $githubLists := default dict $github -}}
{{- $googleLists := default dict $google -}}
{{- if not (or (kindIs "invalid" $githubLists.allowedOrgs) (kindIs "slice" $githubLists.allowedOrgs)) -}}{{- fail "auth.github.allowedOrgs must be a list of GitHub organization logins" -}}{{- end -}}
{{- range $org := $githubLists.allowedOrgs -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]{0,38}$" (lower (regexReplaceAll "\\x{0130}" (regexReplaceAll $jsTrim (toString $org) "") "i\u0307"))) -}}{{- fail "auth.github.allowedOrgs requires GitHub organization logins such as acme" -}}{{- end -}}
{{- end -}}
{{- if not (or (kindIs "invalid" $githubLists.allowedTeams) (kindIs "slice" $githubLists.allowedTeams)) -}}{{- fail "auth.github.allowedTeams must be a list of org/team-slug entries" -}}{{- end -}}
{{- range $team := $githubLists.allowedTeams -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9_-]{0,99}$" (lower (regexReplaceAll "\\x{0130}" (regexReplaceAll $jsTrim (toString $team) "") "i\u0307"))) -}}{{- fail "auth.github.allowedTeams requires org/team-slug entries such as acme/platform" -}}{{- end -}}
{{- end -}}
{{- if gt (add (len (default list $githubLists.allowedOrgs)) (len (default list $githubLists.allowedTeams))) 10 -}}{{- fail "auth.github.allowedOrgs and auth.github.allowedTeams list at most 10 entries together" -}}{{- end -}}
{{- if and (not (and $github $github.enabled)) (or (default list $githubLists.allowedOrgs) (default list $githubLists.allowedTeams)) -}}{{- fail "auth.github.allowedOrgs and auth.github.allowedTeams require auth.github.enabled: true; they limit GitHub sign-in only" -}}{{- end -}}
{{- if not (or (kindIs "invalid" $googleLists.allowedDomains) (kindIs "slice" $googleLists.allowedDomains)) -}}{{- fail "auth.google.allowedDomains must be a list of DNS domain names" -}}{{- end -}}
{{- range $domain := $googleLists.allowedDomains -}}
{{- $name := lower (regexReplaceAll "\\x{0130}" (regexReplaceAll $jsTrim (toString $domain) "") "i\u0307") -}}
{{- if or (gt (len $name) 253) (not (regexMatch "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$" $name)) -}}{{- fail "auth.google.allowedDomains requires DNS domain names such as example.com" -}}{{- end -}}
{{- end -}}
{{- if and (not (and $google $google.enabled)) (default list $googleLists.allowedDomains) -}}{{- fail "auth.google.allowedDomains requires auth.google.enabled: true; it limits Google sign-in only" -}}{{- end -}}
{{- if and $github $github.enabled -}}
{{- if not $recoveryUserId -}}{{- fail "auth.github.enabled requires auth.recoveryUserId: install without GitHub first, then upgrade with the administrator's user ID" -}}{{- end -}}
{{- if or (not $github.secretName) (not $github.clientIdKey) (not $github.clientSecretKey) -}}{{- fail "auth.github requires a dedicated operator-created Secret name, client ID key, and client secret key" -}}{{- end -}}
{{- if eq $github.clientIdKey $github.clientSecretKey -}}{{- fail "auth.github client ID and client secret must use different Secret keys" -}}{{- end -}}
{{- if ne $baseUrl.scheme "https" -}}{{- fail "auth.github requires an HTTPS auth.baseUrl" -}}{{- end -}}
{{- if .Values.agentNativeAdmin.enabled -}}{{- fail "auth.github requires agentNativeAdmin.enabled: false; GitHub sign-in supports host-only cookies only" -}}{{- end -}}
{{- if not (or (kindIs "invalid" $github.egressCidrs) (kindIs "slice" $github.egressCidrs)) -}}{{- fail "auth.github.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set [] in a values file or with --set-json, for HTTPS egress to any non-link-local address" -}}{{- end -}}
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
{{- if ne $baseUrl.scheme "https" -}}{{- fail "auth.google requires an HTTPS auth.baseUrl" -}}{{- end -}}
{{- if .Values.agentNativeAdmin.enabled -}}{{- fail "auth.google requires agentNativeAdmin.enabled: false; Google sign-in supports host-only cookies only" -}}{{- end -}}
{{- if not (or (kindIs "invalid" $google.egressCidrs) (kindIs "slice" $google.egressCidrs)) -}}{{- fail "auth.google.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set [] in a values file or with --set-json, for HTTPS egress to any non-link-local address" -}}{{- end -}}
{{- range $cidr := $google.egressCidrs -}}
{{- if not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" (toString $cidr)) -}}{{- fail "auth.google.egressCidrs requires explicit IPv4 CIDRs with prefixes 1 through 32" -}}{{- end -}}
{{- range $octet := splitList "." (first (splitList "/" (toString $cidr))) -}}
{{- if gt (int $octet) 255 -}}{{- fail "auth.google.egressCidrs contains an invalid IPv4 address" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and $oidc $oidc.enabled -}}
{{- if not $recoveryUserId -}}{{- fail "auth.oidc.enabled requires auth.recoveryUserId: install without OIDC first, then upgrade with the administrator's user ID" -}}{{- end -}}
{{- if or (not $oidc.secretName) (not $oidc.clientIdKey) (not $oidc.clientSecretKey) -}}{{- fail "auth.oidc requires a dedicated operator-created Secret name, client ID key, and client secret key" -}}{{- end -}}
{{- if eq $oidc.clientIdKey $oidc.clientSecretKey -}}{{- fail "auth.oidc client ID and client secret must use different Secret keys" -}}{{- end -}}
{{- if ne $baseUrl.scheme "https" -}}{{- fail "auth.oidc requires an HTTPS auth.baseUrl" -}}{{- end -}}
{{- if .Values.agentNativeAdmin.enabled -}}{{- fail "auth.oidc requires agentNativeAdmin.enabled: false; OIDC sign-in supports host-only cookies only" -}}{{- end -}}
{{- /* The API's startup checks, mirrored: https on 443, a DNS host, no userinfo, query or fragment, and one host for all four. */ -}}
{{- $endpoint := "^(?i)https://(([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?)(:443)?(/[^?#]*)?$" -}}
{{- $issuer := regexReplaceAll $jsTrim (toString (default "" $oidc.issuer)) "" -}}
{{- if or (not (regexMatch $endpoint $issuer)) (regexMatch "^(?i)https://[^/]*:" $issuer) (gt (len (regexReplaceAll $endpoint $issuer "${1}")) 253) -}}{{- fail "auth.oidc.issuer must be an https URL on port 443 with a DNS host name and no query or fragment, written without a port" -}}{{- end -}}
{{- $host := lower (regexReplaceAll $endpoint $issuer "${1}") -}}
{{- range $key := list "authorizationUrl" "tokenUrl" "jwksUrl" -}}
{{- $url := regexReplaceAll $jsTrim (toString (default "" (index $oidc $key))) "" -}}
{{- if or (not (regexMatch $endpoint $url)) (ne (lower (regexReplaceAll $endpoint $url "${1}")) $host) -}}{{- fail (printf "auth.oidc.%s must be an https URL on port 443 on the issuer's host, with no query or fragment" $key) -}}{{- end -}}
{{- end -}}
{{- if not (has (toString (default "client_secret_post" $oidc.tokenAuth)) (list "client_secret_post" "client_secret_basic")) -}}{{- fail "auth.oidc.tokenAuth must be client_secret_post or client_secret_basic" -}}{{- end -}}
{{- /* The API trims the display name and uses its default when nothing is left. RE2's \p{C} has no unassigned code points, which the API refuses at startup; a positive class would instead refuse characters newer than Helm's Unicode tables that the API accepts, such as new emoji. */ -}}
{{- $displayName := regexReplaceAll $jsTrim (toString (default "" $oidc.displayName)) "" -}}
{{- if and $displayName (not (regexMatch "^[^\\p{C}\\p{Zl}\\p{Zp}]{1,40}$" $displayName)) -}}{{- fail "auth.oidc.displayName must be 1 to 40 printable characters" -}}{{- end -}}
{{- if not (or (kindIs "invalid" $oidc.egressCidrs) (kindIs "slice" $oidc.egressCidrs)) -}}{{- fail "auth.oidc.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set [] in a values file or with --set-json, for HTTPS egress to any non-link-local address" -}}{{- end -}}
{{- range $cidr := $oidc.egressCidrs -}}
{{- if not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" (toString $cidr)) -}}{{- fail "auth.oidc.egressCidrs requires explicit IPv4 CIDRs with prefixes 1 through 32" -}}{{- end -}}
{{- range $octet := splitList "." (first (splitList "/" (toString $cidr))) -}}
{{- if gt (int $octet) 255 -}}{{- fail "auth.oidc.egressCidrs contains an invalid IPv4 address" -}}{{- end -}}
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
{{- /* The API parses these with Node isIP and refuses a zero prefix. ::ffff:d.d.d.d is rewritten to IPv4, so that form uses a prefix of 1 through 32. */ -}}
{{- range $cidr := $proxy.cidrs -}}
{{- $value := toString $cidr -}}
{{- if regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|3[0-2])$" $value -}}
{{- range $octet := splitList "." (first (splitList "/" $value)) -}}
{{- if or (gt (int $octet) 255) (and (gt (len $octet) 1) (hasPrefix "0" $octet)) -}}{{- fail "api.trustedProxy.cidrs contains an invalid IPv4 address" -}}{{- end -}}
{{- end -}}
{{- else if regexMatch "^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*/([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$" $value -}}
{{- $addr := first (splitList "/" $value) -}}
{{- $prefix := int (last (splitList "/" $value)) -}}
{{- /* A dotted tail has to end the address. Replacing it with 0:0 leaves one hex grammar: at most one ::, then fewer than 8 groups, or exactly 8 without it. */ -}}
{{- $tail := regexFind ":(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}$" $addr -}}
{{- range $octet := splitList "." (default ":0.0.0.0" $tail | trimPrefix ":") -}}
{{- if gt (int $octet) 255 -}}{{- fail "api.trustedProxy.cidrs contains an invalid IPv6 address" -}}{{- end -}}
{{- end -}}
{{- $hex := ternary (printf "%s:0:0" (trimSuffix $tail $addr)) $addr (ne $tail "") -}}
{{- $groups := len (regexFindAll "[0-9A-Fa-f]+" $hex -1) -}}
{{- if or (not (regexMatch "^(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?:::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?)?$" $hex)) (ternary (gt $groups 7) (ne $groups 8) (contains "::" $hex)) -}}{{- fail "api.trustedProxy.cidrs contains an invalid IPv6 address" -}}{{- end -}}
{{- if and (regexMatch "^(?i)::ffff:(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}$" $addr) (gt $prefix 32) -}}{{- fail "api.trustedProxy.cidrs contains an IPv4-mapped address, whose prefix must be 1 through 32" -}}{{- end -}}
{{- else -}}
{{- fail "api.trustedProxy.cidrs requires IPv4 or IPv6 CIDRs with a nonzero prefix" -}}
{{- end -}}
{{- include "openclaw.trustedProxy.validateCidrRange" $value -}}
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
{{- /* The API's startup checks, mirrored: shared session cookies are secure-only, and the console host must be inside their parent. */ -}}
{{- if ne $baseUrl.scheme "https" -}}{{- fail "agentNativeAdmin.enabled requires an HTTPS auth.baseUrl; shared session cookies are secure-only" -}}{{- end -}}
{{- $authBaseHost := trimSuffix "." (lower $baseUrl.hostname) -}}
{{- if not (or (eq $authBaseHost $sharedCookieDomain) (hasSuffix (printf ".%s" $sharedCookieDomain) $authBaseHost)) -}}{{- fail "agentNativeAdmin.sharedCookieDomain must contain the auth.baseUrl host" -}}{{- end -}}
{{- if not .Values.gatewayRouting.enabled -}}{{- fail "agentNativeAdmin.enabled requires gatewayRouting.enabled so the API can reach private Agent gateways" -}}{{- end -}}
{{- end -}}
{{- /* The bootstrap Job refuses plain HTTP unless the host is 127.0.0.1, localhost, or ::1. Helm reads http://[::1] as hostname ::1. Other spellings of 127.0.0.1 (127.1, 0177.0.0.1, a trailing dot) are refused here. */ -}}
{{- if and (ne $baseUrl.scheme "https") (not (has (lower $baseUrl.hostname) (list "127.0.0.1" "localhost" "::1"))) -}}{{- fail "auth.baseUrl must use HTTPS unless its host is 127.0.0.1 or localhost or ::1; the bootstrap Job refuses plain HTTP elsewhere" -}}{{- end -}}
{{- /* The bootstrap Job trims with JavaScript trim, lowercases, then requires local@domain.tld. The rendered env keeps the value as written. */ -}}
{{- $adminEmailTrim := "^[\\t\\n\\x0B\\f\\r\\p{Zs}\\x{2028}\\x{2029}\\x{FEFF}]+|[\\t\\n\\x0B\\f\\r\\p{Zs}\\x{2028}\\x{2029}\\x{FEFF}]+$" -}}
{{- $adminEmail := lower (regexReplaceAll $adminEmailTrim (toString .Values.bootstrap.adminEmail) "") -}}
{{- if not (regexMatch "^[^@\\t\\n\\x0B\\f\\r\\p{Zs}\\x{2028}\\x{2029}\\x{FEFF}]+@[^@\\t\\n\\x0B\\f\\r\\p{Zs}\\x{2028}\\x{2029}\\x{FEFF}]+\\.[^@\\t\\n\\x0B\\f\\r\\p{Zs}\\x{2028}\\x{2029}\\x{FEFF}]+$" $adminEmail) -}}
{{- fail "bootstrap.adminEmail must contain a valid administrator email" -}}
{{- end -}}
{{- /* The bootstrap Job checks installation.name with isName before it creates anything. */ -}}
{{- $installationName := toString .Values.installation.name -}}
{{- if or (ne $installationName (trim $installationName)) (hasPrefix "\uFEFF" $installationName) (hasSuffix "\uFEFF" $installationName) (not (regexMatch "^[^\\x00-\\x1f\\x7f-\\x9f\\x{2028}\\x{2029}]{1,200}$" $installationName)) -}}
{{- fail "installation.name must follow the Name rule: 1 to 200 characters, with no leading or trailing whitespace and no control characters or line or paragraph separators" -}}
{{- end -}}
{{- if or (not .Values.bootstrap.password.claimName) (not .Values.bootstrap.password.mountPath) (not .Values.bootstrap.password.fileName) -}}
{{- fail "bootstrap.password must reference an existing protected PVC output path" -}}
{{- end -}}
{{- /* Kubernetes DNS-subdomain object names, as in prepare-bootstrap-volume: at most 253 characters total. */ -}}
{{- $claimName := toString .Values.bootstrap.password.claimName -}}
{{- if or (gt (len $claimName) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $claimName)) -}}
{{- fail "bootstrap.password.claimName must be a DNS subdomain of at most 253 characters" -}}
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
{{- /* The bootstrap Job's bootstrapOutputPath requires an absolute file. A relative mount path joins into a relative OCC_BOOTSTRAP_PASSWORD_FILE. */ -}}
{{- if not (hasPrefix "/" (toString .Values.bootstrap.password.mountPath)) -}}
{{- fail "bootstrap.password.mountPath must be an absolute path" -}}
{{- end -}}
{{- /* Database routing uses numeric TCP ports in bootstrap and controller NetworkPolicies. */ -}}
{{- if or (not (regexMatch "^[1-9][0-9]{0,4}$" (toString .Values.database.port))) (gt (int .Values.database.port) 65535) -}}
{{- fail "database.port must be an integer TCP port from 1 to 65535" -}}
{{- end -}}
{{- /* The server reads OCC_PORT with decimal Number(); Kubernetes YAML reads an unquoted leading zero as octal. */ -}}
{{- if or (not (regexMatch "^[1-9][0-9]*$" (toString .Values.api.port))) (gt (int .Values.api.port) 65535) -}}
{{- fail "api.port must be an integer TCP port from 1 to 65535" -}}
{{- end -}}
{{- if not .Values.api.clients -}}{{- fail "api.clients must contain exact approved client selectors" -}}{{- end -}}
{{- range $index, $client := .Values.api.clients -}}
{{- if or (not $client.namespace) (not $client.podLabels) -}}
{{- fail (printf "api.clients[%d] requires an exact namespace and nonempty Pod selector" $index) -}}
{{- end -}}
{{- /* NetworkPolicies select these peers by kubernetes.io/metadata.name, which holds a Namespace name: a DNS label of at most 63 characters. */ -}}
{{- if or (gt (len (toString $client.namespace)) 63) (not (regexMatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" (toString $client.namespace))) -}}
{{- fail (printf "api.clients[%d].namespace must be a Kubernetes namespace name (a DNS label of at most 63 characters)" $index) -}}
{{- end -}}
{{- end -}}
{{- if or (not .Values.dns.namespace) (not .Values.dns.podLabels) -}}
{{- fail "dns requires an exact namespace and nonempty Pod selector" -}}
{{- end -}}
{{- if or (gt (len (toString .Values.dns.namespace)) 63) (not (regexMatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" (toString .Values.dns.namespace))) -}}
{{- fail "dns.namespace must be a Kubernetes namespace name (a DNS label of at most 63 characters)" -}}
{{- end -}}
{{- if hasKey .Values.database "cidr" -}}{{- fail "database.cidr is retired; configure database.cidrs with explicit IPv4 /32 hosts" -}}{{- end -}}
{{- if hasKey .Values.cluster "cidr" -}}{{- fail "cluster.cidr is retired; configure cluster.cidrs with explicit IPv4 /32 hosts" -}}{{- end -}}
{{- range $name, $cidrs := dict "database" .Values.database.cidrs "cluster" .Values.cluster.cidrs -}}
{{- if or (not (kindIs "slice" $cidrs)) (eq (len $cidrs) 0) -}}
{{- fail (printf "%s.cidrs must contain at least one explicit IPv4 /32 host" $name) -}}
{{- end -}}
{{- range $index, $cidr := $cidrs -}}
{{- if not (regexMatch (include "openclaw.ipv4Host32" .) $cidr) -}}
{{- fail (printf "%s.cidrs[%d] must identify exactly one IPv4 host with /32" $name $index) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (hasKey .Values.controlPlane "nodeSelector") (not (kindIs "invalid" .Values.controlPlane.nodeSelector)) -}}
{{- if not (kindIs "map" .Values.controlPlane.nodeSelector) -}}{{- fail "controlPlane.nodeSelector must be a map of Kubernetes node labels" -}}{{- end -}}
{{- /* prepare-bootstrap-volume is_label_key and is_label_value. A qualified key is a DNS subdomain prefix plus a label name; a value is empty or a label name. */ -}}
{{- $labelName := "^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$" -}}
{{- range $key, $value := .Values.controlPlane.nodeSelector }}
{{- if or (not (kindIs "string" $value)) (gt (len $value) 63) (and (ne $value "") (not (regexMatch $labelName $value))) -}}
{{- fail "controlPlane.nodeSelector values must be Kubernetes label values" -}}
{{- end -}}
{{- if contains "/" $key -}}
{{- $parts := splitList "/" $key -}}
{{- $prefix := index $parts 0 -}}
{{- $name := index $parts 1 -}}
{{- if or (ne (len $parts) 2) (gt (len $prefix) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $prefix)) (gt (len $name) 63) (not (regexMatch $labelName $name)) -}}
{{- fail "controlPlane.nodeSelector keys must be Kubernetes label keys" -}}
{{- end -}}
{{- else if or (gt (len $key) 63) (not (regexMatch $labelName $key)) -}}
{{- fail "controlPlane.nodeSelector keys must be Kubernetes label keys" -}}
{{- end -}}
{{- end -}}
{{- end -}}
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
{{- /* The CA is mounted in API, worker, migration and bootstrap. Kubernetes requires each container's mount paths to be unique. */ -}}
{{- $reservedCaMounts := list "/etc/openclaw/installation" "/run/openclaw-worker" (toString .Values.bootstrap.password.mountPath) -}}
{{- if .Values.executionCluster.enabled -}}
{{- $reservedCaMounts = append $reservedCaMounts "/etc/openclaw/execution" -}}
{{- end -}}
{{- if .Values.repositoryCredentials.enabled -}}
{{- $reservedCaMounts = concat $reservedCaMounts (list "/etc/openclaw/repository-registry" "/etc/openclaw/repository-ca" "/var/run/secrets/kubernetes.io/serviceaccount" "/run/openclaw/repository-control") -}}
{{- end -}}
{{- if .Values.gatewayRouting.enabled -}}
{{- $reservedCaMounts = append $reservedCaMounts "/etc/openclaw/gateway-api-key" -}}
{{- if or (not .Values.gatewayRouting.issuerRef.name) .Values.gatewayRouting.caSecretName -}}
{{- $reservedCaMounts = append $reservedCaMounts "/etc/openclaw/gateway-ca" -}}
{{- end -}}
{{- end -}}
{{- if .Values.backend.chatgpt.enabled -}}
{{- $reservedCaMounts = append $reservedCaMounts "/etc/openclaw/chatgpt" -}}
{{- end -}}
{{- if has (toString .Values.database.caMountPath) $reservedCaMounts -}}
{{- fail "database.caMountPath must be distinct from other active mounts in the production database clients" -}}
{{- end -}}
{{- end -}}
{{- if .Values.executionCluster.enabled -}}
{{- $execution := .Values.executionCluster -}}
{{- if or (not $execution.apiKubeconfigSecretName) (not $execution.workerKubeconfigSecretName) (eq $execution.apiKubeconfigSecretName $execution.workerKubeconfigSecretName) -}}
{{- fail "executionCluster requires separate API and worker kubeconfig Secrets" -}}
{{- end -}}
{{- if or (not $execution.apiCidrs) (not $execution.kubeconfigKey) -}}
{{- fail "executionCluster requires explicit API CIDRs and kubeconfig key" -}}
{{- end -}}
{{- end -}}
{{- if .Values.slackProxy.enabled -}}
{{- $proxy := .Values.slackProxy -}}
{{- if .Values.api.channelDirectoryProxyUrl -}}{{- fail "api.channelDirectoryProxyUrl must be empty when slackProxy.enabled uses the chart-managed Service" -}}{{- end -}}
{{- if not (kindIs "bool" $proxy.enabled) -}}{{- fail "slackProxy.enabled must be a boolean" -}}{{- end -}}
{{- if or (gt (len $proxy.serviceName) 63) (not (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" $proxy.serviceName)) -}}
{{- fail "slackProxy.serviceName must be a DNS-1035 Service name" -}}
{{- end -}}
{{- if or (not (regexMatch "^[1-9][0-9]*$" (toString $proxy.port))) (lt (int $proxy.port) 1) (gt (int $proxy.port) 65535) -}}
{{- fail "slackProxy.port must be an integer TCP port from 1 to 65535" -}}
{{- end -}}
{{- end -}}
{{- if .Values.repositoryCredentials.enabled -}}
{{- $credentials := .Values.repositoryCredentials -}}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" $credentials.image) -}}
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
{{- /* Installation startup checks a GitHub Backend ID with isBackendId, then refuses one longer than 200 UTF-16 code units because repository bindings store it under that bound. */ -}}
{{- $backendId := toString $credentials.backendId -}}
{{- if or (ne $backendId (trim $backendId)) (hasPrefix "\uFEFF" $backendId) (hasSuffix "\uFEFF" $backendId) (not (regexMatch "^[^\\x00-\\x1f\\x7f-\\x9f\\x{2028}\\x{2029}]{1,200}$" $backendId)) -}}
{{- fail "repositoryCredentials.backendId must follow the Backend ID rule: 1 to 200 characters, with no leading or trailing whitespace and no control characters or line or paragraph separators" -}}
{{- end -}}
{{- /* A code point above U+FFFF is one character and two UTF-16 code units. */ -}}
{{- $utf16Units := add (len (regexFindAll "." $backendId -1)) (len (regexFindAll "[\\x{10000}-\\x{10FFFF}]" $backendId -1)) -}}
{{- if gt $utf16Units 200 -}}
{{- fail "repositoryCredentials.backendId must fit in 200 UTF-16 code units for a GitHub Backend, because repository bindings store it under that bound" -}}
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
{{- if and (hasKey $routing "hostname") (not (kindIs "string" $routing.hostname)) -}}{{- fail "gatewayRouting.hostname must be a string when supplied" -}}{{- end -}}
{{- /* The same custom hostname enters the Gateway listener and Certificate SANs. Compute validates it while loading the Installation; empty keeps automatic Service DNS derivation. */ -}}
{{- if and $routing.hostname (or (gt (len $routing.hostname) 253) (not (regexMatch "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$" $routing.hostname))) -}}
{{- fail "gatewayRouting.hostname must be a DNS hostname without a port or path" -}}
{{- end -}}

{{- if not $routing.gatewayClassName -}}{{- fail "gatewayRouting.gatewayClassName must reference an operator-created GatewayClass" -}}{{- end -}}
{{- /* Compute required() keeps the original string. validateGatewayName then refuses a name that is not DNS-safe, or longer than 63 characters, because Envoy copies it into the owning-gateway-name label. Check the name the Gateway template emits, including surrounding spaces. */ -}}
{{- $gatewayName := include "openclaw.gatewayRouting.gatewayName" . -}}
{{- if or (gt (len $gatewayName) 63) (not (regexMatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$" $gatewayName)) -}}
{{- fail "gatewayRouting.gatewayName must be a DNS-safe Kubernetes resource name" -}}
{{- end -}}
{{- if not $routing.envoyNamespace -}}{{- fail "gatewayRouting.envoyNamespace must identify the existing Envoy Gateway controller namespace" -}}{{- end -}}
{{- /* The Compute driver (isKubernetesNamespaceName) refuses anything that is not a DNS label of at most 63 characters, as Kubernetes does for a Namespace name. */ -}}
{{- if or (gt (len (toString $routing.envoyNamespace)) 63) (not (regexMatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" (toString $routing.envoyNamespace))) -}}
{{- fail "gatewayRouting.envoyNamespace must be a Kubernetes namespace name (a DNS label of at most 63 characters)" -}}
{{- end -}}
{{- if not $routing.issuerRef -}}{{- fail "gatewayRouting.issuerRef must be configured" -}}{{- end -}}
{{- if and (hasKey $routing.issuerRef "name") (not (kindIs "string" $routing.issuerRef.name)) -}}{{- fail "gatewayRouting.issuerRef.name must be a string when supplied" -}}{{- end -}}
{{- if $routing.issuerRef.name -}}
{{- if or (not $routing.issuerRef.kind) (not $routing.issuerRef.group) -}}{{- fail "gatewayRouting.issuerRef kind and group must be set with an external issuer" -}}{{- end -}}
{{- else -}}
{{- if or $routing.caSecretName $routing.caSecretKey -}}{{- fail "gatewayRouting.caSecretName and gatewayRouting.caSecretKey require an external issuerRef.name" -}}{{- end -}}
{{- end -}}
{{- if not $routing.apiKeySecretName -}}{{- fail "gatewayRouting.apiKeySecretName must reference an operator-created Opaque Secret with key 'occ'" -}}{{- end -}}
{{- if and (or $routing.caSecretName $routing.caSecretKey) (or (not $routing.caSecretName) (not $routing.caSecretKey)) -}}{{- fail "gatewayRouting.caSecretName and gatewayRouting.caSecretKey must be set together" -}}{{- end -}}
{{- if or (not (regexMatch "^[1-9][0-9]*$" (toString $routing.tenantGatewayPort))) (lt (int $routing.tenantGatewayPort) 1) (gt (int $routing.tenantGatewayPort) 65535) -}}
{{- fail "gatewayRouting.tenantGatewayPort must be an integer TCP port from 1 to 65535" -}}
{{- end -}}
{{- /* Compute's PLUGIN_RUNTIME_STATUS_PORT: the private status listener on every Gateway Pod. */ -}}
{{- $runtimeStatusPort := 18791 -}}
{{- if eq (int $routing.tenantGatewayPort) $runtimeStatusPort -}}{{- fail (printf "gatewayRouting.tenantGatewayPort cannot use the reserved runtime status port %d" $runtimeStatusPort) -}}{{- end -}}
{{- if or (not (regexMatch "^[1-9][0-9]*$" (toString $routing.envoyHttpsTargetPort))) (lt (int $routing.envoyHttpsTargetPort) 1) (gt (int $routing.envoyHttpsTargetPort) 65535) -}}
{{- fail "gatewayRouting.envoyHttpsTargetPort must be an integer TCP port from 1 to 65535" -}}
{{- end -}}
{{- if not $routing.envoyGatewayPodLabels -}}{{- fail "gatewayRouting.envoyGatewayPodLabels must select the Envoy Gateway control-plane Pods for xDS egress" -}}{{- end -}}
{{- if $routing.sandbox.enabled -}}
{{- if not (regexMatch "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$" $routing.sandbox.domain) -}}{{- fail "gatewayRouting.sandbox.domain must be a DNS hostname without wildcard, scheme, port or path" -}}{{- end -}}
{{- /* Dedicated Agent routes use agent-<32 hex>.<domain>, which must fit the 253-character Gateway API hostname limit. */ -}}
{{- if gt (len $routing.sandbox.domain) 214 -}}{{- fail "gatewayRouting.sandbox.domain must not exceed 214 characters, leaving room for the agent-<32 hex>. prefix of dedicated Agent hostnames" -}}{{- end -}}
{{- if not $routing.sandbox.tlsSecretName -}}{{- fail "gatewayRouting.sandbox.tlsSecretName must reference a wildcard certificate Secret" -}}{{- end -}}
{{- if or (not (regexMatch "^[1-9][0-9]*$" (toString $routing.sandbox.listenerPort))) (lt (int $routing.sandbox.listenerPort) 1024) (gt (int $routing.sandbox.listenerPort) 65535) (eq (int $routing.sandbox.listenerPort) (int $routing.envoyHttpsTargetPort)) -}}{{- fail "gatewayRouting.sandbox.listenerPort must be an integer unprivileged port distinct from private Envoy HTTPS" -}}{{- end -}}
{{- if ge (int $routing.tenantGatewayPort) 65535 -}}{{- fail "gatewayRouting.tenantGatewayPort must leave room for the adjacent sandbox port" -}}{{- end -}}
{{- if eq (add1 (int $routing.tenantGatewayPort)) $runtimeStatusPort -}}{{- fail (printf "gatewayRouting.tenantGatewayPort cannot be %d with the sandbox enabled: the adjacent sandbox port is the reserved runtime status port %d" (sub $runtimeStatusPort 1) $runtimeStatusPort) -}}{{- end -}}
{{- if not $routing.sandbox.ingressPeers -}}{{- fail "gatewayRouting.sandbox.ingressPeers must explicitly select public ingress sources" -}}{{- end -}}
{{- $cookieDomain := trimPrefix "." (lower .Values.agentNativeAdmin.sharedCookieDomain) -}}
{{- if and $cookieDomain (or (eq $routing.sandbox.domain $cookieDomain) (hasSuffix (printf ".%s" $cookieDomain) $routing.sandbox.domain) (hasSuffix (printf ".%s" $routing.sandbox.domain) $cookieDomain)) -}}{{- fail "gatewayRouting.sandbox.domain must be outside the OCE shared session cookie domain" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- /* Dedicated Secrets (findings 1037, 1044, 1046, 1048, 1054): each Secret an enabled feature reads, or cert-manager writes, needs its own name. A shared Secret mounts other credentials into a component, is overwritten by cert-manager (the Gateway TLS and root CA), or turns its other entries into keys Envoy Gateway's apiKeyAuth accepts (gatewayRouting.apiKeySecretName). Chart-named and generated Secrets come first and the log collector's last, so a refusal names the operator's setting. The public CA settings (marked "ca") may share one Secret with each other, such as one trust bundle: each mounts only its selected key, which holds public data (finding 1059). They stay apart from database.secretName, whose migration URL key a matching CA key would mount into the API and worker. */ -}}
{{- $routing := .Values.gatewayRouting -}}
{{- $roles := list -}}
{{- if and $routing.enabled (not $routing.issuerRef.name) -}}{{- $roles = append $roles (list "the generated Gateway root CA" (include "openclaw.gatewayRouting.rootSecretName" .)) -}}{{- end -}}
{{- $roles = concat $roles (list (list "installation.secretName" .Values.installation.secretName) (list "database.secretName" .Values.database.secretName) (list "auth.secretName" .Values.auth.secretName)) -}}
{{- if $routing.enabled -}}{{- $roles = append $roles (list "gatewayRouting.tlsSecretName" (include "openclaw.gatewayRouting.tlsSecretName" .)) -}}{{- end -}}
{{- if .Values.backend.chatgpt.enabled -}}{{- $roles = append $roles (list "backend.chatgpt.secretName" .Values.backend.chatgpt.secretName) -}}{{- end -}}
{{- $roles = append $roles (list "database.caSecretName" .Values.database.caSecretName "ca") -}}
{{- if $routing.enabled -}}
{{- if $routing.sandbox.enabled -}}{{- $roles = append $roles (list "gatewayRouting.sandbox.tlsSecretName" $routing.sandbox.tlsSecretName) -}}{{- end -}}
{{- $roles = concat $roles (list (list "gatewayRouting.apiKeySecretName" $routing.apiKeySecretName) (list "gatewayRouting.caSecretName" $routing.caSecretName "ca")) -}}
{{- end -}}
{{- range $provider := list "github" "google" "oidc" -}}
{{- $signIn := index $.Values.auth $provider -}}
{{- if and $signIn $signIn.enabled -}}{{- $roles = append $roles (list (printf "auth.%s.secretName" $provider) $signIn.secretName) -}}{{- end -}}
{{- end -}}
{{- if .Values.executionCluster.enabled -}}
{{- range $key := list "apiKubeconfigSecretName" "workerKubeconfigSecretName" -}}{{- $roles = append $roles (list (printf "executionCluster.%s" $key) (index $.Values.executionCluster $key)) -}}{{- end -}}
{{- end -}}
{{- if .Values.repositoryCredentials.enabled -}}
{{- range $key := list "serviceConfigSecretName" "appKeySecretName" "tlsSecretName" -}}{{- $roles = append $roles (list (printf "repositoryCredentials.%s" $key) (index $.Values.repositoryCredentials $key)) -}}{{- end -}}
{{- $roles = append $roles (list "repositoryCredentials.publicCaSecretName" .Values.repositoryCredentials.publicCaSecretName "ca") -}}
{{- end -}}
{{- if .Values.logging.collector.enabled -}}
{{- range $key := list "configSecretName" "envSecretName" -}}{{- $roles = append $roles (list (printf "logging.collector.%s" $key) (index $.Values.logging.collector $key)) -}}{{- end -}}
{{- end -}}
{{- $holders := dict -}}
{{- $groups := dict -}}
{{- range $role := $roles -}}
{{- if index $role 1 -}}
{{- $name := toString (index $role 1) -}}
{{- $group := ternary (last $role) "" (eq (len $role) 3) -}}
{{- if not (hasKey $holders $name) -}}
{{- $_ := set $holders $name (index $role 0) -}}
{{- $_ := set $groups $name $group -}}
{{- else if not (and $group (eq $group (get $groups $name))) -}}
{{- fail (printf "%s must name a dedicated Secret; %s is also %s" (index $role 0) $name (get $holders $name)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* Check CIDR meaning separately from syntax so every spelling has the API's
IPv4-mapped prefix rules. Node also matches IPv4 peers against IPv6 subnets that
contain the entire ::ffff:0:0/96 range. Such entries must not trust forwarded headers. */ -}}
{{- define "openclaw.trustedProxy.validateCidrRange" -}}
{{- $address := lower (first (splitList "/" .)) -}}
{{- if contains ":" $address -}}
{{- $prefix := int (last (splitList "/" .)) -}}
{{- /* Both checks concern only the first 96 bits; a dotted tail occupies the final two groups. */ -}}
{{- $tail := regexFind "[0-9]+(\\.[0-9]+){3}$" $address -}}
{{- if $tail -}}{{- $address = printf "%s0:0" (trimSuffix $tail $address) -}}{{- end -}}
{{- $halves := splitList "::" $address -}}
{{- $groups := splitList ":" $address -}}
{{- if eq (len $halves) 2 -}}
{{- $left := compact (splitList ":" (first $halves)) -}}
{{- $right := compact (splitList ":" (last $halves)) -}}
{{- $missing := sub 8 (add (len $left) (len $right)) -}}
{{- if lt $missing 1 -}}{{- fail "api.trustedProxy.cidrs contains an invalid IPv6 address" -}}{{- end -}}
{{- $groups = concat $left (splitList ":" (trimSuffix ":" (repeat (int $missing) "0:"))) $right -}}
{{- end -}}
{{- /* Guard expansion before inspecting bits; malformed input must never panic the template. */ -}}
{{- if or (gt (len $halves) 2) (ne (len $groups) 8) -}}{{- fail "api.trustedProxy.cidrs contains an invalid IPv6 address" -}}{{- end -}}
{{- $bits := "" -}}
{{- range $group := $groups -}}
{{- $bits = printf "%s%016b" $bits (int (printf "0x%s" $group)) -}}
{{- end -}}
{{- $mappedPrefix := printf "%s%s" (repeat 80 "0") (repeat 16 "1") -}}
{{- if hasPrefix $mappedPrefix $bits -}}
{{- if gt $prefix 32 -}}{{- fail "api.trustedProxy.cidrs contains an IPv4-mapped address, whose prefix must be 1 through 32" -}}{{- end -}}
{{- else if and (le $prefix 96) (eq (substr 0 $prefix $bits) (substr 0 $prefix $mappedPrefix)) -}}
{{- fail "api.trustedProxy.cidrs must not trust every address (covers every IPv4 address)" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openclaw.trustedProxy.header" -}}
{{- $proxy := default dict .Values.api.trustedProxy -}}
{{- if eq (toString $proxy.preset) "generic" -}}{{- lower (toString $proxy.clientAddressHeader) -}}{{- else -}}x-forwarded-for{{- end -}}
{{- end -}}

{{- define "openclaw.labels" -}}
app.kubernetes.io/name: openclaw-enterprise
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
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
      name: {{ .secretName | quote }}
      key: {{ .key | quote }}
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

{{/* Decimal, matching JavaScript Number. Sprig int is octal, so it must not parse these.
     A values file delivers a float64, and toString prints 1000000 and above as an exponent. */}}
{{- define "openclaw.positiveSafeInteger" -}}
{{- $raw := toString .value -}}
{{- if and (kindIs "float64" .value) (eq (floor .value) .value) -}}
{{- $raw = printf "%.0f" .value -}}
{{- end -}}
{{- $parsed := atoi $raw -}}
{{- if or (not (regexMatch "^[0-9]+$" $raw)) (lt $parsed 1) (gt $parsed 9007199254740991) -}}
{{- fail (printf "%s must be a positive safe integer" .name) -}}
{{- end -}}
{{- $raw -}}
{{- end -}}

{{/* Reject obvious quantity syntax errors; Kubernetes owns full quantity validation.
     Preserve its JSON-text whitespace handling without emulating exponent bounds or numeric parsing. */}}
{{- define "openclaw.quantity" -}}
{{- $pattern := "^[+-]?([0-9]*(\\.[0-9]*)?)?(([KMGT]i)|[numkMGTPE]|([eE][+-]?[0-9]+))?$|^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)[PE]i$" -}}
{{- $encoded := toJson (toString .value) -}}
{{- $quantity := $encoded -}}
{{- if ge (len $encoded) 2 -}}
{{- $last := int (sub (len $encoded) 1) -}}
{{- if and (eq (substr 0 1 $encoded) "\"") (eq (substr $last (len $encoded) $encoded) "\"") -}}
{{- $quantity = trim (substr 1 $last $encoded) -}}
{{- end -}}
{{- end -}}
{{- if or (eq $quantity "") (not (regexMatch $pattern $quantity)) -}}
{{- fail (printf "%s must be a Kubernetes quantity" .name) -}}
{{- end -}}
{{- end -}}

{{/* A null map clears chart defaults. Skip it; indexing nil aborts install and upgrade. */}}
{{- define "openclaw.resourceRequirements" -}}
{{- if .requirements -}}
{{- $name := .name -}}
{{- $requirements := .requirements -}}
{{- range $section := list "requests" "limits" -}}
{{- with index $requirements $section -}}
{{- range $key, $qty := . -}}
{{- include "openclaw.quantity" (dict "name" (printf "%s.%s.%s" $name $section $key) "value" $qty) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
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

{{/*
Install and upgrade notice for api.trustedProxy. It warns rather than fails: installs whose
API sees each client's own address (for example, behind a source-preserving NLB) are valid.
*/}}
{{- define "openclaw.trustedProxy.notice" -}}
{{- $proxy := default dict .Values.api.trustedProxy -}}
{{- $github := default dict .Values.auth.github -}}
{{- $google := default dict .Values.auth.google -}}
{{- $oidc := default dict .Values.auth.oidc -}}
{{- if not $proxy.preset -}}
{{- if or $github.enabled $google.enabled $oidc.enabled -}}
WARNING: api.trustedProxy is not set. With GitHub, Google or OIDC sign-in, failed
password sign-ins are then limited per email only, and external sign-in
starts have no per-client limit, because every browser behind a proxy shares its
address. Set api.trustedProxy unless the API sees each client's own address, as
behind a Network Load Balancer that preserves source addresses.
{{- else -}}
NOTE: api.trustedProxy is not set, so failed password sign-ins are limited per
email only. Set api.trustedProxy when a proxy fronts the API to add the
per-client-address limit.
{{- end -}}
{{- end -}}
{{- end -}}
