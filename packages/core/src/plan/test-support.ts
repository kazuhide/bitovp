import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "./schema";

/**
 * Fixture access for the plan test files — six of them carried byte-identical
 * copies of `loadPlan`, and three the same corpus glob. One copy, so a change
 * to how fixtures load (or where they live) is one edit, not a hunt.
 *
 * TEST-ONLY by import discipline, not by tooling: `packages/core` has no build
 * step (its exports map serves raw TS), so nothing ships unless an exported
 * entrypoint imports it — none does, and none may: this module reads the
 * filesystem, which the browser bundle cannot.
 */
export const FIXTURES_DIR = join(__dirname, "__fixtures__");

/** Parse a fixture through the real schema — the same gate runtime plans pass. */
export function loadPlan(name: string) {
	return encodingPlanSchema.parse(
		JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.plan.json`), "utf8")),
	);
}

/** Every VOD fixture name, sorted — the corpus the sweep tests iterate. */
export function vodPlanNames(): string[] {
	return readdirSync(FIXTURES_DIR)
		.filter((f) => f.endsWith(".plan.json"))
		.map((f) => f.replace(/\.plan\.json$/, ""))
		.sort();
}
