import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VMAF_MODEL } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { VMAF_MODELS } from "./wizard-sections";

/**
 * The wizard's model dropdown, checked against the models the worker image
 * actually bundles.
 *
 * A dropdown entry is a promise: pick it, and an encode runs for minutes before
 * the QC step tries `model=path=$VMAF_MODEL_DIR/<name>.json` and fails at the very
 * end. Nothing connected the two sides — the list is hand-written in a `.tsx` and
 * the models arrive through a `RUN curl` loop in the Dockerfile — so a typo, or a
 * model dropped from the image, would ship as a live option that cannot work.
 *
 * `docker/vmaf-models.sha256` is the repo-side manifest of what the image
 * downloads (the Dockerfile `COPY`s it in and an operator can `sha256sum -c`
 * against it), so it is the one file both sides can be checked against.
 *
 * This is a real check and not a restatement: pointing an entry at a plausible
 * name that does not exist (`vmaf_v1.0.16_2d0h`) fails it, and so does dropping a
 * model from the manifest.
 *
 * What it deliberately does NOT assert: that every bundled model appears in the
 * dropdown. The list is curated — the `float_` variants are excluded because they
 * cost about 4.4x the scoring time for a ~0.02 difference in score (measured, see
 * ), and the remaining v1 variants
 * are reachable through the expert raw-JSON path. Curation is a choice; a broken
 * entry is a bug.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");

function bundledModelNames(): string[] {
	const manifest = readFileSync(
		join(REPO_ROOT, "docker", "vmaf-models.sha256"),
		"utf8",
	);
	return manifest
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([hash, name]) => /^[0-9a-f]{64}$/.test(hash ?? "") && !!name)
		.map(([, name]) => (name as string).replace(/\.json$/, ""));
}

describe("the wizard's VMAF model list", () => {
	it("finds the manifest and reads a plausible number of models from it", () => {
		// Guards the reader itself: a manifest whose format drifted would yield an
		// empty list, and every assertion below would then pass vacuously.
		const bundled = bundledModelNames();
		expect(bundled.length).toBeGreaterThanOrEqual(14);
		expect(bundled).toContain("vmaf_v0.6.1");
		expect(bundled.every((name) => /^[A-Za-z0-9._-]+$/.test(name))).toBe(true);
	});

	it("offers only models the worker image bundles", () => {
		const bundled = new Set(bundledModelNames());
		const missing = VMAF_MODELS.filter((model) => !bundled.has(model));
		expect(missing).toEqual([]);
	});

	it("offers every model as a name the plan schema accepts", async () => {
		// The same charset the worker interpolates into the libvmaf filter and joins
		// onto VMAF_MODEL_DIR. A dropdown entry that the schema rejects would fail at
		// submit with a validation error naming a field the operator did not type.
		const { vmafModelNameSchema } = await import("@bitovp/core");
		for (const model of VMAF_MODELS) {
			expect(vmafModelNameSchema.safeParse(model).success).toBe(true);
		}
	});

	it("keeps the file-free BUILT-INS first — availability, not defaultness (ledger #104)", () => {
		// This test's rationale was inverted by the v1 default: it used to say
		// "vmaf_v0.6.1 is the schema default, so a different first entry would
		// make the dropdown's top item and the plan's default disagree" — and
		// that disagreement is now the SHIPPED state (review-234 I1). The
		// order is still right, for a different reason: the built-ins load on
		// any worker, including a host `pnpm dev` with no VMAF_MODEL_DIR, so
		// they are the safe things to see first. The consequence to keep in
		// mind is real: accepting the top entry now writes an explicit
		// `model` into the plan, because it DEVIATES from the default.
		expect(VMAF_MODELS[0]).toBe("vmaf_v0.6.1");
		expect(VMAF_MODELS.includes(DEFAULT_VMAF_MODEL)).toBe(true);
		expect(DEFAULT_VMAF_MODEL).not.toBe(VMAF_MODELS[0]);
	});
});
