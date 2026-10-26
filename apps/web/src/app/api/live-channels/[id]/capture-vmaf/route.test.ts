import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channelFindUnique = vi.fn();
const feederFindFirst = vi.fn();
const runFindFirst = vi.fn();
const vmafCreate = vi.fn();
const vmafUpdate = vi.fn();
const queueAdd = vi.fn();
const listObjects = vi.fn();
const locks = vi.fn();
const txChannelRead = vi.fn();
const txRunRead = vi.fn();
vi.mock("@/lib/server/storage", () => ({
	browserForCredentialId: async () => ({
		listObjects,
		getObject: vi.fn(),
		dispose: vi.fn(),
	}),
}));

let qcVmafEnabled = true;

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			$transaction: async (fn: (tx: unknown) => unknown) =>
				fn({
					$queryRaw: locks,
					liveChannel: { findUnique: txChannelRead },
					liveChannelRun: { findFirst: txRunRead },
					vmafJob: { create: vmafCreate },
				}),
			// : the flag gate reads through the same context. The
			// harness default is ON so every pre-existing case keeps testing
			// what it was written for; the off-case pin flips it.
			appSetting: {
				findUnique: async () => ({ value: { qcVmaf: qcVmafEnabled } }),
			},
			liveChannel: { findUnique: channelFindUnique },
			liveChannelRun: { findFirst: runFindFirst },
			feederSession: { findFirst: feederFindFirst },
			vmafJob: { create: vmafCreate, update: vmafUpdate },
		},
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getVmafQueue: () => ({ add: queueAdd }),
}));

import { liveChannelPlanSchema } from "@bitovp/core";
import { POST } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";
const VMAF_JOB_ID = "00000000-0000-4000-8000-0000000000aa";
const RUN = {
	id: "run-current",
	seq: 1,
	status: "RUNNING",
	bitmovinEncodingId: "encoding-current",
	outputPrefix: "",
	createdAt: new Date("2026-09-01T00:00:00Z"),
};
const PLAN = {
	planVersion: 1,
	name: "capture",
	bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1", encoderVersion: "STABLE" },
	liveInput: { key: "main", kind: "RTMP" },
	outputs: [
		{
			key: "out",
			kind: "S3",
			credentialId: "3e6ffbdd-3e6f-4bdd-8e6f-fbdd3e6f4bdd",
			bucket: "bucket",
		},
	],
	ingest: [{ key: "video", inputPath: "live", position: 0 }],
	renditions: [
		{
			key: "v720",
			codec: "H264",
			ingestKey: "video",
			height: 720,
			bitrate: 3000000,
		},
	],
	muxings: [
		{
			key: "v720",
			kind: "TS",
			streamKey: "v720",
			segmentLength: 6,
			segmentNaming: "segment_%number%.ts",
			destination: { outputKey: "out", path: "live/video/720p" },
		},
	],
	liveManifests: [
		{
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			destination: { outputKey: "out", path: "live" },
		},
	],
	start: { streamKey: "capturekey" },
};

function postCapture(body: unknown = {}) {
	return POST(
		new Request(`http://test/api/live-channels/${CHANNEL_ID}/capture-vmaf`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: CHANNEL_ID }) },
	);
}

