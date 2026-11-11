# Render a Kubernetes List from the two current Service objects and the controller image.
def tcp($port): {protocol:"TCP",port:$port};
def selector($svc):
  $svc.spec.selector | select(type=="object" and length>0) // error("missing Service Pod selector");
def vip($svc):
  $svc.spec.clusterIP | select(test("^[0-9]+(\\.[0-9]+){3}$")) // error("IPv4 ClusterIP required");
def listener_labels: {app:"oce-owner-browser"};
def meta: {name:"oce-owner-listener",namespace:"oce-system",labels:listener_labels};
if ($image|test("@sha256:[a-f0-9]{64}$")|not) or
  $api.metadata.namespace!="oce-system" or $api.metadata.name!="openclaw-enterprise-api" or
  $dns.metadata.namespace!="kube-system" or $dns.metadata.name!="kube-dns" then
  error("expected the pinned controller image, OCE API Service and cluster DNS Service")
else
  {apiVersion:"v1",kind:"List",items:[
    {apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",metadata:meta,spec:{
      podSelector:{matchLabels:listener_labels},policyTypes:["Ingress","Egress"],ingress:[],
      egress:[
        {to:[{ipBlock:{cidr:(vip($api)+"/32")}},
             {podSelector:{matchLabels:selector($api)}}],ports:[tcp(8080)]},
        {to:[{ipBlock:{cidr:(vip($dns)+"/32")}},
             {namespaceSelector:{matchLabels:{"kubernetes.io/metadata.name":"kube-system"}},
              podSelector:{matchLabels:selector($dns)}}],
         ports:[{protocol:"UDP",port:53},tcp(53)]}
      ]}},
    {apiVersion:"apps/v1",kind:"Deployment",metadata:meta,spec:{
      replicas:1,selector:{matchLabels:listener_labels},template:{
        metadata:{labels:listener_labels},spec:{
          nodeSelector:{"oce-role":"control"},automountServiceAccountToken:false,
          securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,fsGroup:1000,
            seccompProfile:{type:"RuntimeDefault"}},
          containers:[{name:"listener",image:$image,command:["node","/listener/owner-listener.mjs"],
            securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]}},
            resources:{requests:{cpu:"25m",memory:"48Mi"},limits:{cpu:"250m",memory:"128Mi"}},
            volumeMounts:[{name:"code",mountPath:"/listener",readOnly:true},{name:"tls",mountPath:"/tls",readOnly:true}]}],
          volumes:[{name:"code",configMap:{name:"oce-owner-listener"}},
                   {name:"tls",secret:{secretName:"oce-owner-browser-tls",defaultMode:288}}]
        }}}}
  ]}
end
