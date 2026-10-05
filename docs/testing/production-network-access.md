# Production workload network access

Prepare the [disposable cluster and fixture image](kubernetes.md#kubernetes-http-fixture), then run the chart access matrix:

```sh
OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig \
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce \
OCC_TEST_KUBERNETES_IMAGE=oce-fixture:local \
  node --test tests/integration/production-network-access.test.mjs
```

Helm and yq are also required. This suite needs no database or model credential;
it runs in the required `k3d-fixture-state` CI lane. Probe Pods use the
chart's actual workload labels and rendered NetworkPolicies. The matrix checks
connections through the enforcing CNI, with reachable controls around denials:

| Workload / phase                    | DNS   | Database | Kubernetes API | Exporter | Provider / private Envoy      |
| ----------------------------------- | ----- | -------- | -------------- | -------- | ----------------------------- |
| Initialization hook, before install | Allow | Allow    | Deny           | Deny     | Deny                          |
| API, installed                      | Allow | Allow    | Allow          | Deny     | Only when configured          |
| Worker, installed                   | Allow | Allow    | Allow          | Deny     | Private Envoy when configured |
| Initialization, installed           | Allow | Allow    | Allow          | Deny     | Deny                          |
| Collector                           | Allow | Deny     | Allow          | Allow    | Deny                          |
| Unknown / missing component         | Deny  | Deny     | Deny           | Deny     | Deny                          |

Unexpected destinations and ungranted ports remain denied. Each dependency is a
listening fixture endpoint; DNS uses the cluster resolver. This proves network
access for chart identities, not controller startup, database authentication,
provider behavior, or a production Helm installation. Other releases are outside
this chart's selectors; absence of a matching policy does not imply denial.
