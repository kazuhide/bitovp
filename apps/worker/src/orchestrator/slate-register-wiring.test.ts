import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import type { BoundedObjectProbe } from "../inspect/processor";
import {
	createLiveChannelActions,
	type LiveChannelDeps,
} from "./live-processor";
import type { SdkOps } from "./sdk-ops";
import type { SlateRegisterDeps } from "./slate-register";

/**
 * The CALL SITE, not the rule .
 *
 * `slate-register.test.ts` proves the compatibility check refuses what it
 * should. That proves nothing about whether `registerSlate` ever hands it a
 * reference or a prober — and a check the production path never supplies
 * inputs to is a named slot with nothing in it. This file asserts the two
 * arguments cross the boundary, so deleting either from the call site goes
 * red.
 */

const registerSlateContent = vi.hoisted(() =>
	vi.fn(async () => ({
		outcome: "REGISTERED" as const,
		insertableContentId: "content-1",
	})),
);
vi.mock("./slate-register", async () => {
	const actual =
		await vi.importActual<typeof import("./slate-register")>(
			"./slate-register",
		);
	return { ...actual, registerSlateContent };
});

const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const SCHEDULE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE = {
	credentialId: "33333333-3333-4333-8333-333333333333",
	bucket: "in",
	key: "slate.mp4",
};

/** What the run recorded as the encoder's bind, in the persisted shape. */
const RUN_INGEST_MEDIA = {
	video: { codec: "h264", width: 1920, height: 1080, frameRate: 29.97 },
	audio: [{ codec: "aac", sampleRate: 48000, channels: 2 }],
};

function harness(over: {
	run?: Record<string, unknown> | null;
	channelHeartbeat?: unknown;
	probeStorageObject?: BoundedObjectProbe;
}) {
	const prisma = {
		liveChannel: {
			findUnique: vi.fn(async () => ({
				id: CHANNEL_ID,
				status: "RUNNING",
				bitmovinEncodingId: "enc-1",
				bitmovinAccountId: "acct-1",
				plan: {},
				lastHeartbeat: over.channelHeartbeat ?? null,
			})),
		},
		liveChannelRun: {
			findFirst: vi.fn(async () => over.run ?? null),
		},
	} as unknown as AppPrismaClient;
	const deps = {
		prisma,
		revealBitmovinAccount: vi.fn(async () => ({
			apiKey: "k",
			tenantOrgId: null,
		})),
		resolveCredential: vi.fn(async () => ({
			provider: "AWS_S3",
			config: {},
			secret: {},
		})),
		makeSdk: () => ({}) as SdkOps,
		sleep: async () => {},
		pollIntervalMs: 1,
		pollTimeoutMs: 10,
		now: () => "2026-08-29T00:00:00.000Z",
		enqueueFeederJob: vi.fn(async () => {}),
		...(over.probeStorageObject
			? { probeStorageObject: over.probeStorageObject }
			: {}),
	} as unknown as LiveChannelDeps;
	return createLiveChannelActions(deps);
}

/** The deps object the last `registerSlateContent` call received. */
function lastDeps(): SlateRegisterDeps {
	const call = registerSlateContent.mock.calls.at(-1) as
		| [SlateRegisterDeps, unknown]
		| undefined;
	if (!call) {
		throw new Error("registerSlateContent was never called");
	}
	return call[0];
}

describe("registerSlate hands the compatibility check its inputs (#239)", () => {
	it("passes the run's recorded reference through", async () => {
		registerSlateContent.mockClear();
		const actions = harness({
			run: { ingestMedia: RUN_INGEST_MEDIA, lastHeartbeat: null },
		});
		await actions.registerSlate(CHANNEL_ID, {
			scheduleId: SCHEDULE_ID,
			source: SOURCE,
		});
		expect(lastDeps().ingestMedia).toEqual(RUN_INGEST_MEDIA);
	});

	it("falls back to the run's heartbeat when nothing was recorded", async () => {
		registerSlateContent.mockClear();
		const actions = harness({
			run: {
				ingestMedia: null,
				lastHeartbeat: {
					at: "2026-08-29T00:00:00.000Z",
					raw: {
						ingest: {
							status: "CONNECTED",
							streams: [
								{ mediaType: "VIDEO", width: 1280, height: 720, rate: 25 },
							],
						},
					},
				},
			},
		});
		await actions.registerSlate(CHANNEL_ID, {
			scheduleId: SCHEDULE_ID,
			source: SOURCE,
		});
		expect(lastDeps().ingestMedia).toEqual({
			video: { width: 1280, height: 720, frameRate: 25 },
			audio: [],
		});
	});

	it("reads the CHANNEL heartbeat only when the channel has no run row", async () => {
		registerSlateContent.mockClear();
		const actions = harness({
			run: null,
			channelHeartbeat: {
				at: "2026-08-29T00:00:00.000Z",
				raw: {
					ingest: {
						status: "CONNECTED",
						streams: [
							{ mediaType: "VIDEO", width: 1920, height: 1080, rate: 30 },
						],
					},
				},
			},
		});
		await actions.registerSlate(CHANNEL_ID, {
			scheduleId: SCHEDULE_ID,
			source: SOURCE,
		});
		expect(lastDeps().ingestMedia).toEqual({
			video: { width: 1920, height: 1080, frameRate: 30 },
			audio: [],
		});
	});

	it("does NOT inherit a heartbeat across runs — a run's silence is silence", async () => {
		// review-243 R1: the run exists and has nothing to say. The channel
		// column still holds the previous airing's final sample, and reading it
		// here would compare the new encoder against the old one's bind.
		registerSlateContent.mockClear();
		const actions = harness({
			run: { ingestMedia: null, lastHeartbeat: null },
			channelHeartbeat: {
				at: "2026-08-29T00:00:00.000Z",
				raw: {
					ingest: {
						status: "CONNECTED",
						streams: [
							{ mediaType: "VIDEO", width: 1920, height: 1080, rate: 30 },
						],
					},
				},
			},
		});
		await actions.registerSlate(CHANNEL_ID, {
			scheduleId: SCHEDULE_ID,
			source: SOURCE,
		});
		expect(lastDeps().ingestMedia).toBeNull();
	});

	it("aims the bounded prober at the slate's own object", async () => {
		registerSlateContent.mockClear();
		const probeStorageObject = vi.fn(async () => null);
		const actions = harness({
			run: { ingestMedia: RUN_INGEST_MEDIA, lastHeartbeat: null },
			probeStorageObject,
		});
		await actions.registerSlate(CHANNEL_ID, {
			scheduleId: SCHEDULE_ID,
			source: SOURCE,
		});
		const probeSlateSource = lastDeps().probeSlateSource;
		expect(probeSlateSource).toBeTypeOf("function");
		await probeSlateSource?.(SOURCE);
		expect(probeStorageObject).toHaveBeenCalledWith({
			label: `slate-${SCHEDULE_ID}`,
			credentialId: SOURCE.credentialId,
			bucket: SOURCE.bucket,
			key: SOURCE.key,
		});
	});

	it("omits the prober when the worker has no probing capability", async () => {
		registerSlateContent.mockClear();
		const actions = harness({
			run: { ingestMedia: RUN_INGEST_MEDIA, lastHeartbeat: null },
		});
		await actions.registerSlate(CHANNEL_ID, {
			scheduleId: SCHEDULE_ID,
			source: SOURCE,
		});
		expect(lastDeps().probeSlateSource).toBeUndefined();
	});
});
