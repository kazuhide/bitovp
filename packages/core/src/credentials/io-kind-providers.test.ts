import { describe, expect, it } from "vitest";
import { planInputSchema, planOutputSchema } from "../plan/schema";
import { PROVIDERS_FOR_IO_KIND, providersForIoKind } from "./io-kind-providers";
import { CREDENTIAL_PROVIDERS } from "./schemas";

/**
 * Audit AA972-IMPORT-001. The import wizard classified every IO kind except
 * AZURE and SFTP as `AWS_S3`, so an operator importing a GenericS3, GCS,
 * NetStorage or MSL plan was sent to an AWS credential picker.
 *
 * The table is only as good as its coverage, so the population comes from the
 * plan schema itself — a kind added to `planInputSchema`/`planOutputSchema`
 * without a row here is a failing test, not a silent fall-through to AWS.
 */
describe("PROVIDERS_FOR_IO_KIND", () => {
	const schemaKinds = [
		...planInputSchema.options.map((o) => o.shape.kind.value),
		...planOutputSchema.options.map((o) => o.shape.kind.value),
	];

	it("classifies every kind the plan schema can express", () => {
		const missing = [...new Set(schemaKinds)]
			.filter((k) => PROVIDERS_FOR_IO_KIND[k] === undefined)
			.sort();
		expect(missing).toEqual([]);
	});

	it("names no kind the schema cannot express", () => {
		// The other direction: a row for a kind that no longer exists is dead
		// weight that reads as coverage. Set-equality, both ways.
		const extra = Object.keys(PROVIDERS_FOR_IO_KIND)
			.filter((k) => !schemaKinds.includes(k as (typeof schemaKinds)[number]))
			.sort();
		expect(extra).toEqual([]);
	});

	it("names only real credential providers", () => {
		const known = new Set<string>(CREDENTIAL_PROVIDERS);
		const bogus = Object.entries(PROVIDERS_FOR_IO_KIND).flatMap(
			([kind, providers]) =>
				providers.filter((p) => !known.has(p)).map((p) => `${kind} → ${p}`),
		);
		expect(bogus).toEqual([]);
	});

	it("does not fall back to AWS_S3 for an unknown kind", () => {
		// The defect in one line: the old helper's else-branch. `undefined` is
		// the honest answer and lets a caller say "I don't know".
		expect(providersForIoKind("NOT_A_KIND")).toBeUndefined();
		expect(providersForIoKind(undefined)).toBeUndefined();
		expect(providersForIoKind(42)).toBeUndefined();
	});

	it("keeps HTTPS classified as credential-free rather than absent", () => {
		expect(providersForIoKind("HTTPS")).toEqual([]);
	});
});
