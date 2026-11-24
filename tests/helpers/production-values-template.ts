export const productionChartPath = "deploy/helm/openclaw-enterprise";

export function productionValuesTemplateArgs(
  chart: string,
  extraArgs: readonly string[] = [],
): string[] {
  return [
    "template",
    "oce",
    chart,
    "--namespace",
    "openclaw-system",
    "--values",
    "deploy/examples/production/values.yaml",
    ...extraArgs,
  ];
}
