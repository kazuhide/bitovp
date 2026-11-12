import { describe, expect, it } from "vitest";
import { clipA, clipB, facts, splitId, timeline } from "./test-fixtures";
import {
	appendSource,
	changeRange,
	createHistory,
	moveClip,
	splitAt,
	timelineAt,
	timelineDuration,
	timelineHistory,
} from "./timeline-state";

describe("input timeline editing", () => {
	it("keeps source time distinct from output time across cuts and repeated sources", () => {
		const doc = appendSource(timeline(), facts[0], splitId);
		expect(timelineDuration(doc)).toBe(85_000);
		expect(timelineAt(doc, 9_999)?.sourceMs).toBe(19_999);
		expect(timelineAt(doc, 10_000)).toMatchObject({
			index: 1,
			sourceMs: 0,
		});
		expect(timelineAt(doc, 25_000)).toMatchObject({
			index: 2,
			sourceMs: 0,
		});
	});

	it("rejects invalid trims without changing the document and splits at an output cursor", () => {
		const doc = timeline();
		expect(() => changeRange(doc, clipA, 20_000, 19_000, facts)).toThrow();
		expect(() => changeRange(doc, clipA, 0, 60_001, facts)).toThrow();
		expect(doc.clips[0]).toMatchObject({ inMs: 10_000, outMs: 20_000 });
		const split = splitAt(doc, 4_000, splitId);
		expect(split.clips.map(({ inMs, outMs }) => [inMs, outMs])).toEqual([
			[10_000, 14_000],
			[14_000, 20_000],
			[0, 15_000],
		]);
		expect(splitAt(doc, 10_000, splitId)).toBe(doc);
	});

	it("bounds undo history, restores ordered ranges and drops redo after a new edit", () => {
		const doc = timeline();
		const moved = moveClip(doc, clipB, 0);
		let history = timelineHistory(createHistory(doc), {
			type: "commit",
			document: moved,
		});
		history = timelineHistory(history, { type: "undo" });
		expect(history.present).toEqual(doc);
		history = timelineHistory(history, { type: "redo" });
		expect(history.present.clips[0]?.id).toBe(clipB);
		history = timelineHistory(history, { type: "undo" });
		history = timelineHistory(history, {
			type: "commit",
			document: changeRange(doc, clipA, 11_000, 20_000, facts),
		});
		expect(history.future).toHaveLength(0);
		for (let step = 0; step < 40; step++) {
			history = timelineHistory(history, {
				type: "commit",
				document: { ...history.present, audioEnabled: step % 2 === 0 },
			});
		}
		expect(history.past.length).toBeLessThanOrEqual(30);
	});
});
