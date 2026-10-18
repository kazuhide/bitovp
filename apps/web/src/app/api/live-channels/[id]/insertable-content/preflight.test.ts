import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { messagesFor, translate } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";

/**
 * C36 / WP-A2 — the direct registration path is PREFLIGHTED.
 *
 * Measured 2026-09-02 (channel 0645c2f1): `POST …/insertable-content` took a
 * 23.976 fps / 44.1 kHz clip against a 30 fps / 48 kHz ingest, Bitmovin said
 * READY one second later, and both scheduled insertions reached provider
 * ERROR 21 s after scheduling. Every arm below asserts what the route does
 * BEFORE anything is created at the provider.
 */

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();
const channelFindUnique = vi.fn();
const runFindFirst = vi.fn();
const inspectionFindFirst = vi.fn();
const inspectionCreate = vi.fn();
const inspectionUpdate = vi.fn();
const credentialGet = vi.fn();
const credentialList = vi.fn();
const revealSecret = vi.fn();
const queueAdd = vi.fn();
const listObjects = vi.fn();

const contentCreate = vi.fn();
const normalizationCreate = vi.fn();
const normalizationUpdate = vi.fn();
const normalizeQueueAdd = vi.fn();
const s3InputCreate = vi.fn();
const inputTypeGet = vi.fn();
const genericS3Get = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
		prisma: {
			liveChannel: { findUnique: channelFindUnique },
			liveChannelRun: { findFirst: runFindFirst },
			storageInspection: {
				findFirst: inspectionFindFirst,
				create: inspectionCreate,
				update: inspectionUpdate,
			},
			slateNormalization: {
				create: normalizationCreate,
				update: normalizationUpdate,
			},
		},
		credentials: {
			get: credentialGet,
			list: credentialList,
			revealSecret,
		},
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock("@/lib/server/queue", () => ({
	getStorageInspectQueue: () => ({ add: queueAdd }),
	getSlateNormalizeQueue: () => ({ add: normalizeQueueAdd }),
}));

vi.mock("@/lib/server/storage", () => ({
	browserForCredentialId: async () => ({
		listObjects,
		dispose: () => {},
	}),
}));

vi.mock("@bitmovin/api-sdk", () => {
	class Resource {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	}
	return {
		default: class MockBitmovinApi {
			encoding = {
				encodings: {
					live: {
						insertableContent: { create: contentCreate, list: vi.fn() },
					},
				},
				inputs: {
					type: { get: inputTypeGet },
					s3: { create: s3InputCreate, get: vi.fn() },
					genericS3: { create: vi.fn(), get: genericS3Get },
					gcs: { create: vi.fn(), get: vi.fn() },
					azure: { create: vi.fn(), get: vi.fn() },
				},
			};
		},
		InsertableContent: Resource,
		InsertableContentInput: Resource,
		S3Input: Resource,
		GenericS3Input: Resource,
		GcsInput: Resource,
		AzureInput: Resource,
		S3SignatureVersion: { V2: "S3_V2", V4: "S3_V4" },
	};
});

import { POST as PREFLIGHT } from "./preflight/route";
import { POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
const INPUT_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000c1";
const INSPECTION_ID = "00000000-0000-4000-8000-0000000000f1";
const NORMALIZATION_ID = "00000000-0000-4000-8000-0000000000n1".replace(
	"n",
	"a",
);

const params = { params: Promise.resolve({ id: CHANNEL_ID }) };
const SOURCE = {
	credentialId: CREDENTIAL_ID,
	bucket: "in",
	key: "slates/brb.mkv",
};

/** The 2026-09-02 ingest: 1280×720 @ 30 fps, AAC 48 kHz stereo. */
const INGEST_MEDIA = {
	video: { codec: "h264", width: 1280, height: 720, frameRate: 30 },
	audio: [{ codec: "aac", sampleRate: 48000, channels: 2 }],
};

/** AWOLNATION_muxed.mkv as ffprobe reported it. */
const MISMATCHED_PROBE = {
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
};

const MATCHING_PROBE = {
	format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			width: 1280,
			height: 720,
			r_frame_rate: "30/1",
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			sample_rate: "48000",
			channels: 2,
		},
	],
};

/** : the same clip as MPEG-TS — registers inline, as it is. */
const MATCHING_TS_PROBE = {
	...MATCHING_PROBE,
	format: { format_name: "mpegts" },
};

