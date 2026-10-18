import { parseFeederError } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { projectSelected } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import type { SdkOps } from "./sdk-ops";
import {
	preflightUnverifiedReason,
	registerSlateContent,
	slateContentName,
} from "./slate-register";

/**
 *  — deferred slate registration. The protocol under test: the row
 * gains `insertableContentId` ONLY when the content is READY (that write IS
 * the sweep's fire gate), a redelivery adopts by name instead of duplicating,
 * and every terminal path leaves its reason on the row.
 */

const SCHEDULE_ID = "33333333-3333-4333-8333-333333333333";
const ENCODING_ID = "44444444-4444-4444-8444-444444444444";
const CRED_ID = "00000000-0000-4000-8000-0000000000c1";
const SOURCE = { credentialId: CRED_ID, bucket: "in", key: "slate.mp4" };

type RowState = {
	id: string;
	status: string;
	insertableContentId: string | null;
	contentClaimedAt: Date | null;
	note: string | null;
	error: string | null;
};

function makeDeps(over: {
	row?: Partial<RowState>;
	provider?: string;
	config?: Record<string, unknown>;
	secret?: Record<string, string>;
	contentStatuses?: string[];
	existing?: { id: string; name: string | null; status: string }[];
}) {
	const row: RowState = {
		id: SCHEDULE_ID,
		status: "ARMED",
		insertableContentId: null,
		contentClaimedAt: new Date(1_000),
		note: null,
		error: null,
		...over.row,
	};
	const statuses = [...(over.contentStatuses ?? ["READY"])];
	const sdk = {
		createS3Input: vi.fn(async () => "input-1"),
		createGenericS3Input: vi.fn(async () => "input-1"),
		createGcsInput: vi.fn(async () => "input-1"),
		createAzureInput: vi.fn(async () => "input-1"),
		createLiveInsertableContent: vi.fn(async () => "content-1"),
		getLiveInsertableContent: vi.fn(async (_e: string, id: string) => ({
			id,
			status: statuses.length > 1 ? (statuses.shift() as string) : statuses[0],
		})),
		listLiveInsertableContent: vi.fn(async () => over.existing ?? []),
	} as unknown as SdkOps;
	const prisma = {
		liveSchedule: {
			findUnique: vi.fn(async (args: { select?: Record<string, boolean> }) =>
				projectSelected({ ...row }, args?.select),
			),
			updateMany: vi.fn(
				async (args: {
					where: {
						id: string;
						status?: string;
						insertableContentId?: null;
					};
					data: Partial<RowState>;
				}) => {
					if (args.where.status && row.status !== args.where.status) {
						return { count: 0 };
					}
					if (
						"insertableContentId" in args.where &&
						row.insertableContentId !== args.where.insertableContentId
					) {
						return { count: 0 };
					}
					Object.assign(row, args.data);
					return { count: 1 };
				},
			),
		},
	} as unknown as AppPrismaClient;
	let clock = 0;
	const tick = () => {
		clock += 1_000;
		return new Date(clock);
	};
	return {
		row,
		sdk,
		deps: {
			prisma,
			sdk,
			resolveCredential: vi.fn(async () => ({
				provider: over.provider ?? "AWS_S3",
				config: over.config ?? {},
				secret: over.secret ?? { accessKeyId: "ak", secretAccessKey: "sk" },
			})),
			now: tick,
			sleep: async () => {},
			pollIntervalMs: 1,
			registrationTimeoutMs: 10_000,
		},
	};
}

const ARGS = {
	scheduleId: SCHEDULE_ID,
	source: SOURCE,
	encodingId: ENCODING_ID,
};

