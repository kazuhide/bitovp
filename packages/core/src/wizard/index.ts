/**
 * The wizard's plan-producing code — the layer between what an operator fills in and the
 * `EncodingPlan` the compiler consumes.
 *
 * It lives in core rather than in `apps/web` because the verification runner has to use it.
 * Until now the runner submitted fixture JSON directly, so a corpus run proved the compiler,
 * the orchestrator and Bitmovin, and proved NOTHING about the plan the wizard actually
 * generates — the deep-equal between the two was asserted by a unit test and never exercised
 * against a real encoder. Verifying artefacts produced from a plan the product would not have
 * built is a weaker claim than it looks.
 *
 * Both modules are pure data transforms with no UI imports (verified before the move: one
 * imported a core type, the other a core schema plus a two-line predicate). `apps/web` keeps
 * thin re-export shims at the old paths, so no call site there changed.
 */
export * from "./build-plan";
export * from "./placeholder";
export * from "./plan-to-wizard";
