import { randomUUID } from "node:crypto";
import {
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";
import { createLibraryMediaTaskSweep } from "./media-task-sweep";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./media-task-execution", async (original) => ({
	...(await original<object>()),
	executeMediaTask: execute,
}));
afterEach(() => execute.mockReset());

function fixture(
	version: "CURRENT" | "OLD_ALGORITHM" | "OLD_CLOCK",
	active = false,
) {
	const f = generationDependencyFixture("TRACK"),
		instant = new Date();
	if (version === "OLD_ALGORITHM") {
		f.dependency.parameters.identity.trackingAlgorithmVersion =
			"template-ncc-v1";
		f.dependency.result.algorithm = "template-ncc-v1";
	}
	if (version !== "CURRENT") {
		delete f.dependency.parameters.identity.trackingFrameClockVersion;
		delete f.dependency.result.frameClockVersion;
	}
	f.refresh();
	const input = mediaTaskCreateSchema.parse({
		...f.dependency.parameters.input,
		requestKey: randomUUID(),
	});
	if (input.kind !== "TRACK") throw new Error("Missing TRACK fixture");
	const identity = structuredClone(f.dependency.parameters.identity);
	Object.assign(f.task, {
		kind: "TRACK",
		requestKey: input.requestKey,
		requestHash: mediaTaskIntentHash(input),
		cacheKey: mediaTaskCacheKey(input, identity),
		parameters: { schemaVersion: 1, input, identity },
		state: "PENDING",
		phase: "QUEUED",
		availableAt: instant,
		createdAt: instant,
		attempts: 0,
		startedAt: null,
		finishedAt: null,
		leaseToken: null,
		leaseUntil: null,
		result: null,
		error: null,
	});
	Object.assign(f.dependency, {
		state: active ? "RUNNING" : "SUCCEEDED",
		phase: active ? "TRACKING" : "COMPLETE",
		createdAt: new Date(instant.getTime() - 1000),
		availableAt: new Date(instant.getTime() - 1000),
		...(active
			? {
					leaseToken: randomUUID(),
					leaseUntil: new Date(instant.getTime() + 60_000),
				}
			: {}),
	});
	return { ...f, instant, previous: structuredClone(f.dependency) };
}
async function sweep(f: ReturnType<typeof fixture>) {
	await createLibraryMediaTaskSweep({
		prisma: f.prisma,
		browserFor: vi.fn(),
		now: () => f.instant,
	})();
}

describe("claim rejects legacy tracking before cache or active follower adoption", () => {
	it.each([
		["OLD_ALGORITHM", "TRACKING_ALGORITHM_CHANGED"],
		["OLD_CLOCK", "TRACKING_FRAME_CLOCK_CHANGED"],
	] as const)("fails an unfinished %s even when a matching old success exists", async (version, error) => {
		const f = fixture(version);
		await sweep(f);
		expect(f.task).toMatchObject({
			state: "ERROR",
			phase: "FAILED",
			error,
			result: null,
			finishedAt: f.instant,
			leaseToken: null,
			leaseUntil: null,
		});
		expect(f.dependency).toEqual(f.previous);
		expect(execute).not.toHaveBeenCalled();
	});
	it.each([
		["OLD_ALGORITHM", "TRACKING_ALGORITHM_CHANGED"],
		["OLD_CLOCK", "TRACKING_FRAME_CLOCK_CHANGED"],
	] as const)("fails an unfinished %s instead of waiting on an old active follower", async (version, error) => {
		const f = fixture(version, true);
		await sweep(f);
		expect(f.task).toMatchObject({ state: "ERROR", phase: "FAILED", error });
		expect(f.task).not.toHaveProperty("phase", "WAITING_FOR_CACHE");
		expect(f.dependency).toEqual(f.previous);
		expect(execute).not.toHaveBeenCalled();
	});
	it("keeps exact current-version TRACK result caching", async () => {
		const f = fixture("CURRENT");
		await sweep(f);
		expect(f.task).toMatchObject({
			state: "SUCCEEDED",
			phase: "CACHED",
			result: f.previous.result,
		});
		expect(f.dependency).toEqual(f.previous);
		expect(execute).not.toHaveBeenCalled();
	});
	it("keeps current-version active follower waiting", async () => {
		const f = fixture("CURRENT", true);
		await sweep(f);
		expect(f.task).toMatchObject({
			state: "PENDING",
			phase: "WAITING_FOR_CACHE",
			error: null,
		});
		expect(f.dependency).toEqual(f.previous);
		expect(execute).not.toHaveBeenCalled();
	});
	it("never changes an already completed legacy task when no unfinished work remains", async () => {
		const f = fixture("OLD_CLOCK");
		f.rows.splice(f.rows.indexOf(f.task), 1);
		await sweep(f);
		expect(f.dependency).toEqual(f.previous);
		expect(execute).not.toHaveBeenCalled();
	});
});