describe("registerSlateContent", () => {
	it("creates input + content, waits READY, then links the row — the fire gate", async () => {
		const t = makeDeps({ contentStatuses: ["CREATED", "CREATED", "READY"] });
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result).toEqual({
			outcome: "REGISTERED",
			insertableContentId: "content-1",
		});
		expect(t.row.insertableContentId).toBe("content-1");
		expect(t.row.note).toContain("content-1");
	});

	it("ADOPTS existing content by name instead of duplicating — the redelivery path", async () => {
		const t = makeDeps({
			existing: [
				{
					id: "content-earlier",
					name: slateContentName(SCHEDULE_ID),
					status: "READY",
				},
			],
		});
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result).toEqual({
			outcome: "REGISTERED",
			insertableContentId: "content-earlier",
		});
		// No second content, no input either: adoption skips creation whole.
		expect(t.sdk.createLiveInsertableContent).not.toHaveBeenCalled();
		expect(t.sdk.createS3Input).not.toHaveBeenCalled();
	});

	it("is idempotent when the row already carries a content id", async () => {
		const t = makeDeps({ row: { insertableContentId: "done-already" } });
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result.outcome).toBe("SKIPPED");
		expect(t.sdk.listLiveInsertableContent).not.toHaveBeenCalled();
	});

	it("content ERROR keeps the claim and writes the reason — a retry cannot fix a bad source", async () => {
		const t = makeDeps({ contentStatuses: ["ERROR"] });
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result.outcome).toBe("FAILED");
		expect(t.row.error).toContain("processing failed");
		expect(t.row.contentClaimedAt).not.toBeNull();
	});

	it("timeout RELEASES the claim so the sweep re-registers — and adoption makes that a resume", async () => {
		const t = makeDeps({ contentStatuses: ["CREATED"] });
		t.deps.registrationTimeoutMs = 2_500; // clock steps 1s per now
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result.outcome).toBe("RELEASED");
		expect(t.row.contentClaimedAt).toBeNull();
		expect(t.row.note).toContain("not READY");
	});

	it("an unsupported provider fails with the DRIVER named on the row", async () => {
		const t = makeDeps({ provider: "SFTP" });
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result.outcome).toBe("FAILED");
		expect(t.row.error).toContain("SFTP");
	});

	it("a THROWN SDK error lands on the row and RELEASES the claim — transient, so the sweep retries with a fresh epoch (review-223 F4)", async () => {
		const t = makeDeps({});
		(
			t.sdk.listLiveInsertableContent as unknown as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("ECONNRESET"));
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result.outcome).toBe("RELEASED");
		expect(t.row.note).toContain("slate registration failed: ECONNRESET");
		expect(t.row.contentClaimedAt).toBeNull();
	});

	it("an AWS credential with no secret is refused BY NAME and HOLDS the claim — deterministic, like every other refusal (review-223b)", async () => {
		const t = makeDeps({ secret: {} });
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result).toEqual({
			outcome: "FAILED",
			reason: "S3 credential carries no accessKeyId",
		});
		expect(t.row.error).toContain("carries no accessKeyId");
		// Re-running cannot conjure a secret; the claim holds so the sweep
		// does not spin a vault-resolve + Bitmovin LIST every tick.
		expect(t.row.contentClaimedAt).not.toBeNull();
		expect(t.sdk.createS3Input).not.toHaveBeenCalled();
	});

	it("an Azure credential with no accountName is a NAMED refusal that keeps the claim", async () => {
		const t = makeDeps({
			provider: "AZURE_BLOB",
			config: {},
			secret: { accountKey: "k" },
		});
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result).toEqual({
			outcome: "FAILED",
			reason: "Azure credential carries no accountName",
		});
		expect(t.row.error).toContain("accountName");
		// Deterministic refusal: the claim HOLDS so the sweep does not spin.
		expect(t.row.contentClaimedAt).not.toBeNull();
	});

	it("a row that stopped being ARMED mid-flight is left alone", async () => {
		const t = makeDeps({ row: { status: "CANCELED" } });
		const result = await registerSlateContent(t.deps, ARGS);
		expect(result.outcome).toBe("SKIPPED");
		expect(t.row.insertableContentId).toBeNull();
	});
});

