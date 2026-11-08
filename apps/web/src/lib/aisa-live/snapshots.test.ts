import { describe, expect, it } from "vitest";
import { applyAisaSnapshot } from "./snapshots";

const resultFixture = () => ({
	analysisId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
	encodingId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
	sequence: 1,
	producedAt: "2026-11-07T00:00:00Z",
	mediaTimeOriginUnixMs: 1794009600000,
	isFinal: false,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 20,
	metadata: { version: "synthetic", disclaimer: "Synthetic data" },
	observations: [
		{
			id: "observation-a",
			text: "A tennis player wins the point.",
			startTimeSeconds: 0,
			endTimeSeconds: 10,
		},
	],
	keyMoments: [
		{
			id: "moment-a",
			lastUpdatedSequence: 1,
			importanceLevel: 1,
			startInSeconds: 1,
			endInSeconds: 9,
			anchorInSeconds: 5,
			observations: ["observation-a"],
			categories: ["sport/tennis", "future/unrecognized"],
		},
	],
});

describe("AISA Live cumulative snapshots", () => {
	it("accepts a JSONB round trip of fractional media seconds without changing provider values", () => {
		const fixture = resultFixture();
		const provider = {
			...fixture,
			analyzedEndTimeSeconds: 136.66666666666666,
			observations: [
				{
					...fixture.observations[0],
					startTimeSeconds: 113.76666666666667,
					endTimeSeconds: 136.66666666666666,
				},
			],
			keyMoments: [
				{
					...fixture.keyMoments[0],
					startInSeconds: 113.76666666666667,
					endInSeconds: 136.66666666666666,
					anchorInSeconds: 124.73333333333333,
				},
			],
			sourceGaps: [
				{
					startTimeSeconds: 100.03333333333333,
					endTimeSeconds: 101.06666666666666,
					reason: "GAP",
				},
			],
		};
		const persisted = {
			...provider,
			analyzedEndTimeSeconds: 136.6666666666667,
			observations: [
				{
					...provider.observations[0],
					startTimeSeconds: 113.7666666666667,
					endTimeSeconds: 136.6666666666667,
				},
			],
			keyMoments: [
				{
					...provider.keyMoments[0],
					startInSeconds: 113.7666666666667,
					endInSeconds: 136.6666666666667,
					anchorInSeconds: 124.7333333333333,
				},
			],
			sourceGaps: [
				{
					startTimeSeconds: 100.0333333333333,
					endTimeSeconds: 101.0666666666667,
					reason: "GAP",
				},
			],
		};
		const state = applyAisaSnapshot(null, persisted);
		expect(applyAisaSnapshot(state, provider)).toBe(state);
		const updated = applyAisaSnapshot(state, { ...provider, sequence: 2 });
		expect(updated.snapshot.keyMoments[0]?.endInSeconds).toBe(
			136.66666666666666,
		);
		expect(() =>
			applyAisaSnapshot(state, {
				...provider,
				keyMoments: [{ ...provider.keyMoments[0], anchorInSeconds: 124.735 }],
			}),
		).toThrow(/immutable/);
	});
	it.each([
		3, 5,
	])("rejects a newly seen ID with revision %s already absent from a complete snapshot", (revision) => {
		const fixture = resultFixture();
		const moment = fixture.keyMoments[0];
		if (!moment) throw new Error("Missing synthetic moment");
		const previous = applyAisaSnapshot(null, {
			...fixture,
			sequence: 5,
			keyMoments: [],
		});
		expect(() =>
			applyAisaSnapshot(previous, {
				...fixture,
				sequence: 7,
				isFinal: true,
				keyMoments: [
					{ ...moment, id: "previously-unseen", lastUpdatedSequence: revision },
				],
			}),
		).toThrow(/revision/);
		expect(previous.snapshot.sequence).toBe(5);
		expect(previous.snapshot.keyMoments).toEqual([]);
	});

	it("accepts a new ID from an unobserved newer sequence and historical revisions on first load", () => {
		const fixture = resultFixture();
		const moment = fixture.keyMoments[0];
		if (!moment) throw new Error("Missing synthetic moment");
		const historical = applyAisaSnapshot(null, {
			...fixture,
			sequence: 5,
			keyMoments: [{ ...moment, lastUpdatedSequence: 3 }],
		});
		expect(historical.snapshot.keyMoments).toHaveLength(1);
		const previous = applyAisaSnapshot(null, {
			...fixture,
			sequence: 5,
			keyMoments: [],
		});
		const next = applyAisaSnapshot(previous, {
			...fixture,
			sequence: 7,
			isFinal: true,
			keyMoments: [{ ...moment, id: "newer-moment", lastUpdatedSequence: 6 }],
		});
		expect(
			next.snapshot.keyMoments.find((item) => item.id === "newer-moment")
				?.lastUpdatedSequence,
		).toBe(6);
	});

	it("withdraws omitted collections rather than keeping stale moments", () => {
		const previous = applyAisaSnapshot(null, resultFixture());
		const {
			observations: _observations,
			keyMoments: _moments,
			...empty
		} = resultFixture();
		const next = applyAisaSnapshot(previous, { ...empty, sequence: 2 });
		expect(next.snapshot.keyMoments).toEqual([]);
		expect(next.snapshot.observations).toEqual([]);
		expect(previous.snapshot.keyMoments).toHaveLength(1);
	});

	it("retains the previous state for older snapshots and equivalent repeats", () => {
		const fixture = resultFixture();
		const state = applyAisaSnapshot(null, { ...fixture, sequence: 3 });
		expect(applyAisaSnapshot(state, fixture)).toBe(state);
		expect(
			applyAisaSnapshot(state, {
				...fixture,
				sequence: 3,
				keyMoments: [
					{
						...fixture.keyMoments[0],
						categories: ["future/unrecognized", "sport/tennis"],
					},
				],
			}),
		).toBe(state);
	});

	it("rejects content mutation under the same result sequence", () => {
		const fixture = resultFixture();
		const state = applyAisaSnapshot(null, fixture);
		expect(() =>
			applyAisaSnapshot(state, {
				...fixture,
				metadata: { ...fixture.metadata, version: "changed" },
			}),
		).toThrow();
	});

	it("rejects a changed identity, clock, coverage, or results after finality", () => {
		const fixture = resultFixture();
		const state = applyAisaSnapshot(null, fixture);
		for (const changed of [
			{ encodingId: "dddddddd-dddd-4ddd-addd-dddddddddddd" },
			{ mediaTimeOriginUnixMs: fixture.mediaTimeOriginUnixMs + 1 },
			{ analyzedStartTimeSeconds: 1 },
			{ analyzedEndTimeSeconds: 19 },
		]) {
			expect(() =>
				applyAisaSnapshot(state, { ...fixture, sequence: 2, ...changed }),
			).toThrow();
		}
		const final = applyAisaSnapshot(state, {
			...fixture,
			sequence: 2,
			isFinal: true,
		});
		expect(() =>
			applyAisaSnapshot(final, { ...fixture, sequence: 3 }),
		).toThrow();
	});

	it("never accepts observation mutation or a withdrawn observation ID again", () => {
		const fixture = resultFixture();
		const state = applyAisaSnapshot(null, fixture);
		expect(() =>
			applyAisaSnapshot(state, {
				...fixture,
				sequence: 2,
				observations: [
					{ ...fixture.observations[0], text: "A different event" },
				],
			}),
		).toThrow();
		const withdrawn = applyAisaSnapshot(state, {
			...fixture,
			sequence: 2,
			observations: [],
			keyMoments: [],
		});
		expect(() =>
			applyAisaSnapshot(withdrawn, { ...fixture, sequence: 3 }),
		).toThrow();
	});

	it("requires a revision for refinements, preserves it for reordered sets, and refuses withdrawn IDs", () => {
		const fixture = resultFixture();
		const state = applyAisaSnapshot(null, fixture);
		expect(() =>
			applyAisaSnapshot(state, {
				...fixture,
				sequence: 2,
				keyMoments: [{ ...fixture.keyMoments[0], importanceLevel: 2 }],
			}),
		).toThrow();
		const refined = applyAisaSnapshot(state, {
			...fixture,
			sequence: 2,
			keyMoments: [
				{
					...fixture.keyMoments[0],
					importanceLevel: 2,
					lastUpdatedSequence: 2,
				},
			],
		});
		const moment = refined.snapshot.keyMoments.find(
			(item) => item.id === "moment-a",
		);
		expect(moment?.importanceLevel).toBe(2);
		const withdrawn = applyAisaSnapshot(refined, {
			...fixture,
			sequence: 3,
			keyMoments: [],
		});
		expect(() =>
			applyAisaSnapshot(withdrawn, {
				...fixture,
				sequence: 4,
				keyMoments: [{ ...fixture.keyMoments[0], lastUpdatedSequence: 4 }],
			}),
		).toThrow();
	});

	it("rejects a refinement attributed to a sequence already observed with older content", () => {
		const fixture = resultFixture();
		const state = applyAisaSnapshot(null, { ...fixture, sequence: 5 });
		expect(() =>
			applyAisaSnapshot(state, {
				...fixture,
				sequence: 7,
				keyMoments: [
					{
						...fixture.keyMoments[0],
						importanceLevel: 2,
						lastUpdatedSequence: 3,
					},
				],
			}),
		).toThrow();
	});
});
