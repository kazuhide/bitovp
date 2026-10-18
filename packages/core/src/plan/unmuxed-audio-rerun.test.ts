import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "./schema";
import { validatePlan } from "./validate";

/**
 * The unpackaged-AUDIO refusal, and the one door it must not close — #192.
 *
 * BOTH directions live in this file on purpose. Read alone, either arm looks
 * like the whole rule: "audio dropped ⇒ refused" invites someone to demote it
 * everywhere the next time a re-run breaks, and "re-run demotes it" invites
 * someone to demote it at submit. The rule is the PAIR — new submissions are
 * refused, history is not re-litigated — so the pair is asserted together.
 *
 * The input is the exact shape the pre-fix wizard produced :
 * an fMP4 video leg and an AAC rendition packaged nowhere. Jobs of this shape
 * were SUBMITTED and FINISHED while it was a warning, which is precisely why
 * the re-run path cannot treat it as an error now.
 */
const droppedAudio = encodingPlanSchema.parse({
	planVersion: 1,
	name: "finished before the rail existed",
	bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1", encoderVersion: "STABLE" },
	inputs: [
		{
			key: "main",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "b",
			name: "In",
		},
	],
	outputs: [
		{
			key: "origin",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "b2",
			name: "Out",
		},
	],
	ingest: [
		{
			key: "video",
			inputKey: "main",
			inputPath: "/in.mp4",
			selectionMode: "VIDEO_RELATIVE",
			position: 0,
		},
		{
			key: "audio",
			inputKey: "main",
			inputPath: "/in.mp4",
			selectionMode: "AUDIO_RELATIVE",
			position: 0,
		},
	],
	renditions: [
		{
			key: "v720",
			codec: "H264",
			name: "H264 720p",
			ingestKey: "video",
			height: 720,
			bitrate: 2400000,
			profile: "MAIN",
		},
		{
			key: "a128",
			codec: "AAC",
			name: "AAC 128",
			ingestKey: "audio",
			bitrate: 128000,
			rate: 48000,
		},
	],
	muxings: [
		{
			key: "v720",
			kind: "FMP4",
			streamKey: "v720",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: { outputKey: "origin", path: "out/v", acl: "PUBLIC_READ" },
		},
	],
	manifests: [],
	generation: { timing: "POST_ENCODING" },
});

const unmuxed = (issues: ReturnType<typeof validatePlan>) =>
	issues.filter((i) => i.code === "PLAN_UNMUXED_RENDITION");

describe("PLAN_UNMUXED_RENDITION — audio, and the re-run door", () => {
	it("REFUSES a new submission: a dropped audio track is an error", () => {
		const found = unmuxed(validatePlan(droppedAudio));
		expect(found).toHaveLength(1);
		expect(found[0]?.level).toBe("error");
		expect(found[0]?.message).toContain("play silent");
	});

	it("DEMOTES on re-run: the same plan is a warning, not a block", () => {
		const found = unmuxed(
			validatePlan(droppedAudio, { demoteUnmuxedAudio: true }),
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.level).toBe("warning");
	});

	it("demotes rather than SKIPS — the operator still learns it is silent", () => {
		// The distinction that matters: suppressing the issue would let someone
		// re-run a silent job and be told nothing. `demoteQcIoReadable` made the
		// same choice for the same reason.
		const found = unmuxed(
			validatePlan(droppedAudio, { demoteUnmuxedAudio: true }),
		);
		expect(found).toHaveLength(1);
	});

	it("demotes ONLY audio — a dropped video rung was already a warning", () => {
		// The option must not become a blanket off-switch: it exists for one
		// retroactive refusal, not for the rail.
		const noVideoMuxing = encodingPlanSchema.parse({
			...droppedAudio,
			muxings: [
				{
					key: "a128",
					kind: "FMP4",
					streamKey: "a128",
					segmentLength: 6,
					segmentNaming: "segment_%number%.m4s",
					initSegmentName: "init.mp4",
					destination: {
						outputKey: "origin",
						path: "out/a",
						acl: "PUBLIC_READ",
					},
				},
			],
		});
		const plain = unmuxed(validatePlan(noVideoMuxing));
		expect(plain).toHaveLength(1);
		expect(plain[0]?.level).toBe("warning");
		expect(plain[0]?.message).not.toContain("play silent");
	});
});
