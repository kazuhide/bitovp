import { describe, expect, it } from "vitest";
import { mediaTaskCacheKey } from "./identity";
import {
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	mediaTaskCreateSchema,
	mediaTaskIdentitySchema,
} from "./schema";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = mediaTaskCreateSchema.parse({
	kind: "TRACK",
	mediaVersionId: id(1),
	requestKey: id(2),
	analysisRevisionId: id(3),
	parameters: {},
});
const legacy = {
	organizationId: id(4),
	mediaSha256: "a".repeat(64),
	modelSha256: null,
	analysisDocumentHash: "b".repeat(64),
	analysisRawHash: "c".repeat(64),
	timeMapHash: "d".repeat(64),
	bindingHash: null,
	trackingAlgorithmVersion: "template-ncc-v2" as const,
};
describe("server-owned tracking frame clock is separate from NCC algorithm identity", () => {
	it("preserves an absent-clock identity exactly instead of retroactively upgrading it", () => {
		expect(mediaTaskIdentitySchema.parse(legacy)).toEqual(legacy);
		expect(mediaTaskCacheKey(input, legacy)).toBe(
			"88fdfa48ec7056de419488d86409bb751b11db4536bd87af7c67a55546f0e7c8",
		);
	});
	it("admits only the current explicit clock and separates new results from legacy v2 cache", () => {
		expect(LOCAL_TRACKING_FRAME_CLOCK_VERSION).toBe("cfr30-source-frames-v1");
		const current = mediaTaskIdentitySchema.parse({
			...legacy,
			trackingFrameClockVersion: "cfr30-source-frames-v1",
		});
		expect(current.trackingFrameClockVersion).toBe("cfr30-source-frames-v1");
		expect(mediaTaskCacheKey(input, current)).not.toBe(
			mediaTaskCacheKey(input, legacy),
		);
		expect(
			mediaTaskIdentitySchema.safeParse({
				...current,
				trackingFrameClockVersion: "guessed",
			}).success,
		).toBe(false);
	});
});
