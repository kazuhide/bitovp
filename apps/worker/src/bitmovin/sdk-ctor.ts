import BitmovinApiImport from "@bitmovin/api-sdk";

/**
 * The ONE place the worker resolves the Bitmovin SDK constructor (rev432).
 *
 * ESM↔CJS interop differs per pipeline: bundlers (Next, vitest) hand the
 * default import to us as the class, but tsx/Node native interop — the
 * worker's runtime — hands the CJS module namespace ({ default: class,
 * ...named }), and `new` then fails with "BitmovinApi is not a constructor".
 * Every unit test passed while the deployed webhook registrar and the usage
 * sweep failed on every attempt (dev stack, 2026-09-06), because vitest never
 * takes the tsx path. Resolve the shape here; `scripts/sdk-interop-smoke.ts`
 * constructs through every worker factory under tsx, and
 * `sdk-ctor.test.ts` refuses every constructing import form elsewhere
 * (scripts/ included).
 */
type BitmovinApiCtor = typeof BitmovinApiImport;
export type BitmovinApi = InstanceType<BitmovinApiCtor>;
export const BitmovinApi: BitmovinApiCtor = (() => {
	const resolved =
		typeof BitmovinApiImport === "function"
			? BitmovinApiImport
			: (BitmovinApiImport as unknown as { default: BitmovinApiCtor }).default;
	if (typeof resolved !== "function") {
		// A future SDK export shape matching neither branch must fail loudly,
		// not with a downstream "not a constructor".
		throw new Error(
			"@bitmovin/api-sdk default export did not resolve to a constructor — SDK packaging changed?",
		);
	}
	return resolved;
})();
