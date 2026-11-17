import { describe, expect, it } from "vitest";
import { moqObservationUpdateSchema } from "./observations";

const sample = (elapsedMs = 0) => ({
	elapsedMs,
	latencyMs: null,
	fps: null,
	bufferSeconds: null,
	droppedFrames: null,
	decodedFrames: null,
	presentedFrames: null,
	totalFrames: null,
	resolution: null,
});
const update = () => ({
	startedAt: "2026-11-18T00:00:00.000Z",
	endedAt: null,
	samples: [sample()],
	events: [{ elapsedMs: 0, type: "started" }],
});

describe("bounded browser MoQ observations", () => {
	it("preserves unknown measurements as null", () => {
		expect(moqObservationUpdateSchema.parse(update())).toEqual(update());
	});
	it("retains the measured buffer source without accepting free text", () => {
		expect(
			moqObservationUpdateSchema.safeParse({
				...update(),
				samples: [{ ...sample(), bufferSource: "player" }],
			}).success,
		).toBe(true);
		expect(
			moqObservationUpdateSchema.safeParse({
				...update(),
				samples: [{ ...sample(), bufferSource: "https://relay/private-token" }],
			}).success,
		).toBe(false);
	});
	it.each([
		{ samples: Array.from({ length: 601 }, (_, i) => sample(i * 1_000)) },
		{ samples: [sample(0), sample(999)] },
		{ samples: [sample(2_000), sample(1_000)] },
		{ samples: [{ ...sample(), elapsedMs: 600_001 }] },
		{ samples: [{ ...sample(), fps: Number.NaN }] },
		{ samples: [{ ...sample(), decodedFrames: -1 }] },
		{ samples: [{ ...sample(), resolution: { width: 0, height: 720 } }] },
		{ samples: [{ ...sample(), url: "https://relay.example/private-token" }] },
		{ events: [{ elapsedMs: 0, type: "raw SDK error" }] },
		{
			events: Array.from({ length: 33 }, () => ({
				elapsedMs: 0,
				type: "started",
			})),
		},
		{ endedAt: "2026-11-18T00:10:01.000Z" },
		{ endedAt: "2026-11-17T23:59:59.000Z" },
		{ playbackUrl: "https://relay.example/private-token" },
	])("rejects out-of-budget or secret-bearing fields", (override) => {
		expect(
			moqObservationUpdateSchema.safeParse({ ...update(), ...override })
				.success,
		).toBe(false);
	});
});
