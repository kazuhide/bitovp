import {
	buildUsageSeries,
	compileLiveChannel,
	compilePlan,
	computePooled,
	encodingPlanSchema,
	liveChannelPlanSchema,
	type UsageDayRow,
	VMAF_SCORING_VERSION,
} from "@bitovp/core";
import { buildPlan, DEFAULT_WIZARD_STATE } from "@bitovp/core/wizard";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";

export const DEMO_VOD_JOB_ID = "00000000-0000-4000-8000-000000000101";
export const DEMO_LIVE_CHANNEL_ID = "00000000-0000-4000-8000-000000000201";
// The production importer clears UUIDs starting 00000000- as sample placeholders.
export const DEMO_ACCOUNT_ID = "de000000-0000-4000-8000-000000000301";
export const DEMO_STORAGE_ID = "de000000-0000-4000-8000-000000000401";
export const DEMO_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000501";
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000601";
export const DEMO_BUCKET = "demo-media";
export const DEMO_VMAF_JOB_ID = "00000000-0000-4000-8000-000000000701";

export type DemoRecord = Record<string, unknown>;

export const demoSession = {
	mode: "users",
	configured: true,
	authenticated: true,
	loginKind: "disabled",
	organizationId: DEMO_ORGANIZATION_ID,
	organizationName: "Demo workspace",
	effectiveUserId: DEMO_USER_ID,
	actorUserId: DEMO_USER_ID,
	displayName: "Demo user",
	role: "OPERATOR",
	platformOwner: false,
	isImpersonating: false,
	organizations: [
		{
			id: DEMO_ORGANIZATION_ID,
			name: "Demo workspace",
			slug: "demo",
			role: "OPERATOR",
		},
	],
};

export function demoAccount(now = Date.now()) {
	return {
		id: DEMO_ACCOUNT_ID,
		label: "Demo account (simulated)",
		tenantOrgId: null,
		internalHevcV2: false,
		defaults: {
			encoderVersion: "STABLE",
			cloudRegion: "AWS_EU_WEST_1",
			fallbackRegions: [],
			prewarmedPoolIds: [],
		},
		createdAt: new Date(now - 30 * 86_400_000).toISOString(),
		updatedAt: new Date(now).toISOString(),
	};
}

export function demoCredentials(now = Date.now()) {
	return [
		{
			id: DEMO_STORAGE_ID,
			label: "Sample storage (simulated)",
			provider: "AWS_S3",
			config: { region: "eu-west-1" },
			hasSecret: false,
			createdAt: new Date(now - 86_400_000).toISOString(),
			updatedAt: new Date(now).toISOString(),
		},
	];
}

export function demoVodPlan() {
	return encodingPlanSchema.parse(
		buildPlan({
			...structuredClone(DEFAULT_WIZARD_STATE),
			name: "Big Buck Bunny · H.264 adaptive streaming",
			accountId: DEMO_ACCOUNT_ID,
			cloudRegion: "AWS_EU_WEST_1",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: DEMO_STORAGE_ID,
					bucket: DEMO_BUCKET,
					path: "samples/big-buck-bunny-10s.mp4",
					name: "Big Buck Bunny sample",
				},
			],
			output: {
				...DEFAULT_WIZARD_STATE.output,
				credentialId: DEMO_STORAGE_ID,
				bucket: DEMO_BUCKET,
				basePath: "encodings/big-buck-bunny/",
			},
			videos: [
				{ height: 1080, bitrate: 4_500_000 },
				{ height: 720, bitrate: 2_400_000 },
				{ height: 360, bitrate: 800_000 },
			],
			audios: [{ bitrate: 128_000, rate: 48_000 }],
			manifests: { hls: true, dash: true },
		}),
	);
}

export function demoLivePlan() {
	return liveChannelPlanSchema.parse(
		buildLiveChannelPlan({
			...structuredClone(DEFAULT_LIVE_WIZARD_STATE),
			name: "Live studio · monitoring example",
			accountId: DEMO_ACCOUNT_ID,
			cloudRegion: "AWS_EU_WEST_1",
			encoderVersion: "STABLE",
			segmentLength: 2,
			output: {
				...DEFAULT_LIVE_WIZARD_STATE.output,
				credentialId: DEMO_STORAGE_ID,
				bucket: DEMO_BUCKET,
				basePath: "live/studio/",
			},
			videos: [
				{
					codec: "H264",
					width: 1920,
					height: 1080,
					bitrate: 4_500_000,
					presetConfiguration: "LIVE_STANDARD",
					h264: { rate: 30 },
				},
				{
					codec: "H264",
					width: 1280,
					height: 720,
					bitrate: 2_400_000,
					presetConfiguration: "LIVE_STANDARD",
					h264: { rate: 30 },
				},
			],
		}),
	);
}

