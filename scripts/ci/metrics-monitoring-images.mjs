// Shared by CI preparation and the metrics integration containers so every
// implicit run uses the same digest that preparation verified.
export const metricsMonitoringImages = {
  prometheus:
    "docker.io/prom/prometheus@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0",
  grafana:
    "docker.io/grafana/grafana@sha256:ac461fb352abc50da10a51c7d02462e9c05488f11f53f14b3ad79a8145f638a0",
};
