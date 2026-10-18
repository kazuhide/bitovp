/**
 * Moved to `packages/core/src/wizard/build-plan.ts`.
 *
 * The verification runner has to build the plan the way the wizard does — otherwise a corpus
 * run verifies artefacts produced from a plan the product would never have generated. The
 * worker cannot import from `apps/web`, so the module moved into core, where both sides reach
 * it. This shim keeps every existing import in this directory working unchanged.
 */
export * from "@bitovp/core/wizard";
