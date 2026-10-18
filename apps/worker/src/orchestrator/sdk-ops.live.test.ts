import type { AuditEntry } from "@bitovp/db";

// The recorder relaxes `actor` : ops do not name it, make-sdk does.
type RecordedEntry = Omit<AuditEntry, "actor"> & { actor?: string | null };

import {
	AdInsertionSettings,
	CacheControlSettings,
	EsamSettings,
	H264VideoConfiguration,
	KantarWatermark,
	LiveDashManifest,
	LiveHlsManifest,
	PoisEndpointCredentials,
	ProgramDateTimeSettings,
	RtmpIngestPoint,
	SrtInput,
	StartLiveChannelEncodingRequest,
	StartLiveEncodingRequest,
	UpdateEncodingRtmpIngestPointRequest,
} from "@bitmovin/api-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Live facade tests against a stubbed BitmovinApi instance: the NAMED model
 * classes stay real (payload construction is the thing under test), only
 * the default-export client is replaced — no network. Pins the PR2 secret
 * rules: passphrase/password/decryptionKey NEVER reach audit snapshots;
 * streamKey rides them (redactSecrets masks it at persistence — ledger).
 */

const api = vi.hoisted(() => {
	const resource = () => vi.fn(async (..._args: unknown[]) => ({ id: "bm-1" }));
	return {
		rtmpList: vi.fn(async (_q?: unknown) => ({
			items: [{ id: "bm-rtmp-default", name: "Default" }],
		})),
		ingestList: vi.fn(async (_id?: string, _q?: unknown) => ({
			items: [{ id: "is-1", inputId: "bm-rtmp-default" }],
		})),
		redundantCreate: resource(),
		srtCreate: resource(),
		zixiCreate: resource(),
		hlsCreate: resource(),
		kantarCreate: resource(),
		liveStart: resource(),
		liveHdStart: resource(),
		rtmpPatch: resource(),
		encodingStatus: vi.fn(async (_id: string) => ({ status: "ERROR" })),
		h264Create: resource(),
		liveStop: resource(),
		liveRestart: resource(),
		liveGet: vi.fn(async (_id: string) => ({
			streamKey: "liveStreamKey",
			encoderIp: "203.0.113.7",
			application: "live",
		})),
		liveGetStartRequest: vi.fn(async (_id: string) => ({
			streamKey: "liveStreamKey",
			manifestGenerator: "V2",
		})),
		heartbeatGet: vi.fn(async (_id: string) => ({
			timestamp: new Date("2026-06-12T01:02:03.000Z"),
			ingest: { status: "CONNECTED", healthy: true, droppedPacketsVideo: 3 },
			events: [],
		})),
		resetTimeshiftCreate: resource(),
		scte35Create: resource(),
		akamaiMslCreate: resource(),
		contentList: vi.fn(async (_id?: string, _q?: unknown) => ({
			items: [] as { id: string; name?: string; status?: string }[],
		})),
		contentCreate: resource(),
		scheduledList: vi.fn(async (_id?: string, _q?: unknown) => ({
			items: [] as {
				id?: string;
				contentId?: string;
				status?: string;
				createdAt?: Date;
			}[],
		})),
	};
});

vi.mock("@bitmovin/api-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitmovin/api-sdk")>();
	class FakeBitmovinApi {
		encoding = {
			live: { encodings: { actions: { patch: api.rtmpPatch } } },
			configurations: { video: { h264: { create: api.h264Create } } },
			outputs: {
				akamaiMsl: { create: api.akamaiMslCreate },
			},
			inputs: {
				rtmp: { list: api.rtmpList },
				redundantRtmp: { create: api.redundantCreate },
				srt: { create: api.srtCreate },
				zixi: { create: api.zixiCreate },
				hls: { create: api.hlsCreate },
			},
			encodings: {
				status: api.encodingStatus,
				kantarWatermark: { create: api.kantarCreate },
				inputStreams: { ingest: { list: api.ingestList } },
				live: {
					start: api.liveStart,
					hd: { start: api.liveHdStart },
					stop: api.liveStop,
					restart: api.liveRestart,
					get: api.liveGet,
					getStartRequest: api.liveGetStartRequest,
					heartbeat: { get: api.heartbeatGet },
					resetLiveManifestTimeshift: { create: api.resetTimeshiftCreate },
					scte35Cue: { create: api.scte35Create },
					insertableContent: {
						list: api.contentList,
						create: api.contentCreate,
						scheduled: { list: api.scheduledList },
					},
				},
			},
		};
	}
	return { ...actual, default: FakeBitmovinApi };
});

import { createBitmovinSdkOps } from "./sdk-ops";