function completedSteps(
	operations: ReturnType<typeof compilePlan>,
	now: number,
) {
	return operations.map((operation, index) => ({
		...operation,
		status: "DONE",
		resourceId: `demo-resource-${index + 1}`,
		startedAt: new Date(now - 45_000 + index * 500).toISOString(),
		finishedAt: new Date(now - 44_800 + index * 500).toISOString(),
		request: operation.payload,
		response: { id: `demo-resource-${index + 1}`, status: "FINISHED" },
	}));
}

export function vodRecord(
	id: string,
	rawPlan: unknown,
	now: number,
	status = "FINISHED",
): DemoRecord {
	const plan = encodingPlanSchema.parse(rawPlan);
	const stepLog = completedSteps(compilePlan(plan), now);
	return {
		id,
		name: plan.name,
		labels: ["demo", "Big Buck Bunny"],
		status,
		region: plan.bitmovin.cloudRegion,
		bitmovinAccountId: DEMO_ACCOUNT_ID,
		bitmovinEncodingId: null,
		doneSteps:
			status === "FINISHED" ? stepLog.length : Math.floor(stepLog.length / 2),
		totalSteps: stepLog.length,
		cancelRequested: false,
		error: null,
		createdAt: new Date(now - 60_000).toISOString(),
		updatedAt: new Date(now).toISOString(),
		finishedAt: status === "FINISHED" ? new Date(now).toISOString() : null,
		encodingTimes: {
			queuedAt: new Date(now - 60_000).toISOString(),
			runningAt: new Date(now - 45_000).toISOString(),
		},
		plan,
		stepLog,
		snapshots: {},
		qcVerdict: null,
		playbackLinks: [],
		credentialRefs: {
			[DEMO_STORAGE_ID]: {
				label: "Sample storage (simulated)",
				provider: "AWS_S3",
			},
		},
	};
}

export function demoJobs(now = Date.now()): DemoRecord[] {
	const main = demoVodPlan();
	return [
		vodRecord(DEMO_VOD_JOB_ID, main, now - 18 * 60_000),
		vodRecord(
			"00000000-0000-4000-8000-000000000102",
			{ ...main, name: "Big Buck Bunny · delivery review" },
			now - 65 * 60_000,
		),
		vodRecord(
			"00000000-0000-4000-8000-000000000103",
			{ ...main, name: "Big Buck Bunny · ladder experiment" },
			now - 130 * 60_000,
		),
	];
}

export function heartbeatRaw(now: number, connected = true) {
	const timestamp = new Date(now).toISOString();
	return {
		timestamp,
		status: "RUNNING",
		ingest: {
			status: connected ? "CONNECTED" : "DISCONNECTED",
			healthy: connected,
			streams: [
				{
					streamId: "0",
					mediaType: "VIDEO",
					codec: "H264",
					bitrate: 5_800_000,
					incomingBitrate: 725_000,
					rate: 30,
					width: 1920,
					height: 1080,
					keyFrameIntervalAvg: 2000,
					keyFrameIntervalMax: 2001,
					keyFrameIntervalAvgLastMinute: 2000,
					keyFrameIntervalMaxLastMinute: 2001,
				},
				{
					streamId: "1",
					mediaType: "AUDIO",
					codec: "AAC",
					bitrate: 128_000,
					incomingBitrate: 16_000,
					sampleRate: 48_000,
				},
			],
			droppedPacketsVideo: 2,
			droppedPacketsAudio: 0,
			corruptPacketsVideo: 0,
			corruptPacketsAudio: 0,
		},
		events: [
			{
				time: new Date(now - 18 * 60_000).toISOString(),
				details: {
					eventType: "INPUT_CONNECTED",
					message: "Simulated input connected",
				},
			},
		],
		output: {
			manifests: {
				hls: [
					{ manifestUpdates: [{ manifestUpdateWallClockTime: timestamp }] },
				],
			},
		},
	};
}

