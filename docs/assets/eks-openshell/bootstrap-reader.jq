# Mount only the completed bootstrap output PVC. The reader exits after ten minutes.
if ($image|test("@sha256:[a-f0-9]{64}$")|not) then error("pin the controller image") else
{apiVersion:"v1",kind:"Pod",metadata:{name:"oce-owner-bootstrap-reader",namespace:"oce-system"},
 spec:{automountServiceAccountToken:false,restartPolicy:"Never",activeDeadlineSeconds:600,
   nodeSelector:{"oce-role":"control"},
   securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,seccompProfile:{type:"RuntimeDefault"}},
   containers:[{name:"reader",image:$image,command:["node","-e","setTimeout(() => {}, 590000)"],
     securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]}},
     volumeMounts:[{name:"bootstrap",mountPath:"/bootstrap",readOnly:true}]}],
   volumes:[{name:"bootstrap",persistentVolumeClaim:{claimName:"occ-bootstrap-admin-password",readOnly:true}}]}}
end
