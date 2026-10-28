import { createHash } from "node:crypto";
import {
	type EncodingPlan,
	encodingPlanSchema,
	libraryFileOutputs,
	libraryPlaybackLinks,
	librarySnapshotSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { expect, it, vi } from "vitest";
import fixture from "../../../../packages/core/src/plan/__fixtures__/ai-scene-analysis-passthrough-test.plan.json";
import { createLibraryCaptureSweep } from "./capture-sweep";

it("captures bounded finished history, continues after an invalid legacy job, and resets the cursor", async () => {
	const findMany = vi
		.fn()
		.mockResolvedValueOnce([
			{ id: "a", plan: {}, librarySources: [] },
			{ id: "b", plan: {}, librarySources: [] },
		])
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([]);
	const capture = vi
		.fn()
		.mockRejectedValueOnce(new Error("invalid plan"))
		.mockResolvedValueOnce({});
	const tick = createLibraryCaptureSweep({
		prisma: { encodingJob: { findMany } } as unknown as AppPrismaClient,
		capture,
	});
	await tick();
	await tick();
	await tick();
	expect(capture).toHaveBeenCalledTimes(2);
	expect(findMany.mock.calls[0]?.[0]).toMatchObject({
		where: { status: "FINISHED", libraryCaptureSuppressed: false },
		take: 25,
	});
	expect(findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: "b" });
	expect(findMany.mock.calls[2]?.[0].where.id).toBeUndefined();
});

it("skips exact registered assets but captures changed encoding identity and legacy missing locators", async () => {
	const hash = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const row = (
		id: string,
		plan: unknown,
		encoding: string,
		storedEncoding: string,
		snapshot = {},
	) => ({
		id,
		plan,
		bitmovinEncodingId: encoding,
		librarySources: [
			{
				sourceKey: hash([id, storedEncoding, hash(plan)]),
				snapshot,
				revisions: [{ id: "revision" }],
			},
		],
	});
	const findMany = vi
		.fn()
		.mockResolvedValue([
			row("exact", {}, "one", "one"),
			row("changed", {}, "two", "one"),
			row("legacy", { aiSceneAnalysis: {} }, "one", "one"),
		]);
	const capture = vi.fn().mockResolvedValue({});
	await createLibraryCaptureSweep({
		prisma: { encodingJob: { findMany } } as unknown as AppPrismaClient,
		capture,
	})();
	expect(capture.mock.calls.map((args) => args[1])).toEqual([
		"changed",
		"legacy",
	]);
});

function qcPlan(codec: "H264" | "VP9" = "H264") {
	const plan = encodingPlanSchema.parse({
		...fixture,
		aiSceneAnalysis: undefined,
		qc: { vmaf: true, only: true },
	});
	if (codec === "VP9")
		plan.renditions = [
			{
				key: "v180",
				codec: "VP9",
				mode: "STANDARD",
				ingestKey: "video",
				width: 640,
				height: 360,
				bitrate: 350000,
				rate: 24,
			},
		];
	return plan;
}
function registered(plan: EncodingPlan) {
	const hash = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const planHash = hash(plan);
	return {
		id: "finished-job",
		plan,
		bitmovinEncodingId: "owned-encoding",
		librarySources: [
			{
				sourceKey: hash(["finished-job", "owned-encoding", planHash]),
				state: "READY",
				revisions: [{ id: "editorial-revision" }],
				snapshot: librarySnapshotSchema.parse({
					schemaVersion: 1,
					kind: "VOD_JOB",
					name: "Existing source",
					planHash,
					identity: "UNVERIFIED",
					inputs: [],
					playbackLinks: [],
					fileOutputs: [],
					qcVerdict: null,
					qcOverriddenAt: null,
				}),
			},
		],
	};
}
function sweep(
	job: ReturnType<typeof registered>,
	capture = vi.fn().mockResolvedValue({}),
) {
	const findMany = vi.fn().mockResolvedValue([job]);
	return {
		capture,
		findMany,
		tick: createLibraryCaptureSweep({
			prisma: { encodingJob: { findMany } } as unknown as AppPrismaClient,
			capture,
		}),
	};
}

