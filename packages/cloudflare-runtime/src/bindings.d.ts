// Wrangler emits literal example-config strings. Runtime values may differ,
// while resource bindings must remain compatible with the generated types.
export type WidenWranglerStringBindings<Bindings extends object> = {
  [Binding in keyof Bindings]: Bindings[Binding] extends string ? string : Bindings[Binding];
};

export type WithRuntimeNarrowing<Generated extends object, Runtime extends object> = Omit<Generated, keyof Runtime> & Runtime;

export type IncompatibleGeneratedBindings<Generated extends object, Runtime extends object> = {
  [Binding in keyof Generated & keyof Runtime]: Generated[Binding] extends Runtime[Binding] ? never : Binding;
}[keyof Generated & keyof Runtime];

export type AssertNoIncompatibleGeneratedBindings<Bindings extends never> = Bindings;
