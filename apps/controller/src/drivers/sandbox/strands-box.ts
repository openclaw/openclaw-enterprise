export interface StrandsBoxOptions {
  readonly kubernetes: {
    readonly seccompProfile: string;
    readonly nodeSelector: Readonly<Record<string, string>>;
    readonly controlPlanePeer: {
      readonly namespace: string;
      readonly podLabels: Readonly<Record<string, string>>;
    };
  };
  readonly policy: {
    readonly network: {
      readonly endpoints: readonly { readonly host: string; readonly ports: readonly number[] }[];
    };
  };
}
