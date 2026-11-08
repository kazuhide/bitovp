import { normalizeSceneAnalysis } from "@bitovp/core";
import { expect, it } from "vitest";
import { trackingShotFromAnalysis } from "./tracking";

function fixtureItem<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture");
	return value;
}

function fixture() {
	const shot = fixtureItem(
		fixtureItem(
			normalizeSceneAnalysis({
				metadata: { version: "1" },
				duration: 120,
				scenes: [
					{
						id: "11111111-1111-4111-8111-111111111111",
						startInSeconds: 100,
						endInSeconds: 110,
						shots: [
							{
								startInSeconds: 100,
								endInSeconds: 110,
								mainSubjects: [
									{
										classification: "person",
										description: "Engineer",
										appearanceTimeInSeconds: 1,
										centerX: 25,
										centerY: 50,
										box2d: [300, 180, 700, 300],
									},
									{
										classification: "robot",
										description: "Robot",
										appearanceTimeInSeconds: 1,
										centerX: 37,
										centerY: 50,
										box2d: [300, 310, 700, 430],
									},
								],
							},
						],
					},
				],
			}).scenes[0],
		).shots[0],
	);
	return {
		sceneId: "scene",
		shotIndex: 0,
		shot,
		sourceStartUs: 100_000_000,
		target: { id: `target-${"a".repeat(64)}`, subjectIndexes: [1] },
	};
}
it("seeds the story-selected object instead of dropping or choosing the first subject", () => {
	expect(trackingShotFromAnalysis(fixture())).toMatchObject({
		targetId: `target-${"a".repeat(64)}`,
		seed: {
			sourceFrame: 30,
			sourceTimeUs: 1_000_000,
			box: { x: 0.31, y: 0.3, w: 0.12, h: 0.4 },
		},
	});
});
it("seeds the union of simultaneous protected subjects and rejects invalid target indexes", () => {
	const f = fixture();
	f.target.subjectIndexes = [0, 1];
	expect(trackingShotFromAnalysis(f)?.seed?.box).toEqual({
		x: 0.18,
		y: 0.3,
		w: 0.25,
		h: 0.4,
	});
	f.target.subjectIndexes = [99];
	expect(() => trackingShotFromAnalysis(f)).toThrow(RangeError);
});
it("does not move an original observation into a later selected frame window", () => {
	const f = fixture();
	expect(
		trackingShotFromAnalysis({
			...f,
			frameWindow: { startFrame: 60, endFrame: 90 },
		})?.seed,
	).toBeUndefined();
});