function inspection(
	status: string,
	probe: unknown = null,
	error: string | null = null,
) {
	return {
		id: INSPECTION_ID,
		status,
		bucket: SOURCE.bucket,
		objectKey: SOURCE.key,
		probe,
		bytesRead: probe ? 1024 : null,
		error,
		createdAt: new Date("2026-09-02T13:00:00Z"),
		updatedAt: new Date("2026-09-02T13:00:05Z"),
	};
}

function post(body: unknown, handler = POST) {
	return handler(
		new Request("http://test/insertable-content", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		params,
	);
}

const tFor = (locale: "en" | "ja"): Translator => {
	const messages = messagesFor(locale);
	return (key, values) => translate(messages, key, values);
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
	channelFindUnique.mockResolvedValue({
		status: "RUNNING",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
		lastHeartbeat: null,
		runs: [{ lastHeartbeat: null }],
	});
	runFindFirst.mockResolvedValue({
		ingestMedia: INGEST_MEDIA,
		lastHeartbeat: null,
	});
	credentialGet.mockResolvedValue({
		id: CREDENTIAL_ID,
		provider: "AWS_S3",
		label: "in",
		config: { region: "ap-northeast-1" },
	});
	credentialList.mockResolvedValue([
		{ id: CREDENTIAL_ID, provider: "AWS_S3", label: "in" },
	]);
	revealSecret.mockResolvedValue(
		JSON.stringify({
			accessKeyId: "AKIAFAKE",
			secretAccessKey: "fake-secret-value",
		}),
	);
	inspectionCreate.mockResolvedValue({ id: INSPECTION_ID });
	queueAdd.mockResolvedValue(undefined);
	s3InputCreate.mockResolvedValue({ id: INPUT_ID });
	contentCreate.mockResolvedValue({
		id: "content-1",
		name: "slate",
		status: "CREATED",
	});
	normalizationCreate.mockImplementation(
		async (args: { data: Record<string, unknown> }) => ({
			id: NORMALIZATION_ID,
			...args.data,
			target: null,
			error: null,
			registeredKey: null,
			normalized: false,
			insertableContentId: null,
			createdAt: new Date("2026-09-13T12:00:00Z"),
			updatedAt: new Date("2026-09-13T12:00:00Z"),
		}),
	);
	normalizeQueueAdd.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/live-channels/[id]/insertable-content — the C36 preflight", () => {
	it("row #330: the measured 2026-09-02 MKV is no longer refused — it is queued for conversion (202) before any input or content exists", async () => {
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MISMATCHED_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { name: "slate", source: SOURCE },
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			normalization: { id: string; status: string; note: string };
			preflight: {
				verdict: string;
				preparation: { action: string; reasons: string[] };
				conversionDestination?: {
					bucket: string;
					keyPrefix: string;
					sameAsSource: boolean;
				};
				probe?: unknown;
			};
		};
		expect(body.normalization).toMatchObject({
			id: NORMALIZATION_ID,
			status: "QUEUED",
		});
		// The row's reference to the key material never reaches the client.
		const raw = JSON.stringify(body.normalization);
		expect(raw).not.toContain(CREDENTIAL_ID);
		expect(raw).not.toContain("liveChannelId");
		expect(raw).not.toContain("bitmovinAccountId");
		expect(body.normalization.note).toContain("converted to MPEG-TS");
		expect(body.preflight.verdict).toBe("INCOMPATIBLE");
		expect(body.preflight.preparation.action).toBe("NORMALIZE");
		// No S3 output in this fixture's plan → next to the source, said so.
		expect(body.preflight.conversionDestination).toEqual({
			bucket: "in",
			keyPrefix: "slates",
			sameAsSource: true,
		});
		expect(body.normalization.note).toContain("→ in/slates");
		expect(body.preflight.preparation.reasons).toEqual([
			"container",
			"frame rate",
			"audio sample rate",
		]);
		expect(body.preflight.probe).toBeUndefined();
		expect(normalizationCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				bitmovinAccountId: ACCOUNT_ID,
				name: "slate",
				credentialId: CREDENTIAL_ID,
				bucket: "in",
				sourceKey: "slates/brb.mkv",
				status: "QUEUED",
			}),
		});
		expect(normalizeQueueAdd).toHaveBeenCalledWith(
			"slate-normalize",
			{ slateNormalizationId: NORMALIZATION_ID },
			expect.objectContaining({ attempts: 1 }),
		);
		expect(s3InputCreate).not.toHaveBeenCalled();
		expect(contentCreate).not.toHaveBeenCalled();
		expect(writeAuditLog).not.toHaveBeenCalled();
	});
	it("the raw inputs shape keeps the 422, and it renders as catalogue copy in both locales, never the route's prose", async () => {
		inputTypeGet.mockResolvedValue({ type: "GENERIC_S3" });
		genericS3Get.mockResolvedValue({ bucketName: "in" });
		listObjects.mockResolvedValue({ objects: [{ key: "slates/brb.mkv" }] });
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MISMATCHED_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { inputs: [{ inputId: INPUT_ID, inputPath: "slates/brb.mkv" }] },
		});
		expect(res.status).toBe(422);
		const body = await res.json();
		const error = new ApiError(422, body.error, body.details);
		expect(localizedCustomerError(tFor("en"), error, "common.unknown")).toBe(
			tFor("en")("customerError.slateIncompatible"),
		);
		expect(localizedCustomerError(tFor("ja"), error, "common.unknown")).toBe(
			tFor("ja")("customerError.slateIncompatible"),
		);
	});
	it("admits a still image: registers it as kind image with no attribute refusal (row #329)", async () => {
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", {
				format: { format_name: "png_pipe" },
				streams: [
					{ codec_type: "video", codec_name: "png", width: 1920, height: 1080 },
				],
			}),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { name: "brb", source: { ...SOURCE, key: "slates/brb.png" } },
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			preflight: { verdict: string; kind?: string; differences?: unknown[] };
		};
		expect(body.preflight.verdict).toBe("OK");
		expect(body.preflight.kind).toBe("image");
		expect(body.preflight.differences ?? []).toEqual([]);
		expect(contentCreate).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({
				inputs: [expect.objectContaining({ inputPath: "slates/brb.png" })],
			}),
		);
	});

	it("starts an inspection and answers 409 SLATE_UNINSPECTED when the object has never been probed", async () => {
		inspectionFindFirst.mockResolvedValue(null);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			details: { code: string; inspectionId: string };
		};
		expect(body.details.code).toBe("SLATE_UNINSPECTED");
		expect(body.details.inspectionId).toBe(INSPECTION_ID);
		expect(inspectionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					credentialId: CREDENTIAL_ID,
					bucket: "in",
					objectKey: "slates/brb.mkv",
					status: "PENDING",
				}),
			}),
		);
		expect(queueAdd).toHaveBeenCalledWith(
			"storage-inspect",
			{ storageInspectionId: INSPECTION_ID },
			expect.objectContaining({ jobId: INSPECTION_ID }),
		);
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("does not start a second inspection while one is running", async () => {
		inspectionFindFirst.mockResolvedValue(inspection("RUNNING"));
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(409);
		expect(inspectionCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("row #330: a movie with no ingest reference is parked WAITING_FOR_INPUT (202) and nothing is queued or created", async () => {
		runFindFirst.mockResolvedValue({ ingestMedia: null, lastHeartbeat: null });
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MATCHING_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { name: "slate", source: SOURCE },
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			normalization: { status: string; note: string };
			preflight: {
				verdict: string;
				standDown: string;
				preparation: { action: string; missing: string[] };
			};
		};
		expect(body.normalization.status).toBe("WAITING_FOR_INPUT");
		expect(body.normalization.note).toContain("waiting for the live input");
		expect(JSON.stringify(body.normalization)).not.toContain(CREDENTIAL_ID);
		expect(body.preflight.verdict).toBe("UNVERIFIED");
		expect(body.preflight.standDown).toBe("NO_INGEST_REFERENCE");
		expect(body.preflight.preparation).toEqual({
			action: "WAIT_FOR_INPUT",
			missing: ["ingest reference"],
		});
		expect(normalizationCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({ status: "WAITING_FOR_INPUT" }),
		});
		expect(normalizeQueueAdd).not.toHaveBeenCalled();
		expect(contentCreate).not.toHaveBeenCalled();
	});
	it("row #330 follow-up: a plan with an S3 output names it as the conversion destination", async () => {
		channelFindUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
			lastHeartbeat: null,
			runs: [{ lastHeartbeat: null }],
			plan: {
				outputs: [
					{
						key: "archive-s3",
						kind: "S3",
						credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
						bucket: "channel-output",
					},
				],
				muxings: [
					{ destination: { outputKey: "archive-s3", path: "chan-1/archive" } },
				],
				liveManifests: [],
			},
		});
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MISMATCHED_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			normalization: { note: string };
			preflight: { conversionDestination: unknown };
		};
		expect(body.preflight.conversionDestination).toEqual({
			bucket: "channel-output",
			keyPrefix: "chan-1/archive/slates",
			sameAsSource: false,
		});
		expect(JSON.stringify(body)).not.toContain(
			"4c885bd1-33ef-47b0-9506-3b765f91f324",
		);
		expect(body.normalization.note).toContain(
			"→ channel-output/chan-1/archive/slates",
		);
	});

	it("row #330: the row is created BEFORE the enqueue, and an enqueue failure marks it ERROR and surfaces", async () => {
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MISMATCHED_PROBE),
		);
		normalizeQueueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(500);
		expect(normalizationCreate).toHaveBeenCalledTimes(1);
		expect(
			normalizationCreate.mock.invocationCallOrder[0] as number,
		).toBeLessThan(normalizeQueueAdd.mock.invocationCallOrder[0] as number);
		expect(normalizationUpdate).toHaveBeenCalledWith({
			where: { id: NORMALIZATION_ID },
			data: {
				status: "ERROR",
				error: expect.stringContaining("Enqueue failed"),
			},
		});
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("row #330: a picked file whose inspection ERRORED is refused (422), never registered unprobed", async () => {
		inspectionFindFirst.mockResolvedValue(
			inspection("ERROR", null, "read timed out"),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as {
			error: string;
			details: { code: string };
		};
		expect(body.details.code).toBe("SLATE_INCOMPATIBLE");
		expect(body.error).toContain("inspection failed");
		expect(normalizationCreate).not.toHaveBeenCalled();
		expect(normalizeQueueAdd).not.toHaveBeenCalled();
		expect(s3InputCreate).not.toHaveBeenCalled();
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("a caller-supplied description is kept as theirs on an inline registration (a still, no reference)", async () => {
		runFindFirst.mockResolvedValue({ ingestMedia: null, lastHeartbeat: null });
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", {
				format: { format_name: "png_pipe" },
				streams: [
					{ codec_type: "video", codec_name: "png", width: 1280, height: 720 },
				],
			}),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: {
				description: "operator note",
				source: { ...SOURCE, key: "slates/brb.png" },
			},
		});
		expect(res.status).toBe(201);
		expect(contentCreate).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({ description: "operator note" }),
		);
	});
	it("a verified inline registration (matching MPEG-TS) stamps no description", async () => {
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MATCHING_TS_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(201);
		// rev406 R1: an OK names its scope. This fixture's reference is
		// ffprobe-derived (channels known), so only profile/level/pixel format
		// are not comparable.
		const body = (await res.json()) as {
			preflight: { summary: string; preparation: { action: string } };
		};
		expect(body.preflight.summary).toBe(
			"OK: matches the live ingest on media kind, video stream position, video stream, video codec, resolution, frame rate, audio streams, audio codec, audio sample rate, audio channels, container; not comparable: H.264 profile, H.264 level, pixel format",
		);
		expect(body.preflight.preparation).toEqual({
			action: "REGISTER_AS_IS",
			reason: "MATCHES_INGEST",
		});
		const created = contentCreate.mock.calls[0]?.[1] as {
			description?: unknown;
		};
		expect(created.description).toBeUndefined();
	});
	it("a matching MPEG-TS is registered inline: the input is minted from the credential, the content names it, and no secret reaches the audit", async () => {
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MATCHING_TS_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { name: "slate", source: { ...SOURCE, key: "/slates/brb.mp4" } },
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			preflight: {
				verdict: string;
				inputPath: { path: string; original: string; stripped: boolean };
			};
		};
		expect(body.preflight.verdict).toBe("OK");
		expect(body.preflight.inputPath).toEqual({
			path: "slates/brb.mp4",
			original: "/slates/brb.mp4",
			stripped: true,
		});
		expect(s3InputCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				bucketName: "in",
				accessKey: "AKIAFAKE",
				secretKey: "fake-secret-value",
			}),
		);
		expect(contentCreate).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({
				name: "slate",
				inputs: [
					expect.objectContaining({
						inputId: INPUT_ID,
						inputPath: "slates/brb.mp4",
					}),
				],
			}),
		);
		const audit = JSON.stringify(writeAuditLog.mock.calls);
		expect(audit).toContain("/encoding/inputs/s3");
		expect(audit).toContain(
			`/encoding/encodings/${ENCODING_ID}/live/insertable-content`,
		);
		expect(audit).not.toContain("fake-secret-value");
		expect(audit).not.toContain("AKIAFAKE");
	});

	/**
	 * rev406 R1 — the reviewer's probe: 72 of 116 runs (all of the measured
	 * channel's) have no recorded ingestMedia, so the reference is the
	 * heartbeat, whose audio stream carries the sample rate as `rate`. Before
	 * the fix this arm answered 201 "OK: matches the live ingest".
	 */
	const HEARTBEAT_ONLY_RUN = {
		ingestMedia: null,
		lastHeartbeat: {
			at: "2026-09-02T13:40:00.000Z",
			raw: {
				ingest: {
					streams: [
						{
							mediaType: "video",
							codec: "h264",
							width: 1280,
							height: 720,
							rate: 30,
						},
						{
							mediaType: "audio",
							codec: "aac",
							rate: 48000,
							numberOfAudioChannels: null,
						},
					],
				},
			},
		},
	};

	it("on a heartbeat-only reference, a 30 fps / 44.1 kHz MP4 is queued for conversion, naming the sample rate and the container", async () => {
		runFindFirst.mockResolvedValue(HEARTBEAT_ONLY_RUN);
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", {
				...MATCHING_PROBE,
				streams: [
					MATCHING_PROBE.streams[0],
					{
						codec_type: "audio",
						codec_name: "aac",
						sample_rate: "44100",
						channels: 2,
					},
				],
			}),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			preflight: { preparation: { action: string; reasons: string[] } };
		};
		expect(body.preflight.preparation).toEqual({
			action: "NORMALIZE",
			target: {
				width: 1280,
				height: 720,
				frameRate: 30,
				sampleRate: 48000,
				channels: 2,
				channelsAssumed: true,
			},
			reasons: ["container", "audio sample rate"],
		});
		expect(contentCreate).not.toHaveBeenCalled();
	});
	it("on a heartbeat-only reference, the MKV arm is queued with frame rate, sample rate and the container as the conversion's reasons", async () => {
		runFindFirst.mockResolvedValue(HEARTBEAT_ONLY_RUN);
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MISMATCHED_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			preflight: {
				differences: { attribute: string; blocking: boolean }[];
				preparation: { action: string; reasons: string[] };
			};
		};
		expect(body.preflight.differences.map((d) => d.attribute)).toEqual([
			"frame rate",
			"audio sample rate",
			"container",
		]);
		expect(body.preflight.preparation.reasons).toEqual([
			"container",
			"frame rate",
			"audio sample rate",
		]);
	});
	it("on a heartbeat-only reference, an OK names what was compared and what could not be", async () => {
		runFindFirst.mockResolvedValue(HEARTBEAT_ONLY_RUN);
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MATCHING_TS_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { source: SOURCE },
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			preflight: {
				summary: string;
				compared: string[];
				notComparable: string[];
			};
		};
		expect(body.preflight.compared).toContain("audio sample rate");
		expect(body.preflight.notComparable).toEqual([
			"H.264 profile",
			"H.264 level",
			"pixel format",
			"audio channels",
		]);
		expect(body.preflight.summary).toMatch(
			/^OK: matches the live ingest on .*audio sample rate.*; not comparable: H\.264 profile, H\.264 level, pixel format, audio channels$/,
		);
	});

	it("legacy shape: resolves the input's bucket, finds the credential that can read the key, and refuses a mismatch", async () => {
		inputTypeGet.mockResolvedValue({ type: "GENERIC_S3" });
		genericS3Get.mockResolvedValue({ bucketName: "in" });
		listObjects.mockResolvedValue({
			prefixes: [],
			objects: [{ key: "input/AWOLNATION_muxed.mkv", size: 1 }],
		});
		inspectionFindFirst.mockResolvedValue(
			inspection("FINISHED", MISMATCHED_PROBE),
		);
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: {
				inputs: [
					{ inputId: INPUT_ID, inputPath: "/input/AWOLNATION_muxed.mkv" },
				],
			},
		});
		expect(res.status).toBe(422);
		// The leading slash was stripped before the lookup and the probe search.
		expect(listObjects).toHaveBeenCalledWith({
			bucket: "in",
			prefix: "input/AWOLNATION_muxed.mkv",
			limit: 1,
		});
		expect(inspectionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					credentialId: CREDENTIAL_ID,
					bucket: "in",
					objectKey: "input/AWOLNATION_muxed.mkv",
				},
			}),
		);
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("legacy shape: no credential can read the bucket → UNVERIFIED NO_CREDENTIAL, registered with the normalised path", async () => {
		inputTypeGet.mockResolvedValue({ type: "GENERIC_S3" });
		genericS3Get.mockResolvedValue({ bucketName: "elsewhere" });
		listObjects.mockResolvedValue({ prefixes: [], objects: [] });
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: {
				inputs: [{ inputId: INPUT_ID, inputPath: "/slates/brb.mp4" }],
			},
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			preflight: { verdict: string; standDown: string };
		};
		expect(body.preflight).toMatchObject({
			verdict: "UNVERIFIED",
			standDown: "NO_CREDENTIAL",
		});
		expect(inspectionCreate).not.toHaveBeenCalled();
		expect(contentCreate).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({
				inputs: [
					expect.objectContaining({
						inputId: INPUT_ID,
						inputPath: "slates/brb.mp4",
					}),
				],
			}),
		);
	});

	it("legacy shape: an ingest input has no bucket → UNVERIFIED INPUT_UNRESOLVED", async () => {
		inputTypeGet.mockResolvedValue({ type: "RTMP" });
		const res = await post({
			bitmovinAccountId: ACCOUNT_ID,
			content: { inputs: [{ inputId: INPUT_ID, inputPath: "live" }] },
		});
		expect(res.status).toBe(201);
		expect((await res.json()).preflight).toMatchObject({
			verdict: "UNVERIFIED",
			standDown: "INPUT_UNRESOLVED",
		});
		expect(listObjects).not.toHaveBeenCalled();
	});

	it("rejects a body carrying both shapes, or neither", async () => {
		for (const content of [
			{ source: SOURCE, inputs: [{ inputId: INPUT_ID, inputPath: "a.mp4" }] },
			{ name: "slate" },
		]) {
			const res = await post({ bitmovinAccountId: ACCOUNT_ID, content });
			expect(res.status).toBe(400);
		}
		expect(contentCreate).not.toHaveBeenCalled();
	});
});