export function liveRecord(
	id: string,
	rawPlan: unknown,
	now: number,
	status = "RUNNING",
): DemoRecord {
	const plan = liveChannelPlanSchema.parse(rawPlan);
	const stepLog = completedSteps(compileLiveChannel(plan), now);
	const running = status === "RUNNING";
	const at = new Date(now).toISOString();
	const started = new Date(now - 18 * 60_000).toISOString();
	const runId =
		id === DEMO_LIVE_CHANNEL_ID ? "00000000-0000-4000-8000-000000000211" : id;
	const raw = heartbeatRaw(now, running);
	const sample = {
		at,
		raw,
		deltas: {
			droppedPacketsVideo: 0,
			droppedPacketsAudio: 0,
			corruptPacketsVideo: 0,
			corruptPacketsAudio: 0,
		},
	};
	return {
		id,
		name: plan.name,
		status,
		error: null,
		bitmovinEncodingId: `demo-encoding-${id}`,
		bitmovinAccountId: DEMO_ACCOUNT_ID,
		createdAt: started,
		updatedAt: at,
		serverNow: at,
		plan,
		stepLog,
		streamKey: "demo-stream-key",
		encoderIp: "203.0.113.10",
		programStartAt: null,
		programEndAt: null,
		maxRunMinutes: null,
		lastHeartbeat: sample,
		liveToVod: null,
		playbackLinks: [],
		technicalDetailsAllowed: false,
		nextSchedule: null,
		health: {
			heartbeat: { at, raw: { ingest: raw.ingest } },
			openAlerts: 0,
			activeFeeders: 0,
			erroredFeeders: 0,
			origin: {
				observed: running ? 2 : 0,
				stale: 0,
				endlist: 0,
				unavailableReason: null,
			},
			runningSince: started,
			endedAt: running ? null : at,
			maxRunMinutes: null,
			provider: {
				providerStatus: running ? "RUNNING" : "FINISHED",
				providerStatusObservedAt: at,
				providerUnknownSince: null,
				providerTerminalAt: running ? null : at,
			},
		},
		heartbeatReception: {
			state: "available",
			runId,
			configuredIntervalS: 20,
			registration: {
				mode: "PER_ENCODING",
				requestedEncoderVersion: "STABLE",
				resolvedEncoderVersion: "STABLE",
				status: "ACTIVE",
			},
			latest: { receivedAt: at, sampledAt: at, raw },
			previous: {
				receivedAt: new Date(now - 20_000).toISOString(),
				sampledAt: new Date(now - 20_000).toISOString(),
				raw: heartbeatRaw(now - 20_000, running),
			},
			previousReceivedAt: new Date(now - 20_000).toISOString(),
		},
		currentRun: {
			id: runId,
			seq: 1,
			status,
			cancelRequested: false,
			bitmovinEncodingId: `demo-encoding-${id}`,
			encoderIp: "203.0.113.10",
			streamKey: "demo-stream-key",
			outputPrefix: "live/studio/",
			runningSince: started,
			endedAt: running ? null : at,
			programStartAt: null,
			programEndAt: null,
			error: null,
			lastHeartbeat: sample,
			lastHeartbeatAt: at,
			stepLog,
			liveToVod: null,
			originObservation: null,
			createdAt: started,
			queueSeconds: 14,
			providerStatus: running ? "RUNNING" : "FINISHED",
			providerStatusObservedAt: at,
			providerUnknownSince: null,
			providerTerminalAt: running ? null : at,
		},
	};
}

export function demoChannels(now = Date.now()): DemoRecord[] {
	const plan = demoLivePlan();
	return [
		liveRecord(DEMO_LIVE_CHANNEL_ID, plan, now),
		liveRecord(
			"00000000-0000-4000-8000-000000000202",
			{ ...plan, name: "Event channel · previous broadcast" },
			now - 3_600_000,
			"STOPPED",
		),
	];
}

export function demoHealth(row: DemoRecord, now: number) {
	const run = row.currentRun as DemoRecord;
	const active = row.status === "RUNNING";
	const from = Math.min(Date.parse(String(run.createdAt)), now - 60_000);
	const points = Array.from({ length: 37 }, (_, index) => ({
		atMs: from + ((now - from) * index) / 36,
		ingest: active && index !== 12,
		encoder: active,
		output: active && index !== 12,
	}));
	const lanes = active ? [{ fromMs: from, toMs: now }] : [];
	return {
		points,
		latest: points.at(-1),
		lanes: { ingest: lanes, encoder: lanes, output: lanes },
		run: {
			id: run.id,
			seq: run.seq,
			status: row.status,
			createdAt: run.createdAt,
			queueSeconds: 14,
		},
		truncated: false,
		outputObservable: true,
		timeline: {
			window: { startMs: from, ...(active ? {} : { endMs: now }) },
			events: [
				{ kind: "START_REQUESTED", atMs: from, source: "run" },
				{ kind: "ENCODER_RUNNING", atMs: from + 14_000, source: "run" },
				{ kind: "INPUT_CONNECTED", atMs: from + 18_000, source: "heartbeat" },
				{ kind: "OUTPUT_ACTIVE", atMs: from + 20_000, source: "heartbeat" },
			],
		},
		laneSources: { push: true, pushTruncated: false },
	};
}

