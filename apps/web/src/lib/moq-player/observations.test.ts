import { describe, expect, it } from "vitest";
import {
	appendMoqObservationEvent,
	MOQ_OBSERVATION_LIMITS,
	type MoqObservationEvent,
	moqObservationUpdateSchema,
} from "./observations";

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
	it("keeps ordered playback stages and reserves space for the terminal event", () => {
		let events: readonly MoqObservationEvent[] = [];
		for (const [elapsedMs, type] of [
			[0, "started"],
			[1, "descriptor-ready"],
			[2, "subscribe-requested"],
			[3, "first-frame"],
		] as const) {
			events = appendMoqObservationEvent(events, { elapsedMs, type });
		}
		expect(
			appendMoqObservationEvent(events, { elapsedMs: 4, type: "first-frame" }),
		).toBe(events);
		for (let i = 0; i < 100; i++) {
			events = appendMoqObservationEvent(events, {
				elapsedMs: 4 + i,
				type: i % 2 ? "frame-resumed" : "frame-gap",
			});
		}
		expect(events).toHaveLength(MOQ_OBSERVATION_LIMITS.events - 1);
		expect(
			events.filter((event) => event.type === "frame-gap").length,
		).toBeGreaterThan(1);
		const done = appendMoqObservationEvent(events, {
			elapsedMs: 200,
			type: "failed",
		});
		expect(done).toHaveLength(MOQ_OBSERVATION_LIMITS.events);
		expect(done.at(-1)).toEqual({ elapsedMs: 200, type: "failed" });
		expect(
			appendMoqObservationEvent(done, { elapsedMs: 201, type: "stopped" }),
		).toBe(done);
		expect(
			moqObservationUpdateSchema.parse({ ...update(), events: done }).events,
		).toEqual(done);
	});
	it("preserves unknown measurements as null", () => {
		expect(moqObservationUpdateSchema.parse(update())).toEqual(update());
	});
	it("persists bounded rendering provenance while older histories keep it absent", () => {
		expect(
			moqObservationUpdateSchema.safeParse({
				...update(),
				samples: [{ ...sample(), renderingSource: "canvas" }],
			}).success,
		).toBe(true);
		expect(
			moqObservationUpdateSchema.safeParse({
				...update(),
				samples: [{ ...sample(), renderingSource: "https://relay/private" }],
			}).success,
		).toBe(false);
		expect(
			moqObservationUpdateSchema.parse(update()).samples[0],
		).not.toHaveProperty("renderingSource");
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