describe("POST /api/live-channels/[id]/insertable-content/preflight", () => {
	it("answers 202 PENDING with the inspection it started, then 200 DONE with the verdict and the probe", async () => {
		inspectionFindFirst.mockResolvedValueOnce(null);
		const pending = await post(
			{ bitmovinAccountId: ACCOUNT_ID, source: SOURCE },
			PREFLIGHT,
		);
		expect(pending.status).toBe(202);
		expect(await pending.json()).toMatchObject({
			status: "PENDING",
			inspectionId: INSPECTION_ID,
			candidate: SOURCE,
		});
		expect(queueAdd).toHaveBeenCalledTimes(1);

		inspectionFindFirst.mockResolvedValueOnce(
			inspection("FINISHED", MISMATCHED_PROBE),
		);
		const done = await post(
			{ bitmovinAccountId: ACCOUNT_ID, source: SOURCE },
			PREFLIGHT,
		);
		expect(done.status).toBe(200);
		const body = (await done.json()) as {
			status: string;
			verdict: string;
			kind: string;
			container: string;
			differences: { attribute: string }[];
			probe: unknown;
		};
		expect(body.status).toBe("DONE");
		expect(body.verdict).toBe("INCOMPATIBLE");
		expect(body.kind).toBe("movie");
		expect(body.container).toBe("matroska");
		expect(body.differences.map((d) => d.attribute)).toEqual([
			"frame rate",
			"audio sample rate",
			"container",
		]);
		expect(body.probe).toEqual(MISMATCHED_PROBE);
		// A preflight never creates anything at the provider.
		expect(s3InputCreate).not.toHaveBeenCalled();
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("an errored inspection stands down INSPECTION_FAILED rather than re-probing forever", async () => {
		inspectionFindFirst.mockResolvedValue(
			inspection("ERROR", null, "no streams found within the bounded window"),
		);
		const res = await post(
			{ bitmovinAccountId: ACCOUNT_ID, source: SOURCE },
			PREFLIGHT,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			verdict: "UNVERIFIED",
			standDown: "INSPECTION_FAILED",
			note: expect.stringContaining("bounded window"),
		});
		expect(inspectionCreate).not.toHaveBeenCalled();
	});

	it("is RUNNING-gated like the registration it precedes", async () => {
		channelFindUnique.mockResolvedValue({
			status: "STOPPED",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
			lastHeartbeat: null,
			runs: [],
		});
		const res = await post(
			{ bitmovinAccountId: ACCOUNT_ID, source: SOURCE },
			PREFLIGHT,
		);
		expect(res.status).toBe(409);
		expect(inspectionFindFirst).not.toHaveBeenCalled();
	});
});
