import { describe, expect, it } from "vitest";
import {
	createPortraitSelectionSearchBudget,
	selectAutoPortraitClips,
} from "./auto-portrait";
import {
	buildPreparedShotPartition,
	selectPreparedPortraitClips,
} from "./prepared-shot-partition";
import {
	fixtureItem,
	preparedClockFixture,
	preparedSceneId,
} from "./prepared-shot-partition.test-fixtures";
import { selectSemanticPortraitClips } from "./semantic-portrait";

describe("versioned prepared whole-shot selection", () => {
	it("joins certified shared cuts without changing old v1/v2 JSON behavior", () => {
		const f = preparedClockFixture(),
			before = JSON.stringify(f);
		const legacy = selectAutoPortraitClips({
				analysis: f.analysis,
				timeMap: f.timeMap,
				targetDurationFrames: 60,
			}),
			semantic = selectSemanticPortraitClips({
				analysis: f.analysis,
				timeMap: f.timeMap,
				targetDurationFrames: 60,
			});
		expect(legacy.actualDurationFrames).toBe(54);
		expect(semantic.actualDurationFrames).toBe(54);
		const partition = buildPreparedShotPartition({
			analysis: f.analysis,
			timeMap: f.timeMap,
			normalization: f.proof,
		});
		const v3 = selectPreparedPortraitClips({
			partition,
			targetDurationFrames: 60,
			policy: "DURATION",
		});
		expect(v3.policyVersion).toBe("aisa-prepared-shot-window-v3");
		expect(v3.actualDurationFrames).toBe(60);
		expect(v3.clips.map((c) => c.durationFrames)).toEqual([2, 1, 1, 1, 55]);
		expect(
			JSON.stringify(
				selectAutoPortraitClips({
					analysis: f.analysis,
					timeMap: f.timeMap,
					targetDurationFrames: 60,
				}),
			),
		).toBe(JSON.stringify(legacy));
		expect(
			JSON.stringify(
				selectSemanticPortraitClips({
					analysis: f.analysis,
					timeMap: f.timeMap,
					targetDurationFrames: 60,
				}),
			),
		).toBe(JSON.stringify(semantic));
		expect(JSON.stringify(f)).toBe(before);
	});
	it("builds partition before query and does not bridge filtered-out shots or remap evidence indices", () => {
		const f = preparedClockFixture();
		for (const [i, shot] of fixtureItem(f.analysis.scenes[0]).shots.entries())
			shot.detailedDescription = i % 2 === 0 ? "keep" : "drop";
		const p = buildPreparedShotPartition({
			analysis: f.analysis,
			timeMap: f.timeMap,
			normalization: f.proof,
		});
		const s = selectPreparedPortraitClips({
			partition: p,
			targetDurationFrames: 60,
			policy: "COHESION",
			query: "keep",
		});
		expect(s.policyVersion).toBe("aisa-prepared-scene-cohesion-v3");
		expect(s.actualDurationFrames).toBe(55);
		expect(s.clips).toEqual([
			{
				sourceInUs: 166667,
				durationFrames: 55,
				sceneId: preparedSceneId,
				shotIndex: 4,
			},
		]);
	});
	it("keeps true raw gaps separate even when both rounded values refer near the same source grid boundary", () => {
		const f = preparedClockFixture();
		const first = fixtureItem(fixtureItem(f.analysis.scenes[0]).shots[0]),
			last = fixtureItem(fixtureItem(f.analysis.scenes[0]).shots[4]);
		first.endInSeconds = 0.041667;
		last.startInSeconds = 0.041668;
		fixtureItem(f.analysis.scenes[0]).shots = [first, last];
		const p = buildPreparedShotPartition({
			analysis: f.analysis,
			timeMap: f.timeMap,
			normalization: f.proof,
		});
		expect(p.entries.map((e) => [e.fromFrame, e.toFrame])).toEqual([
			[0, 1],
			[2, 60],
		]);
		const s = selectPreparedPortraitClips({
			partition: p,
			targetDurationFrames: 60,
			policy: "DURATION",
		});
		expect(s.actualDurationFrames).toBe(58);
		expect(s.clips).toHaveLength(1);
	});
	it("does not remove known unsafe external ends, shares factory search budget and respects the 5400 frame cap", () => {
		const f = preparedClockFixture(),
			p = buildPreparedShotPartition({
				analysis: f.analysis,
				timeMap: f.timeMap,
				normalization: f.proof,
			}),
			budget = createPortraitSelectionSearchBudget();
		const s = selectPreparedPortraitClips({
			partition: p,
			targetDurationFrames: 60,
			policy: "DURATION",
			searchBudget: budget,
			acceptWindow: (w) => w.toFrame <= 5,
		});
		expect(s.actualDurationFrames).toBe(5);
		const used = budget.usedExpansions;
		selectPreparedPortraitClips({
			partition: p,
			targetDurationFrames: 60,
			policy: "COHESION",
			searchBudget: budget,
		});
		expect(budget.usedExpansions).toBeGreaterThan(used);
		expect(() =>
			selectPreparedPortraitClips({
				partition: p,
				targetDurationFrames: 5401,
				policy: "DURATION",
			}),
		).toThrow();
		expect(() =>
			selectPreparedPortraitClips({
				partition: p,
				targetDurationFrames: 60,
				policy: "DURATION",
				query: "not permitted",
			}),
		).toThrow();
	});
});

describe("prepared selection bounded whole-shot search", () => {
	it("retains at most 20 original whole shots without truncating a selected shot", () => {
		const f = preparedClockFixture(),
			shot = fixtureItem(fixtureItem(f.analysis.scenes[0]).shots[0]);
		fixtureItem(f.analysis.scenes[0]).shots = Array.from(
			{ length: 48 },
			(_, i) => ({
				...shot,
				startInSeconds: i / 24,
				endInSeconds: (i + 1) / 24,
			}),
		);
		const p = buildPreparedShotPartition({
			analysis: f.analysis,
			timeMap: f.timeMap,
			normalization: f.proof,
		});
		for (const policy of ["DURATION", "COHESION"] as const) {
			const s = selectPreparedPortraitClips({
				partition: p,
				targetDurationFrames: 60,
				policy,
			});
			expect(s.clips).toHaveLength(20);
			expect(s.actualDurationFrames).toBe(25);
			for (const clip of s.clips) {
				const e = fixtureItem(
					p.entries.find(
						(e) => e.sceneId === clip.sceneId && e.shotIndex === clip.shotIndex,
					),
				);
				expect(clip.durationFrames).toBe(e.toFrame - e.fromFrame);
			}
		}
	});
	it("rejects more than 10000 raw candidates before a partial optimum can be returned", () => {
		const f = preparedClockFixture(),
			shot = fixtureItem(fixtureItem(f.analysis.scenes[0]).shots[0]);
		fixtureItem(f.analysis.scenes[0]).shots = Array.from(
			{ length: 10001 },
			() => ({
				...shot,
			}),
		);
		expect(() =>
			buildPreparedShotPartition({
				analysis: f.analysis,
				timeMap: f.timeMap,
				normalization: f.proof,
			}),
		).toThrow("PREPARED_CANDIDATE_LIMIT");
	});
});
