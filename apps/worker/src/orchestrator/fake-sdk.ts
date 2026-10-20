import { vi } from "vitest";
import type { SdkOps } from "./sdk-ops";

/**
 * Complete SdkOps fake for executor/processor tests: every create returns
 * a fresh `bm-N` id, status polls report FINISHED, listings are empty.
 * Override per test via the partial. Lives next to the tests (not under
 * __tests__) so both suites share one source of truth for the surface —
 * a new SdkOps method fails compilation here first.
 */
export function fakeSdk(overrides: Partial<SdkOps> = {}): SdkOps {
	/** Manifest ids whose start has been called — see the status stubs below. */
	const started = new Set<string>();
	let n = 0;
	const nextId = () => Promise.resolve(`bm-${++n}`);
	/** What the provider holds scheduled — written by the POST stub below. */
	const scheduledInsertions: {
		id: string | null;
		contentId: string | null;
		status: string;
		createdAt: string | null;
	}[] = [];
	return {
		createS3Input: vi.fn(nextId),
		createAzureInput: vi.fn(nextId),
		createHttpsInput: vi.fn(nextId),
		createGenericS3Input: vi.fn(nextId),
		createGcsInput: vi.fn(nextId),
		createGcsServiceAccountInput: vi.fn(nextId),
		createS3Output: vi.fn(nextId),
		createAzureOutput: vi.fn(nextId),
		createSftpOutput: vi.fn(nextId),
		createGenericS3Output: vi.fn(nextId),
		createGcsOutput: vi.fn(nextId),
		createGcsServiceAccountOutput: vi.fn(nextId),
		createAkamaiMslOutput: vi.fn(nextId),
		createLiveMediaIngestOutput: vi.fn(nextId),
		createAkamaiNetStorageInput: vi.fn(nextId),
		createAkamaiNetStorageOutput: vi.fn(nextId),
		createEncoding: vi.fn(nextId),
		findVerificationEncodings: vi.fn(() => Promise.resolve([])),
		createIngestInputStream: vi.fn(nextId),
		createFileInputStream: vi.fn(nextId),
		createDolbyAtmosInputStream: vi.fn(nextId),
		createDolbyVisionInputStream: vi.fn(nextId),
		createDolbyVisionMetadataInputStream: vi.fn(nextId),
		createTimeBasedTrimmingInputStream: vi.fn(nextId),
		createTimecodeTrackTrimmingInputStream: vi.fn(nextId),
		createH264PictureTimingTrimmingInputStream: vi.fn(nextId),
		createConcatenationInputStream: vi.fn(nextId),
		createAudioMixInputStream: vi.fn(nextId),
		createH264Config: vi.fn(nextId),
		createH265Config: vi.fn(nextId),
		createVp9Config: vi.fn(nextId),
		createAv1Config: vi.fn(nextId),
		createAacConfig: vi.fn(nextId),
		createOpusConfig: vi.fn(nextId),
		createImscConfig: vi.fn(nextId),

		createDolbyAtmosConfig: vi.fn(nextId),
		createDolbyDigitalPlusConfig: vi.fn(nextId),
		createDolbyDigitalConfig: vi.fn(nextId),
		createWebVttConfig: vi.fn(nextId),
		createStream: vi.fn(nextId),
		createDolbyVisionStreamHdr: vi.fn(nextId),
		createDeinterlaceFilter: vi.fn(nextId),
		createBurnInSrt: vi.fn(nextId),
		createDashSubtitleAdaptationSet: vi.fn(nextId),
		createDashChunkedTextRepresentation: vi.fn(nextId),
		createDashImscRepresentation: vi.fn(nextId),

		createMediaFilter: vi.fn(nextId),
		createStreamFilters: vi.fn(() => Promise.resolve()),
		createKeyframe: vi.fn(nextId),
		createNexGuardFileMarker: vi.fn(nextId),
		createThumbnail: vi.fn(nextId),
		createSprite: vi.fn(nextId),
		createCmafMuxing: vi.fn(nextId),
		createFmp4Muxing: vi.fn(nextId),
		createMp4Muxing: vi.fn(nextId),
		createProgressiveWebmMuxing: vi.fn(nextId),
		createTsMuxing: vi.fn(nextId),
		createWebmMuxing: vi.fn(nextId),
		createChunkedTextMuxing: vi.fn(nextId),
		createTextMuxing: vi.fn(nextId),

		createCencDrm: vi.fn(nextId),
		createSpekeDrm: vi.fn(nextId),
		createFairPlayDrm: vi.fn(nextId),
		createHlsManifest: vi.fn(nextId),
		createKantarWatermark: vi.fn(nextId),
		createDefaultHlsManifest: vi.fn(nextId),
		createDefaultDashManifest: vi.fn(nextId),
		createHlsAudioMedia: vi.fn(nextId),
		createHlsStreamInfo: vi.fn(nextId),
		createHlsSubtitlesMedia: vi.fn(nextId),
		createHlsIframePlaylist: vi.fn(nextId),
		createDashManifest: vi.fn(nextId),
		createDashPeriod: vi.fn(nextId),
		createDashVideoAdaptationSet: vi.fn(nextId),
		createDashAudioAdaptationSet: vi.fn(nextId),
		createDashCmafRepresentation: vi.fn(nextId),
		createDashFmp4Representation: vi.fn(nextId),
		createDashWebmRepresentation: vi.fn(nextId),
		createDashMp4Representation: vi.fn(nextId),
		createDashContentProtection: vi.fn(nextId),
		createSmoothManifest: vi.fn(nextId),
		createSmoothMp4Representation: vi.fn(nextId),
		createSmoothContentProtection: vi.fn(nextId),
		startEncoding: vi.fn(() => Promise.resolve()),
		stopEncoding: vi.fn(() => Promise.resolve()),
		getEncodingStatus: vi.fn(() => Promise.resolve({ status: "FINISHED" })),
		// Healthiest default: an encoding with nothing to report.
		getEncodingMessages: vi.fn(() => Promise.resolve([])),
		/**
		 * ORDER-SENSITIVE (review-208 S1). These used to answer FINISHED
		 * unconditionally, so "await a manifest nobody started" was GREEN — a
		 * job could report FINISHED before its manifest existed and no test in
		 * the repo could tell. A manifest reports CREATED until its own start
		 * has been called; awaiting one that was never started now fails the
		 * await, which is what the real API does.
		 */
		startHlsManifest: vi.fn((id: string) => {
			started.add(`hls:${id}`);
			return Promise.resolve();
		}),
		getHlsManifestStatus: vi.fn((id: string) =>
			Promise.resolve({
				status: started.has(`hls:${id}`) ? "FINISHED" : "CREATED",
			}),
		),
		/**  — live-to-VOD's compensating cleanup; the healthiest answer is "deleted". */
		deleteHlsManifest: vi.fn((_id: string) => Promise.resolve()),
		startDashManifest: vi.fn((id: string) => {
			started.add(`dash:${id}`);
			return Promise.resolve();
		}),
		getDashManifestStatus: vi.fn((id: string) =>
			Promise.resolve({
				status: started.has(`dash:${id}`) ? "FINISHED" : "CREATED",
			}),
		),
		deleteDashManifest: vi.fn((_id: string) => Promise.resolve()),
		startSmoothManifest: vi.fn((id: string) => {
			started.add(`smooth:${id}`);
			return Promise.resolve();
		}),
		getSmoothManifestStatus: vi.fn((id: string) =>
			Promise.resolve({
				status: started.has(`smooth:${id}`) ? "FINISHED" : "CREATED",
			}),
		),
		listMuxings: vi.fn(() => Promise.resolve([])),
		getStreamContext: vi.fn(() =>
			Promise.resolve({ mode: "STANDARD", codecConfigId: "bm-codec" }),
		),
		listEncodingStreams: vi.fn(() =>
			Promise.resolve({ items: [], complete: true }),
		),
		listAllMuxings: vi.fn(() => Promise.resolve({ items: [], complete: true })),
		getCodecConfigDetail: vi.fn(() => Promise.resolve(null)),
		getVideoConfigBitrate: vi.fn(() => Promise.resolve(undefined)),
		listMuxingDrm: vi.fn(() => Promise.resolve([])),
		// --- live (P3-PR2) ---
		listRunningLiveEncodings: vi.fn(() => Promise.resolve([])),
		listRtmpInputs: vi.fn(() =>
			Promise.resolve([{ id: "bm-rtmp-default", name: "Default RTMP" }]),
		),
		listIngestInputStreams: vi.fn(() =>
			Promise.resolve([] as { id: string; inputId?: string }[]),
		),
		createRedundantRtmpInput: vi.fn(nextId),
		createSrtInput: vi.fn(nextId),
		createZixiInput: vi.fn(nextId),
		createHlsLiveInput: vi.fn(nextId),
		startLiveEncoding: vi.fn(() => Promise.resolve()),
		stopLiveEncoding: vi.fn(() => Promise.resolve()),
		restartLiveEncoding: vi.fn(() => Promise.resolve()),
		getLiveEncodingDetails: vi.fn(() =>
			Promise.resolve({
				streamKey: "fakeStreamKey",
				encoderIp: "203.0.113.10",
				application: "live",
			}),
		),
		getLiveStartRequest: vi.fn(() =>
			Promise.resolve({ streamKey: "fakeStreamKey" } as unknown),
		),
		getLiveHeartbeat: vi.fn(() =>
			Promise.resolve({
				timestamp: "2026-06-12T00:00:00Z",
				ingest: {
					status: "CONNECTED",
					healthy: true,
					droppedPacketsVideo: 0,
					droppedPacketsAudio: 0,
					corruptPacketsVideo: 0,
					corruptPacketsAudio: 0,
				},
				// The SDK's fourth field  — present in the fake so
				// a capture test can pin that it survives to the stored sample.
				output: {
					manifests: { updatedManifests: 2 },
					segments: { writtenSegments: 42 },
				},
				events: [],
			}),
		),
		resetLiveManifestTimeshift: vi.fn(() => Promise.resolve()),
		insertScte35Cue: vi.fn(() => Promise.resolve({ id: "fake-scte35-cue" })),
		updateLiveRtmpIngestPoints: vi.fn(async () => undefined),
		updateLiveAutoShutdown: vi.fn(async (_id, configuration) => ({
			configuration,
			scheduledShutdownAt: null,
		})),
		createLiveInsertableContent: vi.fn(nextId),
		getLiveInsertableContent: vi.fn(async (_e: string, contentId: string) => ({
			id: contentId,
			status: "READY",
		})),
		listLiveInsertableContent: vi.fn(async () => []),
		/**
		 * STATEFUL, and the two reads it answers are at different moments.
		 *
		 * Before the POST it is empty — the provider has nothing scheduled, so
		 * the slate path inserts. After the POST it lists what the POST created,
		 * SCHEDULED, which is the HEALTHIEST realistic response to 's
		 * confirmation poll.
		 *
		 * A fixed `[]` would have made the default answer "the provider does not
		 * list your insertion", so every slate test in the suite would have
		 * quietly exercised the UNCONFIRMED arm and asserted, by silence, that
		 * never confirming anything is fine. That is the same trap the
		 * `scheduleInsertableContent` docstring below records: a degraded
		 * default does not hide one case, it makes hundreds of green tests
		 * assert the degraded behaviour.
		 *
		 * `createdAt` is REAL now, not the harness's frozen 2026-06-12 clock, so
		 * these entries fall outside the guard's retry window and cannot make a
		 * later cover read as already-scheduled. The guard's own tests supply
		 * their own entries and override this.
		 */
		listScheduledInsertableContent: vi.fn(async () => [...scheduledInsertions]),
		/**
		 * The HEALTHIEST realistic response, not the degraded one — review-300.
		 *
		 * This defaulted to `null` (no entry id), which is the DEGRADED shape: a
		 * record that claims nothing. Because it was the default, every unrelated
		 * test in the suite silently exercised it, which is how two probes about
		 * unclaimable records found no existing arm to trip over. A degraded
		 * default does not merely hide the degraded case — it makes hundreds of
		 * passing tests quietly assert that degraded behaviour is fine.
		 *
		 * Tests that want the degraded case say so explicitly — today that is
		 * "a POST that returns NO id writes a record claiming nothing" in
		 * live-processor.test.ts. NAMED, because the first version of this sentence
		 * asserted that such tests existed when none did: a claim about the state of
		 * the test suite is a grep, and it was written from intent rather than from
		 * output (review-300).
		 */
		scheduleInsertableContent: vi.fn(
			async (_encodingId: string, p: { contentId: string }) => {
				scheduledInsertions.push({
					id: "ent-fake-created",
					contentId: p.contentId,
					status: "SCHEDULED",
					createdAt: new Date().toISOString(),
				});
				return "ent-fake-created" as string | null;
			},
		),
		...overrides,
	};
}