export function demoHeartbeatHistory(now: number) {
	return {
		windowMinutes: 120,
		source: "push",
		points: Array.from({ length: 37 }, (_, index) => ({
			at: new Date(now - (36 - index) * 30_000).toISOString(),
			ingestStatus: index === 12 ? "DISCONNECTED" : "CONNECTED",
			droppedPacketsVideo: index === 12 ? 2 : 0,
			droppedPacketsAudio: 0,
			corruptPacketsVideo: 0,
			corruptPacketsAudio: 0,
			incomingBitrate: 5_800_000 + Math.sin(index) * 150_000,
			fps: 30,
			bitrate: 5_800_000,
		})),
	};
}

export function demoUsage(from: string, to: string, now = Date.now()) {
	const start = Date.parse(`${from}T00:00:00.000Z`);
	const end = Date.parse(`${to}T00:00:00.000Z`);
	const count = Math.min(
		366,
		Math.max(0, Math.floor((end - start) / 86_400_000) + 1),
	);
	const rows: UsageDayRow[] = [];
	for (let index = 0; index < count; index += 1) {
		const date = new Date(start + index * 86_400_000)
			.toISOString()
			.slice(0, 10);
		for (const kind of ["VOD", "LIVE"] as const) {
			const minutes = Math.round(
				(kind === "VOD" ? 140 : 80) + Math.sin(index * 0.7) * 35,
			);
			rows.push({
				bitmovinAccountId: DEMO_ACCOUNT_ID,
				date,
				kind,
				bytesEncoded: minutes * 8_000_000,
				timeEncodedS: minutes * 60,
				bytesEgress: minutes * 5_000_000,
				billableMinutes: minutes,
				breakdown: {
					buckets: {
						SD: minutes * 0.2,
						HD: minutes * 0.8,
						UHD: 0,
						AUDIO: 0,
						UNKNOWN: 0,
					},
					liveHdUnits: kind === "LIVE" ? 1 : 0,
					transmuxingMinutes: 0,
					featureMinutes: 0,
					streams: [
						{
							codec: "H264",
							resolution: "HD",
							encodedSeconds: minutes * 60,
							billableMinutes: minutes,
						},
					],
					features: [],
					egress: [
						{
							category: "OUTPUT",
							outputType: "S3",
							region: "eu-west-1",
							bytes: minutes * 5_000_000,
						},
					],
				},
			});
		}
	}
	return buildUsageSeries({
		from,
		to,
		rows,
		accounts: [{ id: DEMO_ACCOUNT_ID, label: "Demo account (simulated)" }],
		accountIds: [DEMO_ACCOUNT_ID],
		cursors: ["VOD", "LIVE"].map((kind) => ({
			bitmovinAccountId: DEMO_ACCOUNT_ID,
			kind: kind as "VOD" | "LIVE",
			sweptThrough: to,
			sweptAt: new Date(now),
		})),
	});
}

/** Illustrative scores for exploring the report UI, not measured results. */
export function demoVmafReport(now = Date.now()) {
	const results = [
		{ height: 1080, bitrate: 4_500_000, base: 96 },
		{ height: 720, bitrate: 2_400_000, base: 91 },
		{ height: 360, bitrate: 800_000, base: 78 },
	].map(({ height, bitrate, base }, index) => {
		const frames = Array.from({ length: 240 }, (_, frameNum) => ({
			frameNum,
			vmaf:
				base +
				Math.sin(frameNum / 17) * 1.3 -
				(frameNum > 125 && frameNum < 150 ? 3 : 0),
		}));
		const pooled = computePooled(frames);
		return {
			id: `demo-quality-${index}`,
			renditionRef: { label: `${height}p`, height, bitrate },
			pooled,
			frames: frames.map((frame) => ({
				...frame,
				...(frame.frameNum === pooled.worstFrame.frameNum
					? { worst: true }
					: {}),
			})),
			frameCount: frames.length,
			preview: { unavailableReason: "MISSING_PROVENANCE" },
		};
	});
	return {
		id: DEMO_VMAF_JOB_ID,
		encodingJobId: DEMO_VOD_JOB_ID,
		encodingName: "Illustrative quality report · Big Buck Bunny",
		mode: "VOD",
		model: "vmaf_v0.6.1",
		scoringVersion: VMAF_SCORING_VERSION,
		subsample: null,
		status: "FINISHED",
		error: null,
		totalUnits: 3,
		doneUnits: 3,
		cores: 4,
		threads: 2,
		concurrency: 2,
		createdAt: new Date(now - 12 * 60_000).toISOString(),
		updatedAt: new Date(now - 11 * 60_000).toISOString(),
		reference: { width: 1920, height: 1080, fps: 24 },
		results,
	};
}
