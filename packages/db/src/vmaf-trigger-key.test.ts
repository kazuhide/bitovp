import { describe, expect, it } from "vitest";
import {
	autoTriggerKey,
	labManualTriggerKey,
	labManualTriggerPrefix,
	vmafTriggerKind,
} from "./vmaf-trigger-key";

/**
 * These builders replaced four inline template literals, so the ONE thing that
 * must not drift is the wire format: rows already in the database carry the old
 * strings, and `reconcile-stranded` compares against them by equality. Every
 * expectation below is therefore a literal, deliberately — asserting
 * `autoTriggerKey(x) === \`vod-auto:${x}\`` would re-derive the value from the
 * same expression under test and pass through any change to it.
 */
describe("VmafJob.triggerKey", () => {
	const JOB = "00000000-0000-4000-8000-0000000000aa";

	it("spells the AUTO key exactly as the pre-extraction call sites did", () => {
		expect(autoTriggerKey(JOB)).toBe(
			"vod-auto:00000000-0000-4000-8000-0000000000aa",
		);
	});

	it("spells the lab-manual key and prefix exactly as before", () => {
		expect(labManualTriggerPrefix(JOB)).toBe(
			"lab-manual:00000000-0000-4000-8000-0000000000aa:",
		);
		expect(labManualTriggerKey(JOB, "vmaf_v0.6.1", 2)).toBe(
			"lab-manual:00000000-0000-4000-8000-0000000000aa:vmaf_v0.6.1:2",
		);
	});

	it("the prefix is a prefix OF the key — the startsWith scan must match", () => {
		// The count query and the create are separate call sites; if one gained
		// a separator the other did not, the ordinal would restart at 1 forever
		// and the unique constraint would reject every re-measure.
		expect(labManualTriggerKey(JOB, "vmaf_v0.6.1", 7)).toMatch(
			new RegExp(`^${labManualTriggerPrefix(JOB)}`),
		);
	});

	it("classifies provenance relative to the job asked about", () => {
		expect(vmafTriggerKind(autoTriggerKey(JOB), JOB)).toBe("VOD_AUTO");
		expect(vmafTriggerKind(labManualTriggerKey(JOB, "m", 1), JOB)).toBe(
			"LAB_MANUAL",
		);
	});

	it("ANOTHER job's key is OTHER, never that job's own kind", () => {
		// The report joins rows by encodingJobId, so a mismatch here should be
		// impossible — but the classifier takes both halves as arguments, and a
		// reader that reported a foreign key as VOD_AUTO would be naming this
		// job's gate evidence from another job's row.
		const OTHER_JOB = "00000000-0000-4000-8000-0000000000bb";
		expect(vmafTriggerKind(autoTriggerKey(OTHER_JOB), JOB)).toBe("OTHER");
		expect(vmafTriggerKind(labManualTriggerKey(OTHER_JOB, "m", 1), JOB)).toBe(
			"OTHER",
		);
	});

	it("absent or empty provenance is OTHER, not LAB_MANUAL", () => {
		// Pre-#122 rows carry null. Calling those lab runs would assert an
		// operator action that never happened.
		expect(vmafTriggerKind(null, JOB)).toBe("OTHER");
		expect(vmafTriggerKind("", JOB)).toBe("OTHER");
		expect(vmafTriggerKind("vod-auto:", JOB)).toBe("OTHER");
	});

	/**
	 * DIFFERENTIAL against the pre-extraction expressions.
	 *
	 * The literal pins above answer "does it still produce the string I
	 * expected"; they cannot answer "does it produce the same string as the
	 * code it replaced, for every input". Four call sites were rewritten, and
	 * two of them are unforgiving: `reconcile-stranded.ts` compares by EQUALITY
	 * against rows already in the database, and `vmaf-jobs/route.ts` uses the
	 * prefix for a `startsWith` count whose result becomes an ordinal in a
	 * UNIQUE key — if the count's prefix and the create's key ever disagreed,
	 * the ordinal would restart at 1 forever and every re-measure would be
	 * rejected by the constraint.
	 *
	 * So the arms below are TRANSCRIBED from the four call sites as they stood
	 * before this change, and both implementations run over a
	 * cross product. A previous PR proved an extraction this way and left the
	 * evidence only in a terminal, which a reviewer rightly called the strongest
	 * instrument in the change being the one nobody else could audit. It lives
	 * here now.
	 */
	describe("differential vs the pre-extraction inline literals", () => {
		// Verbatim from the old call sites — do NOT refactor these to call the
		// functions under test; that is the whole point.
		const oldAuto = (encodingJobId: string) => `vod-auto:${encodingJobId}`;
		const oldLabPrefix = (encodingJobId: string) =>
			`lab-manual:${encodingJobId}:`;
		const oldLabKey = (encodingJobId: string, model: string, n: number) =>
			`lab-manual:${encodingJobId}:${model}:${n}`;

		// Inputs chosen to break naive string handling, not just to pass:
		// a colon inside the model (so the key has more separators than fields),
		// unicode, an id that is itself a prefix of another, and empty strings.
		const IDS = [
			"00000000-0000-4000-8000-0000000000aa",
			"job-1",
			"job-10",
			"",
			"a:b",
			"ジョブ",
			"x".repeat(300),
		];
		const MODELS = [
			"vmaf_v0.6.1",
			"vmaf_4k_v0.6.1",
			"vmaf:weird",
			"",
			"モデル",
		];
		const ORDINALS = [1, 2, 9, 10, 999];

		it("agrees on the AUTO key for every id", () => {
			const disagreements = IDS.filter(
				(id) => autoTriggerKey(id) !== oldAuto(id),
			);
			expect(disagreements).toEqual([]);
		});

		it("agrees on the lab-manual prefix for every id", () => {
			const disagreements = IDS.filter(
				(id) => labManualTriggerPrefix(id) !== oldLabPrefix(id),
			);
			expect(disagreements).toEqual([]);
		});

		it("agrees on the lab-manual key across id × model × ordinal", () => {
			const disagreements: string[] = [];
			let compared = 0;
			for (const id of IDS) {
				for (const model of MODELS) {
					for (const n of ORDINALS) {
						compared += 1;
						if (labManualTriggerKey(id, model, n) !== oldLabKey(id, model, n)) {
							disagreements.push(`${id}|${model}|${n}`);
						}
					}
				}
			}
			// The count is asserted so a broken loop cannot report "no
			// disagreements" over zero comparisons — an empty population is the
			// failure mode a differential test is most likely to hide.
			expect(compared).toBe(IDS.length * MODELS.length * ORDINALS.length);
			expect(disagreements).toEqual([]);
		});

		it("agrees on reconcile-stranded's equality test, both arms", () => {
			// The old line was `if (triggerKey !== \`vod-auto:${encodingJobId}\`)`.
			// Both the MATCH and the NON-MATCH arm have to move together: a
			// builder that returned a string nothing equals would make every row
			// look non-AUTO and the sweep would wake nothing.
			const matched: boolean[] = [];
			for (const id of IDS) {
				for (const stored of [
					oldAuto(id),
					oldLabPrefix(id),
					oldLabKey(id, "vmaf_v0.6.1", 1),
					null,
					"",
				]) {
					const oldSaysAuto = stored === oldAuto(id);
					const newSaysAuto = stored === autoTriggerKey(id);
					expect(newSaysAuto).toBe(oldSaysAuto);
					matched.push(oldSaysAuto);
				}
			}
			// One AUTO match per id, and the other four shapes are not it.
			expect(matched.filter(Boolean)).toHaveLength(IDS.length);
		});

		it("the classifier is not merely returning VOD_AUTO for everything", () => {
			// A differential test over agreeing builders says nothing about
			// `vmafTriggerKind`, which has no pre-extraction counterpart. This
			// arm is its negative control: the three kinds must be distinct over
			// the same population.
			const kinds = new Set(
				IDS.flatMap((id) => [
					vmafTriggerKind(autoTriggerKey(id), id),
					vmafTriggerKind(labManualTriggerKey(id, "m", 1), id),
					vmafTriggerKind("something-else", id),
				]),
			);
			expect([...kinds].sort()).toEqual(["LAB_MANUAL", "OTHER", "VOD_AUTO"]);
		});
	});
});
