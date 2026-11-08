import { describe, expect, it } from "vitest";
import {
	buildPreparedShotPartition,
	getPreparedShotPartitionEntry,
	preparedFrameForSourceAppearance,
	verifyPreparedNormalizationReceipt,
} from "./prepared-shot-partition";
import {
	fixtureItem,
	preparedClockFixture,
	preparedSceneId,
} from "./prepared-shot-partition.test-fixtures";
import { hashEditingEvidence } from "./verify-automatic-binding";

describe("verified immutable normalization clock", () => {
	it("accepts canonical receipt and preserves original data without mutation", () => {
		const f = preparedClockFixture(),
			before = JSON.stringify(f);
		expect(verifyPreparedNormalizationReceipt(f.verify)).toEqual(f.proof);
		expect(JSON.stringify(f)).toBe(before);
	});
	it.each([
		"organizationId",
		"sourceId",
		"mediaVersionId",
		"preparedSha256",
		"width",
		"height",
	] as const)("rejects mismatching %s", (key) => {
		const f = preparedClockFixture();
		const wrong = {
			...f.verify,
			[key]:
				typeof f.verify[key] === "number"
					? 2
					: "55555555-5555-4555-8555-555555555555",
		};
		expect(() => verifyPreparedNormalizationReceipt(wrong)).toThrow();
	});
	it("rejects changed proof hash, map identity/origin/bounds, index hash and recipe even when a forged proof hash is recalculated", () => {
		const mutations: Array<
			(f: ReturnType<typeof preparedClockFixture>) => void
		> = [
			(f) => {
				f.verify.proofHash = "0".repeat(64);
			},
			(f) => {
				f.timeMap.id = f.proof.sourceId;
			},
			(f) => {
				f.timeMap.sourceStartUs = 1;
			},
			(f) => {
				f.timeMap.editingEndFrame = 59;
			},
			(f) => {
				f.proof.indexMapHash = "0".repeat(64);
				f.verify.proofHash = hashEditingEvidence(f.proof);
			},
			(f) => {
				f.proof.recipeHash = "0".repeat(64);
				f.verify.proofHash = hashEditingEvidence(f.proof);
			},
			(f) => {
				f.proof.sourceFrameIndex[1] = 1;
				f.proof.indexMapHash = hashEditingEvidence(f.proof.sourceFrameIndex);
				f.verify.proofHash = hashEditingEvidence(f.proof);
			},
		];
		for (const mutate of mutations) {
			const f = preparedClockFixture();
			mutate(f);
			expect(() => verifyPreparedNormalizationReceipt(f.verify)).toThrow();
		}
	});
});
describe("one prepared partition from original shared boundaries", () => {
	it("maps j mod4 shared cuts once, eliminating artificial gaps without dropping frames", () => {
		const f = preparedClockFixture(),
			before = JSON.stringify(f);
		const p = buildPreparedShotPartition({
			analysis: f.analysis,
			timeMap: f.timeMap,
			normalization: f.proof,
		});
		expect(p.version).toBe("aisa-prepared-clock-v3");
		expect(p.normalizationReceiptHash).toBe(hashEditingEvidence(f.proof));
		expect(p.entries.map((e) => [e.fromFrame, e.toFrame])).toEqual([
			[0, 2],
			[2, 3],
			[3, 4],
			[4, 5],
			[5, 60],
		]);
		expect(p.entries.reduce((n, e) => n + e.toFrame - e.fromFrame, 0)).toBe(60);
		expect(JSON.stringify(f)).toBe(before);
	});
	it("marks the early rounded raw-start prefix FIT with no certainty or silent seed clamping", () => {
		const f = preparedClockFixture(),
			p = buildPreparedShotPartition({
				analysis: f.analysis,
				timeMap: f.timeMap,
				normalization: f.proof,
			});
		const e = getPreparedShotPartitionEntry(p, {
			sceneId: preparedSceneId,
			shotIndex: 4,
		});
		expect(e).toMatchObject({
			fromFrame: 5,
			toFrame: 60,
			legacyFromFrame: 6,
			certainFromFrame: 6,
			certainToFrame: 60,
			fitBands: [
				{ fromFrame: 5, toFrame: 6, reason: "RAW_TIMESTAMP_ROUNDTRIP_GUARD" },
			],
		});
		expect(e?.shotHash).toBe(
			hashEditingEvidence(f.analysis.scenes[0]?.shots[4]),
		);
	});
	it("uses source frame PTS for genuine between-frame appearance, retains EOF sentinel and rejects forged clocks", () => {
		const f = preparedClockFixture(),
			p = buildPreparedShotPartition({
				analysis: f.analysis,
				timeMap: f.timeMap,
				normalization: f.proof,
			});
		expect(preparedFrameForSourceAppearance(p, 0.1)).toBe(4);
		expect(preparedFrameForSourceAppearance(p, 5 / 24)).toBe(7);
		expect(preparedFrameForSourceAppearance(p, 0.166667)).toBe(5);
		expect(preparedFrameForSourceAppearance(p, 2)).toBe(60);
		expect(preparedFrameForSourceAppearance(p, 3)).toBe(60);
		expect(() => preparedFrameForSourceAppearance(p, NaN)).toThrow();
		expect(() => preparedFrameForSourceAppearance({ ...p }, 0.1)).toThrow();
	});
});

describe("conservative unresolved shared boundaries", () => {
	it("leaves a genuine between-frame cut unmoved and FITs earlier captured pixels", () => {
		const f = preparedClockFixture(),
			shots = fixtureItem(f.analysis.scenes[0]).shots;
		fixtureItem(shots[0]).endInSeconds = 0.1;
		fixtureItem(shots[4]).startInSeconds = 0.1;
		fixtureItem(f.analysis.scenes[0]).shots = [
			fixtureItem(shots[0]),
			fixtureItem(shots[4]),
		];
		const p = buildPreparedShotPartition({
			analysis: f.analysis,
			timeMap: f.timeMap,
			normalization: f.proof,
		});
		expect(p.unresolvedSharedBoundaryCount).toBe(1);
		expect(p.entries.map((e) => [e.fromFrame, e.toFrame])).toEqual([
			[0, 3],
			[3, 60],
		]);
		expect(p.entries[1]).toMatchObject({
			certainFromFrame: 4,
			fitBands: [
				{ fromFrame: 3, toFrame: 4, reason: "RAW_TIMESTAMP_ROUNDTRIP_GUARD" },
			],
		});
	});
});