describe("slate ↔ live-stream compatibility (ledger #239)", () => {
	/**
	 * What the encoder is ingesting, as the run recorded it. Bitmovin's own
	 * `InsertableContent` contract: the clip's video stream at position 0 must
	 * match "the codec, resolution and framerate of the livestream", and the
	 * audio streams must match in number, channels and sample rate.
	 */
	const INGEST_MEDIA = {
		video: {
			codec: "h264",
			width: 1920,
			height: 1080,
			frameRate: 30000 / 1001,
			frameRateText: "30000/1001",
			pixelFormat: "yuv420p",
		},
		audio: [{ codec: "aac", sampleRate: 48000, channels: 2 }],
	};

	const matchingProbe = {
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				pix_fmt: "yuv420p",
				width: 1920,
				height: 1080,
				r_frame_rate: "30000/1001",
			},
			{
				codec_type: "audio",
				codec_name: "aac",
				sample_rate: "48000",
				channels: 2,
			},
		],
	};

	const mismatchedProbe = {
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				pix_fmt: "yuv420p",
				width: 1280,
				height: 720,
				r_frame_rate: "25/1",
			},
			{
				codec_type: "audio",
				codec_name: "aac",
				sample_rate: "48000",
				channels: 2,
			},
		],
	};

	it("refuses a clip the encoder could not play, before anything is created", async () => {
		const { deps, sdk, row } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				ingestMedia: INGEST_MEDIA,
				probeSlateSource: vi.fn(async () => mismatchedProbe),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("FAILED");
		// : stored STRUCTURED — the safety sentence localizes at render
		// (schedule panel); the diff rides in the `differences` param, one line
		// per attribute. Asserting on the CODE is what makes this mutation-proof:
		// reverting the writer to the English sentence (which also contains the
		// diff text) would still pass a raw `toContain`, but not `code`.
		const parsed = parseFeederError(String(row.error ?? ""));
		expect(parsed?.code).toBe("slateMismatch");
		expect(parsed?.differences).toContainEqual({
			attribute: "resolution",
			reference: "1920×1080",
			candidate: "1280×720",
			blocking: true,
		});
		expect(parsed?.differences).toContainEqual({
			attribute: "frame rate",
			reference: "30000/1001",
			candidate: "25/1",
			blocking: true,
		});
		expect(parsed?.params.differences).toContain(
			"resolution 1920×1080 → 1280×720",
		);
		// Nothing may be left behind at the provider: the refusal happens
		// before the input and before the content.
		expect(sdk.createS3Input).not.toHaveBeenCalled();
		expect(sdk.createLiveInsertableContent).not.toHaveBeenCalled();
		// The claim is KEPT — retrying cannot make a 25 fps clip 29.97.
		expect(row.contentClaimedAt).not.toBeNull();
	});

	it("registers a matching clip exactly as before", async () => {
		const { deps, row } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				ingestMedia: INGEST_MEDIA,
				probeSlateSource: vi.fn(async () => matchingProbe),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result).toEqual({
			outcome: "REGISTERED",
			insertableContentId: "content-1",
		});
		expect(row.insertableContentId).toBe("content-1");
	});

	it("C36 (pre-#330 path): the 2026-09-02 clip is refused on frame rate, sample rate and — since row #330 — its MKV container", async () => {
		// AWOLNATION_muxed.mkv against a 30 fps / 48 kHz ingest. The WP-0 A/B
		// showed the same attributes in an MP4 failing identically; the
		// 2026-09-13 runs then showed a MATCHING MKV silently never airs, so
		// the container is now a blocking difference of its own.
		const { deps, sdk, row } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				ingestMedia: {
					video: { width: 1280, height: 720, frameRate: 30 },
					audio: [{ sampleRate: 48000, channels: 2 }],
				},
				probeSlateSource: vi.fn(async () => ({
					format: { format_name: "matroska,webm" },
					streams: [
						{
							codec_type: "video",
							codec_name: "h264",
							width: 1280,
							height: 720,
							r_frame_rate: "24000/1001",
						},
						{
							codec_type: "audio",
							codec_name: "aac",
							sample_rate: "44100",
							channels: 2,
						},
					],
				})),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("FAILED");
		const parsed = parseFeederError(String(row.error ?? ""));
		expect(parsed?.code).toBe("slateMismatch");
		expect(parsed?.differences).toEqual([
			{
				attribute: "frame rate",
				reference: "30",
				candidate: "24000/1001",
				blocking: true,
			},
			{
				attribute: "audio sample rate",
				reference: "48000 Hz",
				candidate: "44100 Hz",
				blocking: true,
			},
			{
				attribute: "container",
				reference: "mp4/mpegts",
				candidate: "matroska",
				blocking: true,
			},
		]);
		expect(sdk.createLiveInsertableContent).not.toHaveBeenCalled();
	});

	it("C36: a leading slash on the source key never reaches the provider", async () => {
		const { deps, sdk } = makeDeps({});
		const result = await registerSlateContent(deps, {
			scheduleId: SCHEDULE_ID,
			source: { ...SOURCE, key: "/slates/brb.mp4" },
			encodingId: ENCODING_ID,
		});
		expect(result.outcome).toBe("REGISTERED");
		expect(sdk.createLiveInsertableContent).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({
				inputs: [{ inputId: "input-1", inputPath: "slates/brb.mp4" }],
			}),
		);
	});

	it("enforces Bitmovin's 'video stream at stream position 0' by layout", async () => {
		const { deps, row, sdk } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				ingestMedia: INGEST_MEDIA,
				// An audio-first mezzanine: every attribute matches, the LAYOUT
				// does not. Bitmovin's contract is positional for this one thing.
				probeSlateSource: vi.fn(async () => ({
					streams: [
						...(matchingProbe.streams ?? []).slice(1),
						...(matchingProbe.streams ?? []).slice(0, 1),
					],
				})),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("FAILED");
		// : structured — the "video stream at stream position 0" sentence
		// localizes at render; `found` names what sits there instead (audio).
		const parsed = parseFeederError(String(row.error ?? ""));
		expect(parsed?.code).toBe("slatePosition");
		expect(parsed?.params.found).toBe("audio");
		expect(sdk.createLiveInsertableContent).not.toHaveBeenCalled();
	});

	it("has no opinion when the run has no reference to compare against — and says so on the row", async () => {
		// External ingest that has never reported a heartbeat: registration
		// behaves exactly as it did before the check existed, and the row's
		// note carries the stood-down check so a later insert failure can be
		// connected to it (`preflightUnverifiedReason`).
		const probeSlateSource = vi.fn(async () => mismatchedProbe);
		const { deps, row } = makeDeps({});
		const result = await registerSlateContent(
			{ ...deps, ingestMedia: null, probeSlateSource },
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("REGISTERED");
		// Not even probed — there is nothing the measurement could answer.
		expect(probeSlateSource).not.toHaveBeenCalled();
		expect(row.note).toBe(
			"slate content registered (content-1); preflight UNVERIFIED (no ingest reference)",
		);
		expect(preflightUnverifiedReason(row.note)).toBe("no ingest reference");
	});

	it("has no opinion when the clip cannot be probed — and says so on the row", async () => {
		// An unsupported provider, a range-ignoring endpoint, a non-faststart
		// clip past the bounded window: "not measured" is never "bad".
		const { deps, row } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				ingestMedia: INGEST_MEDIA,
				probeSlateSource: vi.fn(async () => null),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("REGISTERED");
		expect(preflightUnverifiedReason(row.note)).toBe(
			"clip could not be probed",
		);
	});

	it("a verified clip leaves no stand-down marker on the row", async () => {
		const { deps, row } = makeDeps({});
		await registerSlateContent(
			{
				...deps,
				ingestMedia: INGEST_MEDIA,
				probeSlateSource: vi.fn(async () => matchingProbe),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		// rev406 R1: an OK names its scope — what the reference could compare
		// and what it could not — so it never reads as "everything matched".
		expect(row.note).toBe(
			"slate content registered (content-1); preflight OK on video stream position, video stream, video codec, resolution, frame rate, pixel format, audio streams, audio codec, audio sample rate, audio channels; not comparable: H.264 profile, H.264 level",
		);
		expect(preflightUnverifiedReason(row.note)).toBeNull();
	});

	it("C36: a still image is admitted (row #329) and registers like a movie", async () => {
		const { deps, sdk, row } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				ingestMedia: INGEST_MEDIA,
				probeSlateSource: vi.fn(async () => ({
					format: { format_name: "png_pipe" },
					streams: [
						{
							codec_type: "video",
							codec_name: "png",
							width: 1920,
							height: 1080,
							r_frame_rate: "25/1",
						},
					],
				})),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("REGISTERED");
		expect(sdk.createLiveInsertableContent).toHaveBeenCalled();
		expect(parseFeederError(String(row.error ?? ""))?.code).toBeUndefined();
	});

	it("preflightUnverifiedReason reads the marker and nothing else", () => {
		expect(
			preflightUnverifiedReason(
				"preflight UNVERIFIED (NO_CREDENTIAL): no vaulted storage credential can read in/x.mp4",
			),
		).toBe("NO_CREDENTIAL");
		expect(preflightUnverifiedReason("preflight UNVERIFIED")).toBe(
			"reason not recorded",
		);
		expect(preflightUnverifiedReason("a brb slate")).toBeNull();
		expect(preflightUnverifiedReason(null)).toBeNull();
		expect(preflightUnverifiedReason(undefined)).toBeNull();
	});

	it("skips the check for content a previous attempt already registered", async () => {
		// Adopt-by-name is a RESUME: that attempt passed this gate, and
		// re-probing would cost a download per redelivery.
		const probeSlateSource = vi.fn(async () => mismatchedProbe);
		const { deps, row } = makeDeps({
			existing: [
				{
					id: "content-9",
					name: slateContentName(SCHEDULE_ID),
					status: "READY",
				},
			],
		});
		const result = await registerSlateContent(
			{ ...deps, ingestMedia: INGEST_MEDIA, probeSlateSource },
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result).toEqual({
			outcome: "REGISTERED",
			insertableContentId: "content-9",
		});
		expect(probeSlateSource).not.toHaveBeenCalled();
		expect(row.insertableContentId).toBe("content-9");
	});
});

describe("row #330: the preparer replaces the refuse-on-mismatch check", () => {
	it("registers the NORMALIZED key and writes what was done onto the row", async () => {
		const { deps, sdk, row } = makeDeps({});
		const prepareSlate = vi.fn(async () => ({
			kind: "READY" as const,
			source: {
				...SOURCE,
				key: "slates/brb.normalized-1280x720-30-48000-2ch.ts",
			},
			normalized: true,
			target: null,
			note: "converted to MPEG-TS 1280x720 30 fps (container)",
		}));
		const result = await registerSlateContent(
			{ ...deps, prepareSlate },
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("REGISTERED");
		expect(prepareSlate).toHaveBeenCalledWith({
			label: SCHEDULE_ID,
			source: SOURCE,
			ingest: null,
			destination: null,
		});
		expect(sdk.createLiveInsertableContent).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({
				inputs: [
					{
						inputId: "input-1",
						inputPath: "slates/brb.normalized-1280x720-30-48000-2ch.ts",
					},
				],
			}),
		);
		expect(row.note).toBe(
			"slate content registered (content-1); converted to MPEG-TS 1280x720 30 fps (container)",
		);
	});

	it("registers from the DESTINATION the preparer returns — its credential, bucket and key — not the source's", async () => {
		const { deps, sdk } = makeDeps({});
		const DEST_CRED = "4c885bd1-33ef-47b0-9506-3b765f91f324";
		const DEST_KEY =
			"chan-1/slates/in/slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts";
		const result = await registerSlateContent(
			{
				...deps,
				prepareSlate: vi.fn(async () => ({
					kind: "READY" as const,
					source: {
						credentialId: DEST_CRED,
						bucket: "channel-output",
						key: DEST_KEY,
					},
					normalized: true,
					target: null,
					note: "converted → channel-output/…",
				})),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("REGISTERED");
		expect(deps.resolveCredential).toHaveBeenCalledWith(DEST_CRED);
		expect(sdk.createS3Input).toHaveBeenCalledWith(
			expect.objectContaining({ bucketName: "channel-output" }),
		);
		expect(sdk.createLiveInsertableContent).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({
				inputs: [{ inputId: "input-1", inputPath: DEST_KEY }],
			}),
		);
	});

	it("WAIT releases the claim so the next sweep tick retries, and creates nothing", async () => {
		const { deps, sdk, row } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				prepareSlate: vi.fn(async () => ({
					kind: "WAIT" as const,
					note: "waiting for the live input (ingest reference not known yet)",
				})),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("RELEASED");
		expect(row.contentClaimedAt).toBeNull();
		expect(row.note).toContain("waiting for the live input");
		expect(sdk.createS3Input).not.toHaveBeenCalled();
		expect(sdk.createLiveInsertableContent).not.toHaveBeenCalled();
	});

	it("REFUSED keeps the claim and writes the reason as the row's error", async () => {
		const { deps, sdk, row } = makeDeps({});
		const result = await registerSlateContent(
			{
				...deps,
				prepareSlate: vi.fn(async () => ({
					kind: "REFUSED" as const,
					reason: "the file carries no video stream",
				})),
			},
			{ scheduleId: SCHEDULE_ID, source: SOURCE, encodingId: ENCODING_ID },
		);
		expect(result.outcome).toBe("FAILED");
		expect(row.error).toBe(
			"slate cannot be prepared: the file carries no video stream",
		);
		expect(row.contentClaimedAt).not.toBeNull();
		expect(sdk.createLiveInsertableContent).not.toHaveBeenCalled();
	});
});