it.each([
	"H264",
	"VP9",
] as const)("repairs an empty registered QC-only %s snapshot once", async (codec) => {
	const job = registered(qcPlan(codec));
	const source = job.librarySources[0];
	if (!source) throw new Error("Missing source");
	const expected = libraryFileOutputs(job.plan);
	expect(expected).toHaveLength(1);
	const capture = vi.fn().mockImplementation(async () => {
		source.snapshot = {
			...source.snapshot,
			fileOutputs: expected,
			playbackLinks: libraryPlaybackLinks(job.plan, []),
		};
		return {};
	});
	const { tick, findMany } = sweep(job, capture);
	await tick();
	expect(capture).toHaveBeenCalledTimes(1);
	expect(capture.mock.calls[0]?.[1]).toBe(job.id);
	findMany.mockResolvedValueOnce([]);
	await tick();
	await tick();
	expect(capture).toHaveBeenCalledTimes(1);
	expect(source.revisions).toEqual([{ id: "editorial-revision" }]);
});

it.each([
	"files",
	"links",
] as const)("repairs missing %s without requiring a new source identity", async (missing) => {
	const job = registered(qcPlan());
	const source = job.librarySources[0];
	if (!source) throw new Error("Missing source");
	if (missing === "files")
		source.snapshot.playbackLinks = libraryPlaybackLinks(job.plan, []);
	else source.snapshot.fileOutputs = libraryFileOutputs(job.plan);
	const { tick, capture } = sweep(job);
	await tick();
	expect(capture).toHaveBeenCalledTimes(1);
});

it.each([
	"per-title",
	"segmented",
	"encrypted",
	"disabled",
] as const)("does not repeatedly capture ineligible %s outputs", async (kind) => {
	const plan = qcPlan();
	const muxing = plan.muxings[0];
	if (!muxing?.destination) throw new Error("Missing destination");
	if (kind === "per-title") {
		const video = plan.renditions[0];
		if (video?.codec !== "H264") throw new Error("Missing video");
		video.mode = "PER_TITLE_TEMPLATE";
	} else if (kind === "segmented") {
		plan.qc = undefined;
		plan.muxings = [
			{
				key: "segmented",
				kind: "WEBM",
				streamKey: "v180",
				progressive: false,
				segmentLength: 2,
				segmentNaming: "segment_%number%.chk",
				initSegmentName: "init.hdr",
				destination: muxing.destination,
			},
		];
	} else if (kind === "encrypted") {
		plan.drm = [
			{
				key: "encrypted",
				kind: "CENC",
				muxingKey: muxing.key,
				credentialId: "00000000-0000-4000-8000-000000000003",
				kid: "0".repeat(32),
				destination: muxing.destination,
			},
		];
	} else plan.qc = { vmaf: false, only: true, model: "vmaf_v0.6.1" };
	const parsed = encodingPlanSchema.parse(plan);
	expect(libraryFileOutputs(parsed)).toEqual([]);
	const { tick, capture, findMany } = sweep(registered(parsed));
	await tick();
	findMany.mockResolvedValueOnce([]);
	await tick();
	await tick();
	expect(capture).not.toHaveBeenCalled();
});

it.each([
	"identity conflict",
	"plan mismatch",
	"full snapshot",
	"running capture",
] as const)("does not retry metadata that registration cannot safely replace: %s", async (condition) => {
	const job = registered(qcPlan());
	const source = job.librarySources[0];
	const file = libraryFileOutputs(job.plan)[0];
	if (!source || !file) throw new Error("Missing source file");
	if (condition === "identity conflict")
		source.snapshot.fileOutputs = [{ ...file, path: "retained/original.mp4" }];
	else if (condition === "plan mismatch")
		source.snapshot.planHash = "another-plan";
	else if (condition === "full snapshot")
		source.snapshot.fileOutputs = Array.from({ length: 100 }, (_, index) => ({
			...file,
			key: `retained-${index}`,
		}));
	else source.state = "RUNNING";
	const { tick, capture } = sweep(job);
	await tick();
	expect(capture).not.toHaveBeenCalled();
});