beforeEach(() => {
	const validated = liveChannelPlanSchema.safeParse(PLAN);
	expect(validated.error?.issues).toBeUndefined();
	qcVmafEnabled = true;
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	channelFindUnique.mockResolvedValue({
		id: CHANNEL_ID,
		status: "RUNNING",
		bitmovinEncodingId: RUN.bitmovinEncodingId,
		plan: PLAN,
	});
	// The RUNNING channel's current run — the capture pins it (review-284 m4).
	runFindFirst.mockResolvedValue(RUN);
	listObjects.mockImplementation(async ({ prefix }) => ({
		prefixes: [],
		objects: ["segment_1.ts", "seg-{rand_chars:8}-1.ts"].map((name) => ({
			key: `${prefix}${name}`,
			size: 188,
			lastModified: new Date(Date.now() - 1000).toISOString(),
		})),
	}));
	txChannelRead.mockImplementation(
		() => channelFindUnique.mock.results.at(-1)?.value,
	);
	txRunRead.mockImplementation(() => runFindFirst.mock.results.at(-1)?.value);
	locks.mockResolvedValue([{ id: CHANNEL_ID }]);
	feederFindFirst.mockResolvedValue({ id: "feeder-1" });
	vmafCreate.mockResolvedValue({ id: VMAF_JOB_ID });
	queueAdd.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/live-channels/[id]/capture-vmaf", () => {
	it.each([
		0, 1,
	])("rejects random-only naming on video target %i before reading storage or creating a capture job", async (index) => {
		const plan = liveChannelPlanSchema.parse(PLAN);
		const first = plan.renditions[0],
			firstMuxing = plan.muxings[0];
		if (first?.codec !== "H264" || !firstMuxing)
			throw new Error("Missing fixtures");
		plan.renditions.push({ ...first, key: "v360", height: 360 });
		plan.muxings.push({
			...firstMuxing,
			key: "v360",
			streamKey: "v360",
			destination: { outputKey: "out", path: "live/video/360p" },
		});
		const target = plan.muxings[index];
		if (!target || target.kind === "MP4")
			throw new Error("Missing capture target");
		target.segmentNamingTemplate = "seg_{segment_rand_chars:8}.mp4";
		// The parsed schema's literal default must not mask the effective template.
		expect(target.segmentNaming).toContain("%number%");
		channelFindUnique.mockResolvedValue({
			id: CHANNEL_ID,
			status: "RUNNING",
			bitmovinEncodingId: RUN.bitmovinEncodingId,
			plan,
		});
		const response = await postCapture();
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.error).toMatch(/%number%.*order/i);
		expect(body.details).toMatchObject({
			code: "LIVE_VMAF_SEGMENT_NUMBER_REQUIRED",
			rendition: index === 0 ? "v720" : "v360",
		});
		expect(feederFindFirst).not.toHaveBeenCalled();
		expect(runFindFirst).not.toHaveBeenCalled();
		expect(listObjects).not.toHaveBeenCalled();
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		1, 2,
	])("only enqueues when the MSL muxing has one readable mirror (%i)", async (count) => {
		const mirrored = liveChannelPlanSchema.parse(PLAN);
		const credentialId = PLAN.outputs[0]?.credentialId;
		if (!credentialId) throw new Error("fixture credential missing");
		mirrored.outputs = [
			{
				key: "out",
				name: "MSL primary",
				kind: "AKAMAI_MSL",
				credentialId,
				streamFormat: "HLS",
				mslVersion: "MSL4",
			},
		];
		mirrored.deliveryMirrors = [];
		for (let i = 0; i < count; i++) {
			mirrored.outputs.push({
				key: `storage-${i}`,
				name: `Storage mirror ${i}`,
				kind: "GENERIC_S3",
				credentialId,
				bucket: `bucket-${i}`,
			});
			mirrored.deliveryMirrors.push({ outputKey: `storage-${i}` });
		}
		channelFindUnique.mockResolvedValue({
			id: CHANNEL_ID,
			status: "RUNNING",
			bitmovinEncodingId: RUN.bitmovinEncodingId,
			plan: mirrored,
		});
		const response = await postCapture();
		expect(response.status).toBe(count === 1 ? 201 : 409);
		if (count === 1) {
			expect(listObjects).toHaveBeenCalledWith(
				expect.objectContaining({
					bucket: "bucket-0",
					prefix: "live/video/720p/",
				}),
			);
			expect(vmafCreate).toHaveBeenCalledTimes(1);
			expect(queueAdd).toHaveBeenCalledTimes(1);
		} else {
			expect(listObjects).not.toHaveBeenCalled();
			expect(vmafCreate).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		}
	});
	it.each([
		"LiveChannel",
		"LiveChannelRun",
	])("refuses a capture without waiting on a concurrent %s writer", async (busyTable) => {
		// Terminal reconciliation owns run → channel; Start/revive owns
		// channel → run. Model either writer already owning its first row.
		locks.mockImplementation(async (sql: TemplateStringsArray) => {
			const query = sql.join("?");
			if (query.includes(`FROM "${busyTable}"`)) {
				if (!query.includes("SKIP LOCKED")) {
					throw new Error("blocking lock conflicts with lifecycle writer");
				}
				return [];
			}
			return [{ id: CHANNEL_ID }];
		});
		const response = await postCapture();
		expect(response.status).toBe(409);
		expect((await response.json()).details.code).toBe(
			"LIVE_VMAF_READINESS_UNOBSERVABLE",
		);
		expect(txChannelRead).not.toHaveBeenCalled();
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it.each([
		0, 1,
	])("refuses when lock query %i returns no exact row", async (index) => {
		locks.mockImplementation(async () =>
			locks.mock.calls.length === index + 1 ? [] : [{ id: CHANNEL_ID }],
		);
		expect((await postCapture()).status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("refuses readiness that expires while waiting for the transaction lock", async () => {
		const started = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(started);
		locks.mockImplementation(async () => {
			clock.mockReturnValue(started + 15_000);
			return [{ id: CHANNEL_ID }];
		});
		try {
			expect((await postCapture()).status).toBe(409);
			expect(vmafCreate).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		{ id: "new-run" },
		{ status: "STOPPED" },
		{ bitmovinEncodingId: "new-encoding" },
		{ outputPrefix: "foreign" },
		{ createdAt: new Date("2026-09-08") },
	])("refuses a run change after storage reads: %j", async (change) => {
		txRunRead.mockResolvedValue({ ...RUN, ...change });
		expect((await postCapture()).status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("refuses a changed plan under the channel lock", async () => {
		txChannelRead.mockResolvedValue({
			id: CHANNEL_ID,
			status: "RUNNING",
			bitmovinEncodingId: RUN.bitmovinEncodingId,
			plan: { ...PLAN, name: "edited" },
		});
		expect((await postCapture()).status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
	});
	it("locks channel then run, after storage and before job creation", async () => {
		expect((await postCapture()).status).toBe(201);
		expect(String(locks.mock.calls[0]?.[0])).toContain('FROM "LiveChannel"');
		expect(String(locks.mock.calls[1]?.[0])).toContain('FROM "LiveChannelRun"');
		expect(listObjects.mock.invocationCallOrder[0]).toBeLessThan(
			locks.mock.invocationCallOrder[0] ?? 0,
		);
		expect(locks.mock.invocationCallOrder[1]).toBeLessThan(
			vmafCreate.mock.invocationCallOrder[0] ?? 0,
		);
	});
	it("refuses a mismatched current encoding before storage reads", async () => {
		runFindFirst.mockResolvedValueOnce({
			...RUN,
			bitmovinEncodingId: "prior-encoding",
		});
		expect((await postCapture()).status).toBe(409);
		expect(listObjects).not.toHaveBeenCalled();
	});
	it("storage failures are actionable and never expose upstream messages", async () => {
		listObjects.mockRejectedValue(new Error("secret URL"));
		const response = await postCapture();
		expect(response.status).toBe(409);
		const result = await response.json();
		expect(result.details.code).toBe("LIVE_VMAF_READINESS_UNOBSERVABLE");
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(vmafCreate).not.toHaveBeenCalled();
	});
	it("does not queue capture when current-run readiness has never been observed", async () => {
		runFindFirst.mockResolvedValueOnce({ ...RUN, originObservation: null });
		listObjects.mockResolvedValue({ prefixes: [], objects: [] });
		expect((await postCapture()).status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("does not treat one historically published rendition as readiness for every target", async () => {
		runFindFirst.mockResolvedValueOnce({
			...RUN,
			originObservation: {
				publish: "PUBLISHED",
				lastFetchAtMs: 1,
				playlists: { "old/v720.m3u8": { segmentCount: 1 } },
			},
		});
		listObjects.mockResolvedValue({ prefixes: [], objects: [] });
		expect((await postCapture()).status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	it("creates a LIVE VmafJob and enqueues it (default window)", async () => {
		const res = await postCapture();
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toMatchObject({
			id: VMAF_JOB_ID,
			mode: "LIVE",
			status: "PENDING",
			windowSeconds: 120,
		});
		// Created with mode LIVE + params carrying the channel + window.
		expect(vmafCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					mode: "LIVE",
					status: "PENDING",
					// review-284 m4: the run on air is PINNED so a re-air between
					// queue and processing cannot swap the subtree under the job.
					params: {
						liveChannelId: CHANNEL_ID,
						windowSeconds: 120,
						liveChannelRunId: "run-current",
					},
				}),
			}),
		);
		// Enqueued with jobId = vmafJobId.
		expect(queueAdd).toHaveBeenCalledWith(
			"vmaf",
			{ vmafJobId: VMAF_JOB_ID },
			expect.objectContaining({ jobId: VMAF_JOB_ID }),
		);
	});

	it("refuses a non-S3 capture target at REQUEST time — the worker's late throw, moved to the click (ledger #137(d))", async () => {
		channelFindUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status: "RUNNING",
			plan: {
				planVersion: 1,
				name: "msl",
				bitmovin: { cloudRegion: "AUTO", encoderVersion: "STABLE" },
				liveInput: { key: "main", kind: "RTMP" },
				outputs: [
					{
						key: "origin",
						kind: "AKAMAI_MSL",
						credentialId: "3e6ffbdd-3e6f-4bdd-8e6f-fbdd3e6f4bdd",
						name: "MSL",
						streamFormat: "HLS",
					},
				],
				ingest: [{ key: "video", inputPath: "live", position: 0 }],
				renditions: [
					{
						key: "v720",
						codec: "H264",
						ingestKey: "video",
						height: 720,
						bitrate: 3000000,
					},
				],
				muxings: [
					{
						key: "v720",
						kind: "TS",
						streamKey: "v720",
						segmentLength: 6,
						segmentNaming: "seg-{rand_chars:8}-%number%.ts",
						destination: { outputKey: "origin", path: "live-msl/video/720p" },
					},
				],
				liveManifests: [
					{
						key: "hls",
						kind: "HLS",
						manifestName: "stream.m3u8",
						name: "HLS",
						destination: { outputKey: "origin", path: "live-msl" },
					},
				],
				start: { streamKey: "capturekey" },
			},
		});
		const res = await postCapture();
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toMatch(
			/AKAMAI_MSL.*INGEST target with no readable origin/,
		);
		expect(body).toMatchObject({
			details: {
				code: "LIVE_VMAF_OUTPUT_UNREADABLE",
				output: "origin",
				rendition: "v720",
			},
		});
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	it("ACCEPTS an Akamai Object Storage target — GENERIC_S3 is the S3 family (C10), ledger #190", async () => {
		channelFindUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			bitmovinEncodingId: RUN.bitmovinEncodingId,
			status: "RUNNING",
			plan: {
				planVersion: 1,
				name: "aos",
				bitmovin: { cloudRegion: "AUTO", encoderVersion: "STABLE" },
				liveInput: { key: "main", kind: "RTMP" },
				outputs: [
					{
						key: "origin",
						kind: "GENERIC_S3",
						credentialId: "3e6ffbdd-3e6f-4bdd-8e6f-fbdd3e6f4bdd",
						name: "AOS",
						bucket: "aos-bucket",
					},
				],
				ingest: [{ key: "video", inputPath: "live", position: 0 }],
				renditions: [
					{
						key: "v720",
						codec: "H264",
						ingestKey: "video",
						height: 720,
						bitrate: 3000000,
					},
				],
				muxings: [
					{
						key: "v720",
						kind: "TS",
						streamKey: "v720",
						segmentLength: 6,
						segmentNaming: "seg-{rand_chars:8}-%number%.ts",
						destination: { outputKey: "origin", path: "live-msl/video/720p" },
					},
				],
				liveManifests: [
					{
						key: "hls",
						kind: "HLS",
						manifestName: "stream.m3u8",
						name: "HLS",
						destination: { outputKey: "origin", path: "live-msl" },
					},
				],
				start: { streamKey: "capturekey" },
			},
		});
		// The whole point of AKR-E57-009: this used to 409 before the job was
		// ever queued, so a RUNNING AOS channel could not be measured at all.
		const res = await postCapture();
		expect(res.status).toBe(201);
		expect(vmafCreate).toHaveBeenCalled();
	});

	it("refuses when a LATER rendition lands on an unreadable output — the worker scores every target, not just the first (review of #190)", async () => {
		channelFindUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status: "RUNNING",
			plan: {
				planVersion: 1,
				name: "mixed",
				bitmovin: { cloudRegion: "AUTO", encoderVersion: "STABLE" },
				liveInput: { key: "main", kind: "RTMP" },
				outputs: [
					{
						key: "origin",
						kind: "GENERIC_S3",
						credentialId: "3e6ffbdd-3e6f-4bdd-8e6f-fbdd3e6f4bdd",
						name: "AOS",
						bucket: "aos-bucket",
					},
					{
						key: "mslx",
						kind: "AKAMAI_MSL",
						credentialId: "3e6ffbdd-3e6f-4bdd-8e6f-fbdd3e6f4bdd",
						name: "MSL",
						streamFormat: "HLS",
					},
				],
				ingest: [{ key: "video", inputPath: "live", position: 0 }],
				renditions: [
					{
						key: "v720",
						codec: "H264",
						ingestKey: "video",
						height: 720,
						bitrate: 3000000,
					},
					{
						key: "v1080",
						codec: "H264",
						ingestKey: "video",
						height: 1080,
						bitrate: 5000000,
					},
				],
				muxings: [
					{
						key: "v720",
						kind: "TS",
						streamKey: "v720",
						segmentLength: 6,
						segmentNaming: "seg-{rand_chars:8}-%number%.ts",
						destination: { outputKey: "origin", path: "live-msl/video/720p" },
					},
					{
						key: "v1080",
						kind: "TS",
						streamKey: "v1080",
						segmentLength: 6,
						segmentNaming: "seg-{rand_chars:8}-%number%.ts",
						destination: { outputKey: "mslx", path: "live-msl/video/1080p" },
					},
				],
				liveManifests: [
					{
						key: "hls",
						kind: "HLS",
						manifestName: "stream.m3u8",
						name: "HLS",
						destination: { outputKey: "origin", path: "live-msl" },
					},
				],
				start: { streamKey: "capturekey" },
			},
		});
		// targets[0] is the readable AOS rendition; targets[1] lands on MSL.
		// Inspecting only the first returned 201 here and threw in the worker
		// after the operator walked away.
		const res = await postCapture();
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/v1080.*INGEST target/);
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	it("a legacy channel with NO run rows cannot establish current-run readiness", async () => {
		runFindFirst.mockResolvedValueOnce(null);
		const res = await postCapture();
		expect(res.status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	it("honours a custom window", async () => {
		await postCapture({ windowSeconds: 60 });
		expect(vmafCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					params: {
						liveChannelId: CHANNEL_ID,
						windowSeconds: 60,
						liveChannelRunId: "run-current",
					},
				}),
			}),
		);
	});

	it("404s on an unknown channel", async () => {
		channelFindUnique.mockResolvedValueOnce(null);
		expect((await postCapture()).status).toBe(404);
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	it("409s when the channel is not RUNNING", async () => {
		channelFindUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status: "STOPPED",
		});
		const res = await postCapture();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "LIVE_VMAF_NOT_RUNNING", status: "STOPPED" },
		});
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	/**
	 * FIRST PUBLISH . The billed run of 2026-08-29 clicked
	 * Capture ~20 s after RUNNING; the route said 201 and the job died with
	 * "4 of 4 rendition(s) not scored … live capture found no segments". The
	 * encoder's own first publish was 36 765 ms in. RUNNING + a feeder was
	 * everything this route asked, and neither answers "is it on air".
	 */
	it("409s while the origin observer says this run is still AWAITING its first segment", async () => {
		listObjects.mockResolvedValue({ prefixes: [], objects: [] });
		runFindFirst.mockResolvedValueOnce({
			...RUN,
			originObservation: {
				lastFetchAtMs: 1,
				playlists: {},
				publish: "AWAITING",
			},
		});
		const res = await postCapture();
		expect(res.status).toBe(409);
		// The reason and the thing to wait for, both named — the panel renders
		// this sentence verbatim under the button that was just clicked.
		const body = await res.json();
		expect(body.error).toMatch(/Not every capture target.*wait briefly/s);
		expect(body.details.code).toBe("LIVE_VMAF_FIRST_SEGMENT_PENDING");
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
		// The WIRING, not only the rule: this fake ignores `select`, so without
		// this line a route that forgot to load the column would keep every arm
		// above green and read `undefined` against a real database.
		expect(runFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.objectContaining({
					bitmovinEncodingId: true,
					createdAt: true,
					outputPrefix: true,
				}),
			}),
		);
	});

	it("accepts once the observer has recorded a publish for the run", async () => {
		runFindFirst.mockResolvedValueOnce({
			...RUN,
			originObservation: {
				publish: "PUBLISHED",
				playlists: { "live/v1080.m3u8": { segmentCount: 4 } },
			},
		});
		expect((await postCapture()).status).toBe(201);
		expect(vmafCreate).toHaveBeenCalled();
	});

	it("accepts current storage evidence even when the HLS observer is absent or unavailable", async () => {
		// Four worlds reach here and none of them is "not published": a run
		// the sweep has not visited yet (RUNNING for less than one 10 s tick),
		// an empty record, an origin the observer cannot read at all (it is
		// HLS-only and driver-readable-only, so a DASH-only channel would
		// otherwise become permanently unmeasurable), and a row written before
		// the field existed. Failing closed here would trade one honest late
		// ERROR for a lockout.
		for (const originObservation of [
			null,
			{},
			{
				lastFetchAtMs: 1,
				unavailableReason: "no HLS media playlists in the plan",
			},
			{ playlists: { "live/v1080.m3u8": { segmentCount: 9 } } },
		]) {
			vmafCreate.mockClear();
			runFindFirst.mockResolvedValueOnce({
				...RUN,
				originObservation,
			});
			expect((await postCapture()).status).toBe(201);
			expect(vmafCreate).toHaveBeenCalledTimes(1);
		}
	});

	it("409s when the channel has no attached feeder (not pseudo-live)", async () => {
		feederFindFirst.mockResolvedValueOnce(null);
		const res = await postCapture();
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toMatch(/pseudo-live feeder/);
		expect(body.details.code).toBe("LIVE_VMAF_FEEDER_REQUIRED");
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	it("rejects an out-of-range window", async () => {
		expect((await postCapture({ windowSeconds: 5 })).status).toBe(400);
		expect((await postCapture({ windowSeconds: 9999 })).status).toBe(400);
	});

	it("marks the job ERROR and 500s when the enqueue fails", async () => {
		queueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await postCapture();
		expect(res.status).toBe(500);
		expect(vmafUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: VMAF_JOB_ID },
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
	});
});