function setup() {
	const audits: RecordedEntry[] = [];
	const ops = createBitmovinSdkOps(
		{ apiKey: "test-key", tenantOrgId: null, bitmovinAccountId: "acct-1" },
		async (entry) => {
			audits.push(entry);
		},
	);
	return { ops, audits };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("live sdk-ops facade", () => {
	it("preserves explicit H264 width in the real SDK model and audit", async () => {
		const { ops, audits } = setup();
		await ops.createH264Config({ width: 1280, height: 720, rate: 30 });
		expect(api.h264Create.mock.calls[0]?.[0]).toBeInstanceOf(
			H264VideoConfiguration,
		);
		expect(api.h264Create.mock.calls[0]?.[0]).toMatchObject({
			width: 1280,
			height: 720,
			rate: 30,
		});
		expect(audits[0]?.request).toMatchObject({ width: 1280 });
	});

	it("retries HD 500/1004 only on the HD endpoint", async () => {
		vi.useFakeTimers();
		try {
			const { ops, audits } = setup();
			api.liveHdStart.mockRejectedValueOnce(
				Object.assign(new Error("settle window"), {
					httpStatusCode: 500,
					errorCode: 1004,
				}),
			);
			const pending = ops.startLiveEncoding("enc-1", {
				streamKey: "streamKey",
				encodingOption: "HD",
				dashManifests: [
					{
						manifestId: "dash-1",
						suggestedPresentationDelay: 6000,
						minimumUpdatePeriod: 2000,
					},
				],
			});
			await vi.runAllTimersAsync();
			await pending;
			expect(api.liveHdStart).toHaveBeenCalledTimes(2);
			for (const call of api.liveHdStart.mock.calls) {
				const request = call[1] as StartLiveEncodingRequest;
				expect(request.dashManifests?.[0]).toMatchObject({
					suggestedPresentationDelay: 6,
					minimumUpdatePeriod: 2,
				});
			}
			expect(audits[0]?.request).toMatchObject({
				dashManifests: [
					{ suggestedPresentationDelay: 6, minimumUpdatePeriod: 2 },
				],
			});
			expect(api.liveStart).not.toHaveBeenCalled();
			expect(audits[0]?.path).toBe("/encoding/encodings/enc-1/live/hd/start");
			expect(audits[0]?.response).toMatchObject({
				started: true,
				start1004Retries: 1,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconciles a lost HD response without sending another start", async () => {
		const { ops, audits } = setup();
		api.liveHdStart.mockRejectedValueOnce(new Error("connection lost"));
		api.encodingStatus.mockResolvedValueOnce({ status: "RUNNING" });
		await ops.startLiveEncoding("enc-1", {
			streamKey: "streamKey",
			encodingOption: "HD",
		});
		expect(api.liveHdStart).toHaveBeenCalledTimes(1);
		expect(api.liveStart).not.toHaveBeenCalled();
		expect(audits[0]?.response).toMatchObject({
			started: true,
			startReconciledFrom: "RUNNING",
		});
	});
	it("paginates the RTMP input list to exhaustion (C6)", async () => {
		const { ops } = setup();
		api.rtmpList
			.mockResolvedValueOnce({
				items: Array.from({ length: 100 }, (_, i) => ({
					id: `rtmp-${i}`,
					name: `RTMP ${i}`,
				})),
			})
			.mockResolvedValueOnce({ items: [{ id: "rtmp-100", name: "RTMP 100" }] });
		const inputs = await ops.listRtmpInputs();
		expect(inputs).toHaveLength(101);
		expect(api.rtmpList).toHaveBeenCalledTimes(2);
		expect(api.rtmpList).toHaveBeenNthCalledWith(1, { offset: 0, limit: 100 });
		expect(api.rtmpList).toHaveBeenNthCalledWith(2, {
			offset: 100,
			limit: 100,
		});
	});

	it("paginates SCHEDULED insertable content to exhaustion, and maps contentId/status/createdAt", async () => {
		/**
		 * The op the whole slate idempotency rests on, and it shipped with every
		 * property asserted in prose and verified by nothing (review-299 F3).
		 * Its own comment claims C6 (limit ≤ 100, paginate to exhaustion) and
		 * that "the second page is reachable on a long-running channel" — both
		 * were survivable mutations: raising the limit to 500 and truncating to
		 * one page left the full worker suite green.
		 *
		 * It matters because of the direction the guard fails in: if the listing
		 * truncates, a channel past page one stops finding its existing entry,
		 * the guard reverts to inserting, and the deliberate fail-toward-covering
		 * design means NOTHING surfaces the regression. F63-RUN-006 comes back
		 * silently.
		 */
		const { ops } = setup();
		const builtParams = (build: unknown) => {
			const params: Record<string, number> = {};
			const q = {
				limit(n: number) {
					params.limit = n;
					return q;
				},
				offset(n: number) {
					params.offset = n;
					return q;
				},
			};
			(build as (b: typeof q) => typeof q)(q);
			return params;
		};
		api.scheduledList
			.mockResolvedValueOnce({
				items: Array.from({ length: 100 }, (_, i) => ({
					id: `ent-${i}`,
					contentId: `slate-${i}`,
					status: "DESCHEDULED",
					createdAt: new Date("2026-06-11T00:00:00.000Z"),
				})),
			})
			.mockResolvedValueOnce({
				items: [
					{
						id: "ent-100",
						contentId: "slate-100",
						status: "SCHEDULED",
						createdAt: new Date("2026-06-12T00:00:00.000Z"),
					},
				],
			});
		const all = await ops.listScheduledInsertableContent("enc-1");
		expect(all).toHaveLength(101);
		expect(api.scheduledList).toHaveBeenCalledTimes(2);
		expect(builtParams(api.scheduledList.mock.calls[0]?.[1])).toEqual({
			limit: 100,
			offset: 0,
		});
		expect(builtParams(api.scheduledList.mock.calls[1]?.[1])).toEqual({
			limit: 100,
			offset: 100,
		});
		// The entry on page TWO is the one the guard would have to see.
		expect(all[100]).toEqual({
			// The id is what the slate guard matches on — without it an entry can
			// never be claimed, so the mapping is as load-bearing as the paging.
			id: "ent-100",
			contentId: "slate-100",
			status: "SCHEDULED",
			createdAt: "2026-06-12T00:00:00.000Z",
		});
	});

	it("maps an unusable createdAt to null rather than an Invalid Date", async () => {
		// The op's own comment says "An Invalid Date is TRUTHY … so it is
		// checked, not assumed" — and that check was itself checked by nothing.
		// null is what the slate guard reads as "not this attempt", so a broken
		// timestamp must fail toward inserting, never toward suppressing.
		const { ops } = setup();
		api.scheduledList.mockResolvedValueOnce({
			items: [
				{
					id: "ent-a",
					contentId: "a",
					status: "SCHEDULED",
					createdAt: new Date("nope"),
				},
				{ id: "ent-b", contentId: "b", status: "SCHEDULED" },
			],
		});
		const all = await ops.listScheduledInsertableContent("enc-1");
		expect(all).toEqual([
			{ id: "ent-a", contentId: "a", status: "SCHEDULED", createdAt: null },
			{ id: "ent-b", contentId: "b", status: "SCHEDULED", createdAt: null },
		]);
	});

	it("paginates insertable content to exhaustion — adopt-by-name must see past the SDK's 25-item default page (review-223 F3)", async () => {
		const { ops } = setup();
		// The op passes a query BUILDER; execute it against a recorder to read
		// what limit/offset it would set.
		const builtParams = (build: unknown) => {
			const params: Record<string, number> = {};
			const q = {
				limit(n: number) {
					params.limit = n;
					return q;
				},
				offset(n: number) {
					params.offset = n;
					return q;
				},
			};
			(build as (b: typeof q) => typeof q)(q);
			return params;
		};
		api.contentList
			.mockResolvedValueOnce({
				items: Array.from({ length: 100 }, (_, i) => ({
					id: `content-${i}`,
					name: `slate:${i}`,
					status: "READY",
				})),
			})
			.mockResolvedValueOnce({
				items: [{ id: "content-100", name: "slate:100", status: "CREATED" }],
			});
		const all = await ops.listLiveInsertableContent("enc-1");
		expect(all).toHaveLength(101);
		expect(api.contentList).toHaveBeenCalledTimes(2);
		expect(builtParams(api.contentList.mock.calls[0]?.[1])).toEqual({
			limit: 100,
			offset: 0,
		});
		expect(builtParams(api.contentList.mock.calls[1]?.[1])).toEqual({
			limit: 100,
			offset: 100,
		});

		// And the get-by-id path reads THROUGH the same pagination: an item on
		// page 2 is findable, which is exactly what a 25-item default breaks.
		api.contentList
			.mockResolvedValueOnce({
				items: Array.from({ length: 100 }, (_, i) => ({
					id: `content-${i}`,
					name: `slate:${i}`,
					status: "READY",
				})),
			})
			.mockResolvedValueOnce({
				items: [{ id: "content-100", name: "slate:100", status: "CREATED" }],
			});
		const hit = await ops.getLiveInsertableContent("enc-1", "content-100");
		expect(hit).toEqual({ id: "content-100", status: "CREATED" });
	});

	it("lists an encoding's ingest input streams to exhaustion, carrying inputId (C6)", async () => {
		const { ops } = setup();
		api.ingestList
			.mockResolvedValueOnce({
				items: Array.from({ length: 100 }, (_, i) => ({
					id: `is-${i}`,
					inputId: `in-${i}`,
				})),
			})
			.mockResolvedValueOnce({ items: [{ id: "is-100", inputId: "in-100" }] });
		const streams = await ops.listIngestInputStreams("bm-enc");
		expect(streams).toHaveLength(101);
		expect(streams[0]).toEqual({ id: "is-0", inputId: "in-0" });
		expect(api.ingestList).toHaveBeenCalledTimes(2);
		expect(api.ingestList).toHaveBeenNthCalledWith(1, "bm-enc", {
			offset: 0,
			limit: 100,
		});
	});

	it("builds SrtInput models with the passphrase but audits without it", async () => {
		const { ops, audits } = setup();
		await ops.createSrtInput({
			name: "SRT Input",
			mode: "LISTENER",
			port: 2088,
			latency: 120,
			passphrase: "0123456789abcdef",
			keyLength: 128,
			backupSrtInputs: {
				delayThreshold: 9,
				srtInputs: [
					{
						mode: "CALLER",
						host: "backup.example.com",
						port: 7001,
						passphrase: "fedcba9876543210",
						keyLength: 128,
					},
				],
			},
		});
		const model = api.srtCreate.mock.calls[0]?.[0] as SrtInput;
		expect(model).toBeInstanceOf(SrtInput);
		expect(model.mode).toBe("LISTENER");
		expect(model.passphrase).toBe("0123456789abcdef");
		expect(model.backupSrtInputs?.srtInputs?.[0]).toBeInstanceOf(SrtInput);
		expect(model.backupSrtInputs?.srtInputs?.[0]?.passphrase).toBe(
			"fedcba9876543210",
		);
		// The audit snapshot records only presence, never the value.
		const flat = JSON.stringify(audits);
		expect(flat).not.toContain("0123456789abcdef");
		expect(flat).not.toContain("fedcba9876543210");
		expect(audits[0]?.request).toMatchObject({
			name: "SRT Input",
			hasPassphrase: true,
		});
	});

	it("builds ZixiInput models with secrets but audits only their presence", async () => {
		const { ops, audits } = setup();
		await ops.createZixiInput({
			name: "Zixi Input",
			host: "zixi.example.com",
			port: 2077,
			stream: "channelOne",
			password: "ZIXI-PASSWORD",
			decryptionKey: "ZIXI-DECRYPT-KEY",
			decryptionType: "AES_128",
		});
		const model = api.zixiCreate.mock.calls[0]?.[0] as {
			password?: string;
			decryptionKey?: string;
		};
		expect(model.password).toBe("ZIXI-PASSWORD");
		expect(model.decryptionKey).toBe("ZIXI-DECRYPT-KEY");
		const flat = JSON.stringify(audits);
		expect(flat).not.toContain("ZIXI-PASSWORD");
		expect(flat).not.toContain("ZIXI-DECRYPT-KEY");
		expect(audits[0]?.request).toMatchObject({
			hasPassword: true,
			hasDecryptionKey: true,
		});
	});

	it("maps redundant RTMP stream-key configurations through the enum", async () => {
		const { ops, audits } = setup();
		await ops.createRedundantRtmpInput({
			name: "Redundant",
			delayThreshold: 10,
			staticIngestPoints: [
				{ name: "main", streamKeyConfiguration: { type: "GENERATE" } },
			],
		});
		const model = api.redundantCreate.mock.calls[0]?.[0] as {
			staticIngestPoints?: { streamKeyConfiguration?: { type?: string } }[];
		};
		expect(model.staticIngestPoints?.[0]?.streamKeyConfiguration?.type).toBe(
			"GENERATE",
		);
		// streamKey material is connection-routing (NOT vault) — it rides the
		// snapshot here; writeAuditLog's redactSecrets masks it at persistence.
		expect(audits[0]?.path).toBe("/encoding/inputs/redundant-rtmp");
	});

	it("rejects unknown stream-key configuration types instead of casting", async () => {
		const { ops } = setup();
		await expect(
			ops.createRedundantRtmpInput({
				name: "Redundant",
				staticIngestPoints: [
					{ streamKeyConfiguration: { type: "MAKE_ONE_UP" } },
				],
			}),
		).rejects.toThrow(/Unknown StreamKeyConfigurationType/);
	});

	it.each([
		undefined,
		"CUSTOM",
		"HD",
	] as const)("builds the %s start request with typed manifest entries and carries reupload nulls", async (encodingOption) => {
		const { ops, audits } = setup();
		await ops.startLiveEncoding("enc-1", {
			...(encodingOption ? { encodingOption } : {}),
			streamKey: "myStreamKey",
			hlsManifests: [
				{
					manifestId: "hls-1",
					timeshift: 7200,
					insertProgramDateTime: true,
					adMarkerSettings: { enabledMarkerTypes: ["EXT_X_DATERANGE"] },
				},
			],
			dashManifests: [
				{
					manifestId: "dash-1",
					timeshift: 7200,
					availabilityStartTimeMode: "ON_FIRST_SEGMENT",
					adMarkerSettings: {
						periodOption: "SINGLE_PERIOD",
						eventStreamSignalling: "XML_BIN",
					},
				},
			],
			manifestGenerator: "V2",
			reuploadSettings: {
				dashManifestInterval: null,
				muxingInitFileInterval: 60,
			},
			autoRestartConfiguration: { segmentsWrittenTimeout: 60 },
		});
		const start = encodingOption === "HD" ? api.liveHdStart : api.liveStart;
		const other = encodingOption === "HD" ? api.liveStart : api.liveHdStart;
		expect(start).toHaveBeenCalledWith("enc-1", expect.anything());
		expect(other).not.toHaveBeenCalled();
		const request = start.mock.calls[0]?.[1] as StartLiveEncodingRequest;
		expect(request).toBeInstanceOf(
			encodingOption === "HD"
				? StartLiveChannelEncodingRequest
				: StartLiveEncodingRequest,
		);
		expect(request).not.toHaveProperty("encodingOption");
		expect(request.streamKey).toBe("myStreamKey");
		expect(request.hlsManifests?.[0]).toBeInstanceOf(LiveHlsManifest);
		expect(request.hlsManifests?.[0]).toMatchObject({
			manifestId: "hls-1",
			timeshift: 7200,
			insertProgramDateTime: true,
		});
		expect(request.dashManifests?.[0]).toBeInstanceOf(LiveDashManifest);
		expect(request.dashManifests?.[0]?.availabilityStartTimeMode).toBe(
			"ON_FIRST_SEGMENT",
		);
		// C14: SCTE-35 ad-marker settings map enum NAMEs onto the real models.
		expect(request.hlsManifests?.[0]?.adMarkerSettings).toMatchObject({
			enabledMarkerTypes: ["EXT_X_DATERANGE"],
		});
		expect(request.dashManifests?.[0]?.adMarkerSettings).toMatchObject({
			periodOption: "SINGLE_PERIOD",
			eventStreamSignalling: "XML_BIN",
		});
		expect(request.manifestGenerator).toBe("V2");
		// null must survive to the wire — it means "never re-upload".
		expect(JSON.stringify(request.reuploadSettings)).toBe(
			'{"dashManifestInterval":null,"muxingInitFileInterval":60}',
		);
		expect(request.autoRestartConfiguration?.segmentsWrittenTimeout).toBe(60);
		expect(audits[0]?.path).toBe(
			`/encoding/encodings/enc-1/live/${encodingOption === "HD" ? "hd/" : ""}start`,
		);
	});

	for (const encodingOption of [undefined, "CUSTOM", "HD"] as const) {
		it.each([
			{ delayMs: 6000, updateMs: 2000, delaySeconds: 6, updateSeconds: 2 },
			{ delayMs: 0, updateMs: 250, delaySeconds: 0, updateSeconds: 0.25 },
			{
				delayMs: 1250.5,
				updateMs: 10.5,
				delaySeconds: 1.2505,
				updateSeconds: 0.0105,
			},
			{
				delayMs: undefined,
				updateMs: undefined,
				delaySeconds: undefined,
				updateSeconds: undefined,
			},
		])(`${encodingOption ?? "legacy"} DASH milliseconds become seconds only at the SDK/audit boundary: %j`, async ({
			delayMs,
			updateMs,
			delaySeconds,
			updateSeconds,
		}) => {
			const { ops, audits } = setup();
			const manifest = Object.freeze({
				manifestId: "dash-1",
				timeshift: 60,
				liveEdgeOffset: 6,
				suggestedPresentationDelay: delayMs,
				minimumUpdatePeriod: updateMs,
			});
			await ops.startLiveEncoding("enc-1", {
				...(encodingOption ? { encodingOption } : {}),
				streamKey: "streamKey",
				dashManifests: [manifest],
			});
			const start = encodingOption === "HD" ? api.liveHdStart : api.liveStart;
			const request = start.mock.calls[0]?.[1] as StartLiveEncodingRequest;
			expect(request.dashManifests?.[0]).toBeInstanceOf(LiveDashManifest);
			const expected = {
				manifestId: "dash-1",
				timeshift: 60,
				liveEdgeOffset: 6,
				suggestedPresentationDelay: delaySeconds,
				minimumUpdatePeriod: updateSeconds,
			};
			expect(request.dashManifests?.[0]).toMatchObject(expected);
			expect(audits[0]?.request).toMatchObject({ dashManifests: [expected] });
			expect(JSON.parse(JSON.stringify(request.dashManifests?.[0]))).toEqual(
				JSON.parse(JSON.stringify(expected)),
			);
			expect(manifest.suggestedPresentationDelay).toBe(delayMs);
			expect(manifest.minimumUpdatePeriod).toBe(updateMs);
		});
	}

	it("does not fall back to Custom when HD start is rejected", async () => {
		const { ops, audits } = setup();
		api.liveHdStart.mockRejectedValueOnce(
			new Error("HD configuration rejected"),
		);
		await expect(
			ops.startLiveEncoding("enc-1", {
				streamKey: "streamKey",
				encodingOption: "HD",
			}),
		).rejects.toThrow(/HD configuration rejected/);
		expect(api.liveHdStart).toHaveBeenCalledTimes(1);
		expect(api.liveStart).not.toHaveBeenCalled();
		expect(audits[0]?.path).toBe("/encoding/encodings/enc-1/live/hd/start");
	});

	it("maps the P5 start surfaces and audits the POIS pair as presence only", async () => {
		const { ops, audits } = setup();
		await ops.startLiveEncoding("enc-1", {
			streamKey: "myStreamKey",
			hlsManifests: [
				{
					manifestId: "hls-1",
					programDateTimeSettings: {
						source: "SYSTEM_CLOCK",
						placement: { mode: "SECONDS_INTERVAL", interval: 30 },
					},
				},
			],
			esamSettings: {
				poisEndpoint: "https://pois.example.com/esam",
				acquisitionPointIdentity: "ap-1",
				adAvailOffset: -1500,
				// The RESOLVED vault pair — must reach the SDK and nothing else.
				username: "pois-user",
				password: "POIS-PLAINTEXT-CANARY",
			},
			cacheControlSettings: {
				hls: { variantPlaylist: { cacheControl: "public, max-age=2" } },
				// DASH has its own SDK model — exercise both leaves (review M3).
				dash: {
					timelineManifest: { cacheControl: "public, max-age=1" },
					templateManifest: { cacheControl: "public, max-age=4" },
				},
				// A blank leaf must not produce an SDK object at all.
				segments: { initSegment: { cacheControl: "" } },
			},
			adInsertionSettings: {
				enableEsamMediaPointInsertion: true,
				clockSynchronizationMode: "SYSTEM_CLOCK",
			},
		});
		const request = api.liveStart.mock
			.calls[0]?.[1] as StartLiveEncodingRequest;
		// PDT: our short plan names map onto the SDK's longer field names.
		const pdt = request.hlsManifests?.[0]?.programDateTimeSettings;
		expect(pdt).toBeInstanceOf(ProgramDateTimeSettings);
		expect(pdt?.programDateTimeSource).toBe("SYSTEM_CLOCK");
		expect(pdt?.programDateTimePlacement?.programDateTimePlacementMode).toBe(
			"SECONDS_INTERVAL",
		);
		expect(pdt?.programDateTimePlacement?.interval).toBe(30);
		// ESAM: the pair rides the real credentials model.
		expect(request.esamSettings).toBeInstanceOf(EsamSettings);
		expect(request.esamSettings?.poisEndpointCredentials).toBeInstanceOf(
			PoisEndpointCredentials,
		);
		expect(request.esamSettings?.poisEndpointCredentials).toMatchObject({
			username: "pois-user",
			password: "POIS-PLAINTEXT-CANARY",
		});
		expect(request.esamSettings?.adAvailOffset).toBe(-1500);
		// Cache-Control: set leaf becomes a model, blank leaf stays absent.
		expect(request.cacheControlSettings).toBeInstanceOf(CacheControlSettings);
		expect(
			request.cacheControlSettings?.hls?.variantPlaylist?.cacheControl,
		).toBe("public, max-age=2");
		expect(
			request.cacheControlSettings?.dash?.timelineManifest?.cacheControl,
		).toBe("public, max-age=1");
		expect(
			request.cacheControlSettings?.dash?.templateManifest?.cacheControl,
		).toBe("public, max-age=4");
		expect(request.cacheControlSettings?.segments?.initSegment).toBeUndefined();
		expect(request.adInsertionSettings).toBeInstanceOf(AdInsertionSettings);
		expect(request.adInsertionSettings?.clockSynchronizationMode).toBe(
			"SYSTEM_CLOCK",
		);
		// THE security assertion: the audit snapshot carries presence flags and
		// the plaintext pair appears NOWHERE in it — including after JSON
		// serialization, which is how it would reach Postgres.
		const flat = JSON.stringify(audits);
		expect(flat).not.toContain("POIS-PLAINTEXT-CANARY");
		expect(flat).not.toContain("pois-user");
		expect(audits[0]?.request).toMatchObject({
			esamSettings: {
				poisEndpoint: "https://pois.example.com/esam",
				poisUsernameProvided: true,
				poisPasswordProvided: true,
			},
		});
	});

	/**
	 * THE security assertion for MSL5 —  PR 2, modelled on the POIS
	 * arm above because that is the two-field precedent.
	 *
	 * `audited` has no redaction of its own; its whole contract is that the
	 * snapshot handed to it is already secret-free. The MSL factory was, for
	 * years, the one that deliberately passed its FULL payload — with a comment
	 * saying MSL carries no secret. MSL5 falsified that, and this arm is what
	 * makes the sentence true again rather than merely rewritten.
	 *
	 * ONE flag, not two. The pair is atomic under the executor's AND guard,
	 * which throws while the argument object is still being evaluated — before
	 * `audited` is entered — so a half-filled credential never produces an
	 * audit row for two flags to disagree in. Two flags would advertise a
	 * divergence that cannot occur.
	 */
	it("keeps the MSL5 Digest pair out of the audit snapshot", async () => {
		const { ops, audits } = setup();
		await ops.createAkamaiMslOutput({
			name: "msl5",
			streamId: 20001601,
			eventName: "ev",
			streamFormat: "CMAF",
			mslVersion: "MSL5",
			publishingAuthentication: {
				enabled: true,
				username: "MSL-USER-CANARY",
				password: "MSL-PLAINTEXT-CANARY",
			},
		});
		// Serialized, because that is how it reaches Postgres — and because a
		// `toMatchObject` alone would miss a copy nested anywhere else.
		const flat = JSON.stringify(audits);
		expect(flat).not.toContain("MSL-PLAINTEXT-CANARY");
		expect(flat).not.toContain("MSL-USER-CANARY");
		expect(audits[0]?.request).toMatchObject({
			streamId: 20001601,
			mslVersion: "MSL5",
			publishingAuthProvided: true,
		});
		// DESTRUCTURED, not set to undefined: an `undefined` key still exists,
		// so redactSecrets would emit `"password":"[REDACTED]"` beside
		// `publishingAuthProvided:true` — audit data implying a redaction
		// happened where none was needed (the POIS lesson, one shape over).
		expect(audits[0]?.request).not.toHaveProperty("publishingAuthentication");
		// And the pair DID reach the SDK — a snapshot that is clean because the
		// call sent nothing would pass every assertion above.
		expect(api.akamaiMslCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				publishingAuthentication: expect.objectContaining({
					enabled: true,
					username: "MSL-USER-CANARY",
					password: "MSL-PLAINTEXT-CANARY",
				}),
			}),
		);
	});

	it("reports publishingAuthProvided false when no pair rides", async () => {
		const { ops, audits } = setup();
		await ops.createAkamaiMslOutput({
			name: "msl4",
			streamId: 2108679,
			eventName: "ev",
			streamFormat: "HLS",
			mslVersion: "MSL4",
		});
		expect(audits[0]?.request).toMatchObject({ publishingAuthProvided: false });
	});

	it("never lets a Bitmovin error's body-embedding message escape the facade", async () => {
		// The SDK builds BitmovinError.message by concatenating the raw REQUEST
		// BODY into it (BitmovinErrorBuilder.appendRequestMessage). Every error
		// string we persist — step-log entry.error, the job/channel error columns
		// — would therefore carry whatever secret the call sent, and
		// redactSecrets on a bare string only masks URL userinfo. So the facade
		// must rethrow the API's curated text, never the SDK's message.
		const { ops, audits } = setup();
		const sdkError = Object.assign(
			new Error(
				"POST https://api.bitmovin.com/v1/encoding/encodings/enc-1/live/start\n" +
					'  body: {"esamSettings":{"poisEndpointCredentials":{"username":"pois-user","password":"POIS-PLAINTEXT-CANARY"}}}',
			),
			{
				httpStatusCode: 400,
				shortMessage: "Invalid ESAM configuration",
				errorCode: 1234,
			},
		);
		api.liveStart.mockRejectedValueOnce(sdkError);
		const thrown = await ops
			.startLiveEncoding("enc-1", {
				streamKey: "myStreamKey",
				esamSettings: {
					poisEndpoint: "https://pois.example.com/esam",
					username: "pois-user",
					password: "POIS-PLAINTEXT-CANARY",
				},
			})
			.then(
				() => null,
				(err: unknown) => err as Error,
			);
		expect(thrown).toBeInstanceOf(Error);
		// Diagnostic value preserved: status + the API's own short message.
		expect(thrown?.message).toContain("Invalid ESAM configuration");
		expect(thrown?.message).toContain("400");
		expect(thrown?.message).toContain("/live/start");
		// …and the plaintext body is gone from the message AND the audit row.
		expect(thrown?.message).not.toContain("POIS-PLAINTEXT-CANARY");
		expect(thrown?.message).not.toContain("body:");
		expect(JSON.stringify(audits)).not.toContain("POIS-PLAINTEXT-CANARY");
		// The original stays reachable for a debugger, just never serialized.
		expect((thrown as { cause?: unknown })?.cause).toBe(sdkError);
	});

	it("passes OUR own errors through untouched (no request body to hide)", async () => {
		const { ops } = setup();
		api.liveStop.mockRejectedValueOnce(new Error("redis down"));
		await expect(ops.stopLiveEncoding("enc-1")).rejects.toThrow("redis down");
	});

	it("audits stop/restart as POST actions", async () => {
		const { ops, audits } = setup();
		await ops.stopLiveEncoding("enc-1");
		await ops.restartLiveEncoding("enc-1");
		expect(api.liveStop).toHaveBeenCalledWith("enc-1");
		expect(api.liveRestart).toHaveBeenCalledWith("enc-1");
		expect(audits.map((a) => a.path)).toEqual([
			"/encoding/encodings/enc-1/live/stop",
			"/encoding/encodings/enc-1/live/restart",
		]);
	});

	it("returns live details and plain-JSON snapshots for reads (not audited)", async () => {
		const { ops, audits } = setup();
		const details = await ops.getLiveEncodingDetails("enc-1");
		expect(details).toEqual({
			streamKey: "liveStreamKey",
			encoderIp: "203.0.113.7",
			application: "live",
		});
		const startRequest = (await ops.getLiveStartRequest("enc-1")) as Record<
			string,
			unknown
		>;
		expect(startRequest).toEqual({
			streamKey: "liveStreamKey",
			manifestGenerator: "V2",
		});
		const heartbeat = await ops.getLiveHeartbeat("enc-1");
		// Dates become ISO strings — persistable as Json.
		expect(heartbeat.timestamp).toBe("2026-06-12T01:02:03.000Z");
		expect(heartbeat.ingest?.droppedPacketsVideo).toBe(3);
		expect(audits).toHaveLength(0);
	});

	it("sends reset-timeshift and SCTE-35 cues with their full surfaces", async () => {
		const { ops, audits } = setup();
		await ops.resetLiveManifestTimeshift("enc-1", {
			residualPeriodInSeconds: 600,
			offsetInSeconds: 30,
			manifestIds: ["m-1"],
			shiftProgressiveMuxingStartPosition: true,
		});
		const cue = await ops.insertScte35Cue("enc-1", {
			cueDuration: 30,
			manifestIds: ["m-1"],
		});
		expect(cue).toEqual({ id: "bm-1" });
		expect(api.resetTimeshiftCreate.mock.calls[0]?.[0]).toBe("enc-1");
		expect(api.resetTimeshiftCreate.mock.calls[0]?.[1]).toMatchObject({
			residualPeriodInSeconds: 600,
			offsetInSeconds: 30,
			manifestIds: ["m-1"],
			shiftProgressiveMuxingStartPosition: true,
		});
		expect(api.scte35Create.mock.calls[0]?.[1]).toMatchObject({
			cueDuration: 30,
			manifestIds: ["m-1"],
		});
		expect(audits.map((a) => a.path)).toEqual([
			"/encoding/encodings/enc-1/live/reset-live-manifest-timeshift",
			"/encoding/encodings/enc-1/live/scte-35-cue",
		]);
	});
	it("patches redundant RTMP using real SDK models without keys in audit snapshots", async () => {
		const { ops, audits } = setup();
		await ops.updateLiveRtmpIngestPoints("enc-1", [
			{ applicationName: "backup", streamKey: "private-key" },
		]);
		expect(api.rtmpPatch).toHaveBeenCalledWith(
			"enc-1",
			expect.any(UpdateEncodingRtmpIngestPointRequest),
		);
		const request = api.rtmpPatch.mock
			.calls[0]?.[1] as UpdateEncodingRtmpIngestPointRequest;
		expect(request.ingestPoints?.[0]).toBeInstanceOf(RtmpIngestPoint);
		expect(request.ingestPoints?.[0]).toMatchObject({
			applicationName: "backup",
			streamKey: "private-key",
		});
		expect(audits[0]).toMatchObject({
			method: "PATCH",
			path: "/encoding/live/encodings/enc-1/actions/update-rtmp-ingest-points",
			request: { ingestPoints: [{ applicationName: "backup" }] },
		});
		expect(JSON.stringify(audits)).not.toContain("private-key");
	});
	it("never persists RTMP keys echoed in a provider exception", async () => {
		const { ops, audits } = setup();
		api.rtmpPatch.mockRejectedValueOnce(
			Object.assign(new Error("request streamKey=private-key rtmp://private"), {
				shortMessage: "private-key",
				httpStatusCode: 409,
			}),
		);
		await expect(
			ops.updateLiveRtmpIngestPoints("enc-1", [
				{ applicationName: "backup", streamKey: "private-key" },
			]),
		).rejects.toThrow("provider result is unknown");
		expect(audits[0]?.statusCode).toBe(409);
		expect(JSON.stringify(audits)).not.toContain("private-key");
	});
});

describe("kantar watermarking (P5 PR-4)", () => {
	it("sends the vaulted login pair to the SDK but audits presence only", async () => {
		const { ops, audits } = setup();
		await ops.createKantarWatermark("enc-1", {
			login: "kantar-user",
			password: "KANTAR-PLAINTEXT-CANARY",
			licenseId: 4711,
			channelName: "Demo Channel JP",
			contentReference: "ep01",
			serverUrl: "https://kantar.example.com/watermark",
			report: {
				outputId: "bm-output",
				outputPath: "reports",
				acl: "PRIVATE",
			},
		});
		const model = api.kantarCreate.mock.calls[0]?.[1] as KantarWatermark;
		expect(model).toBeInstanceOf(KantarWatermark);
		expect(model.login).toBe("kantar-user");
		expect(model.password).toBe("KANTAR-PLAINTEXT-CANARY");
		expect(model.licenseId).toBe(4711);
		expect(model.reportOutputs?.[0]).toMatchObject({
			outputId: "bm-output",
			outputPath: "reports",
		});
		// The audit row records only that the pair was supplied.
		const flat = JSON.stringify(audits);
		expect(flat).not.toContain("KANTAR-PLAINTEXT-CANARY");
		expect(flat).not.toContain("kantar-user");
		expect(audits[0]?.request).toMatchObject({
			licenseId: 4711,
			kantarLoginProvided: true,
			kantarPasswordProvided: true,
		});
		expect(audits[0]?.path).toBe("/encoding/encodings/enc-1/kantar-watermark");
	});
});
