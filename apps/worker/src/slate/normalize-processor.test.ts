import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkOps } from "../orchestrator/sdk-ops";
import {
	createSlateNormalizeProcessor,
	createSlateNormalizePromoter,
	SLATE_NORMALIZE_STALE_CLAIM_MS,
	slateNormalizationMarker,
} from "./normalize-processor";
import type { PreparedSlate, SlatePreparer } from "./prepare";

const loadChannelIngestMedia = vi.fn();
vi.mock("../orchestrator/live-processor", () => ({
	loadChannelIngestMedia: (...args: unknown[]) =>
		loadChannelIngestMedia(...args),
}));

const ROW_ID = "6f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CRED_ID = "3e7a9b1c-0d2f-4e5a-8b6c-7d8e9f0a1b2c";
const ENCODING_ID = "enc-1";

type Row = {
	id: string;
	liveChannelId: string;
	bitmovinAccountId: string;
	name: string | null;
	credentialId: string;
	bucket: string;
	sourceKey: string;
	status: string;
	target: unknown;
	note: string | null;
	error: string | null;
	registeredKey: string | null;
	normalized: boolean;
	insertableContentId: string | null;
	updatedAt: Date;
};

function makeWorld(over: {
	row?: Partial<Row>;
	channel?: { status: string; bitmovinEncodingId: string | null } | null;
	plan?: unknown;
	prepared?: PreparedSlate;
	contentStatuses?: string[];
	existing?: {
		id: string;
		name: string | null;
		status: string;
		description: string | null;
	}[];
}) {
	const now = new Date("2026-09-13T12:00:00Z");
	const row: Row = {
		id: ROW_ID,
		liveChannelId: CHANNEL_ID,
		bitmovinAccountId: ACCOUNT_ID,
		name: "brb",
		credentialId: CRED_ID,
		bucket: "b",
		sourceKey: "slates/brb.mp4",
		status: "QUEUED",
		target: null,
		note: null,
		error: null,
		registeredKey: null,
		normalized: false,
		insertableContentId: null,
		updatedAt: now,
		...over.row,
	};
	const statuses = [...(over.contentStatuses ?? ["READY"])];
	const sdk = {
		createS3Input: vi.fn(async () => "input-1"),
		createLiveInsertableContent: vi.fn(async () => "content-1"),
		getLiveInsertableContent: vi.fn(async (_e: string, id: string) => ({
			id,
			status: statuses.length > 1 ? (statuses.shift() as string) : statuses[0],
		})),
		listLiveInsertableContent: vi.fn(async () => over.existing ?? []),
	} as unknown as SdkOps;
	const matches = (where: Record<string, unknown>) => {
		if (where.id !== row.id) return false;
		const or = where.OR as
			| { status: { in: string[] }; updatedAt?: { lt: Date } }[]
			| undefined;
		if (!or) return true;
		return or.some(
			(clause) =>
				clause.status.in.includes(row.status) &&
				(clause.updatedAt === undefined || row.updatedAt < clause.updatedAt.lt),
		);
	};
	const prisma = {
		slateNormalization: {
			findUnique: vi.fn(async () => ({ ...row })),
			updateMany: vi.fn(
				async (args: {
					where: Record<string, unknown>;
					data: Partial<Row>;
				}) => {
					if (!matches(args.where)) return { count: 0 };
					Object.assign(row, args.data, {
						updatedAt: new Date(now.getTime() + 1),
					});
					return { count: 1 };
				},
			),
			update: vi.fn(async (args: { data: Partial<Row> }) => {
				Object.assign(row, args.data);
				return { ...row };
			}),
			findMany: vi.fn(async () => []),
		},
		liveChannel: {
			findUnique: vi.fn(async () =>
				over.channel === null
					? null
					: {
							status: over.channel?.status ?? "RUNNING",
							bitmovinEncodingId:
								over.channel?.bitmovinEncodingId === undefined
									? ENCODING_ID
									: over.channel.bitmovinEncodingId,
							lastHeartbeat: null,
							plan: over.plan ?? null,
						},
			),
		},
	} as unknown as AppPrismaClient;
	const prepare = vi.fn(
		async (_args: Parameters<SlatePreparer>[0]) =>
			over.prepared ?? {
				kind: "READY" as const,
				source: {
					credentialId: CRED_ID,
					bucket: "b",
					key: "slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
				},
				normalized: true,
				target: {
					width: 1280,
					height: 720,
					frameRate: 30,
					sampleRate: 48000,
					channels: 2,
					channelsAssumed: true,
				},
				note: "converted to MPEG-TS (container)",
			},
	);
	let clock = now.getTime();
	const deps = {
		prisma,
		prepare,
		revealBitmovinAccount: vi.fn(async () => ({
			apiKey: "k",
			tenantOrgId: null,
		})),
		makeSdk: vi.fn(() => sdk),
		resolveCredential: vi.fn(async () => ({
			provider: "AWS_S3",
			config: {},
			secret: { accessKeyId: "ak", secretAccessKey: "sk" },
		})),
		now: () => {
			clock += 1_000;
			return new Date(clock);
		},
		sleep: async () => {},
		pollIntervalMs: 1,
		registrationTimeoutMs: 10_000,
	};
	return { row, sdk, prisma, prepare, deps };
}

beforeEach(() => {
	vi.clearAllMocks();
	loadChannelIngestMedia.mockResolvedValue(null);
});

describe("createSlateNormalizeProcessor", () => {
	it("QUEUED → NORMALIZING → REGISTERING → READY: registers the prepared key under the row's marker and links the content id", async () => {
		const { row, sdk, prepare, prisma, deps } = makeWorld({});
		const result = await createSlateNormalizeProcessor(deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(result).toEqual({
			acknowledged: true,
			slateNormalizationId: ROW_ID,
			status: "READY",
		});
		expect(prepare).toHaveBeenCalledWith({
			label: ROW_ID,
			source: { credentialId: CRED_ID, bucket: "b", key: "slates/brb.mp4" },
			ingest: null,
			destination: null,
			onProgress: expect.any(Function),
		});
		expect(sdk.createS3Input).toHaveBeenCalledWith(
			expect.objectContaining({ name: `slate-src:${ROW_ID}`, bucketName: "b" }),
		);
		expect(sdk.createLiveInsertableContent).toHaveBeenCalledWith(ENCODING_ID, {
			name: "brb",
			description: `${slateNormalizationMarker(ROW_ID)}; converted to MPEG-TS (container)`,
			inputs: [
				{
					inputId: "input-1",
					inputPath: "slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
				},
			],
		});
		expect(row).toMatchObject({
			status: "READY",
			insertableContentId: "content-1",
			registeredKey: "slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
			registeredBucket: null,
			normalized: true,
			note: "converted to MPEG-TS (container)",
			error: null,
		});
		// A progress touch refreshes the row (its updatedAt is the claim's lease).
		const onProgress = (
			prepare.mock.calls[0]?.[0] as {
				onProgress: (n: string) => Promise<void>;
			}
		).onProgress;
		await onProgress("downloaded 12 MB, converting to MPEG-TS");
		expect(
			(
				prisma.slateNormalization.update as ReturnType<typeof vi.fn>
			).mock.calls.some(
				(c) =>
					(c[0] as { data: { note?: string } }).data.note ===
					"downloaded 12 MB, converting to MPEG-TS",
			),
		).toBe(true);
	});

	it("with an S3 output in the plan, the preparer gets the destination and the row records the other bucket", async () => {
		const plan = {
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
		};
		const { row, sdk, prepare, deps } = makeWorld({
			plan,
			prepared: {
				kind: "READY",
				source: {
					credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
					bucket: "channel-output",
					key: "chan-1/archive/slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
				},
				normalized: true,
				target: null,
				note: "converted → channel-output/…",
			},
		});
		await createSlateNormalizeProcessor(deps)({ slateNormalizationId: ROW_ID });
		expect(
			(prepare.mock.calls[0]?.[0] as { destination: unknown }).destination,
		).toEqual({
			credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
			bucket: "channel-output",
			keyPrefix: "chan-1/archive/slates",
			outputKey: "archive-s3",
		});
		expect(sdk.createS3Input).toHaveBeenCalledWith(
			expect.objectContaining({ bucketName: "channel-output" }),
		);
		expect(deps.resolveCredential).toHaveBeenCalledWith(
			"4c885bd1-33ef-47b0-9506-3b765f91f324",
		);
		expect(row).toMatchObject({
			status: "READY",
			registeredBucket: "channel-output",
			registeredKey:
				"chan-1/archive/slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
		});
	});

	it("a movie with no reference parks the row in WAITING_FOR_INPUT and creates nothing at the provider", async () => {
		const { row, sdk, deps } = makeWorld({
			prepared: {
				kind: "WAIT",
				note: "waiting for the live input (ingest reference not known yet)",
			},
		});
		const result = await createSlateNormalizeProcessor(deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(result.status).toBe("WAITING_FOR_INPUT");
		expect(row).toMatchObject({
			status: "WAITING_FOR_INPUT",
			note: "waiting for the live input (ingest reference not known yet)",
		});
		expect(sdk.createLiveInsertableContent).not.toHaveBeenCalled();
	});

	it("a WAITING_FOR_INPUT row is claimable again (the promoter's re-queue)", async () => {
		const { row, deps } = makeWorld({ row: { status: "WAITING_FOR_INPUT" } });
		const result = await createSlateNormalizeProcessor(deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(result.status).toBe("READY");
		expect(row.status).toBe("READY");
	});

	it("a REFUSED preparation is the row's ERROR, with the reason", async () => {
		const { row, deps } = makeWorld({
			prepared: { kind: "REFUSED", reason: "the file carries no video stream" },
		});
		const result = await createSlateNormalizeProcessor(deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(result.status).toBe("ERROR");
		expect(row).toMatchObject({
			status: "ERROR",
			error: "the file carries no video stream",
		});
	});

	it("a channel that is no longer RUNNING fails the row instead of registering on a dead encoding", async () => {
		const { row, prepare, deps } = makeWorld({
			channel: { status: "STOPPED", bitmovinEncodingId: ENCODING_ID },
		});
		await createSlateNormalizeProcessor(deps)({ slateNormalizationId: ROW_ID });
		expect(row.status).toBe("ERROR");
		expect(row.error).toContain("the channel is STOPPED");
		expect(prepare).not.toHaveBeenCalled();
	});

	it("a row already READY (or in flight and fresh) is not re-run", async () => {
		const ready = makeWorld({
			row: { status: "READY", insertableContentId: "content-0" },
		});
		const result = await createSlateNormalizeProcessor(ready.deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(result.status).toBe("READY");
		expect(ready.prepare).not.toHaveBeenCalled();
		const fresh = makeWorld({ row: { status: "NORMALIZING" } });
		await createSlateNormalizeProcessor(fresh.deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(fresh.prepare).not.toHaveBeenCalled();
	});

	it("a STALE in-flight row is re-entered, and the first attempt's content is adopted by marker", async () => {
		const { row, sdk, deps } = makeWorld({
			row: {
				status: "REGISTERING",
				updatedAt: new Date(
					Date.parse("2026-09-13T12:00:00Z") -
						SLATE_NORMALIZE_STALE_CLAIM_MS -
						1,
				),
			},
			existing: [
				{
					id: "content-9",
					name: "brb",
					status: "READY",
					description: `x; ${slateNormalizationMarker(ROW_ID)}`,
				},
			],
		});
		const result = await createSlateNormalizeProcessor(deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(result.status).toBe("READY");
		expect(sdk.createLiveInsertableContent).not.toHaveBeenCalled();
		expect(row.insertableContentId).toBe("content-9");
	});

	it("provider ERROR and a READY timeout both land on the row as ERROR", async () => {
		const errored = makeWorld({ contentStatuses: ["ERROR"] });
		await createSlateNormalizeProcessor(errored.deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(errored.row.error).toContain("could not download or process");
		const slow = makeWorld({ contentStatuses: ["CREATED"] });
		await createSlateNormalizeProcessor(slow.deps)({
			slateNormalizationId: ROW_ID,
		});
		expect(slow.row.status).toBe("ERROR");
		expect(slow.row.error).toContain("had not marked the content READY");
	});
});

describe("createSlateNormalizePromoter", () => {
	it("re-queues WAITING rows once their channel yields a full target or has stopped for good, and stale in-flight rows always", async () => {
		const rows = [
			{ id: "w1", status: "WAITING_FOR_INPUT", liveChannelId: "c1" },
			{ id: "w2", status: "WAITING_FOR_INPUT", liveChannelId: "c2" },
			{ id: "w3", status: "WAITING_FOR_INPUT", liveChannelId: "c3" },
			{ id: "s1", status: "NORMALIZING", liveChannelId: "c1" },
		];
		const prisma = {
			slateNormalization: { findMany: vi.fn(async () => rows) },
			liveChannel: {
				findUnique: vi.fn(async (args: { where: { id: string } }) =>
					args.where.id === "c3"
						? { status: "STOPPED", lastHeartbeat: null }
						: { status: "RUNNING", lastHeartbeat: null },
				),
			},
		} as unknown as AppPrismaClient;
		loadChannelIngestMedia.mockImplementation(
			async (_p: unknown, channelId: string) =>
				channelId === "c1"
					? {
							video: { width: 1280, height: 720, frameRate: 30 },
							audio: [{ sampleRate: 48000 }],
						}
					: channelId === "c2"
						? { video: { width: 1280 }, audio: [] } // heartbeat without a usable target
						: null,
		);
		const enqueue = vi.fn(async (_id: string) => {});
		const result = await createSlateNormalizePromoter({
			prisma,
			now: () => new Date(),
			enqueue,
		})();
		// w1: target known → run. w2: heartbeat without a usable target → wait
		// on. w3: channel STOPPED → run so the processor writes the error.
		expect(result).toEqual({ promoted: 3 });
		expect(enqueue.mock.calls.map((c) => c[0])).toEqual(["w1", "w3", "s1"]);
	});
});
it("inactive organization never promotes a fresh slate normalization", async () => {
	const findMany = vi.fn(),
		enqueue = vi.fn();
	const promote = createSlateNormalizePromoter({
		prisma: { slateNormalization: { findMany } } as unknown as AppPrismaClient,
		now: () => new Date(),
		enqueue,
		allowNewWork: async () => false,
	});
	expect(await promote()).toEqual({ promoted: 0 });
	expect(findMany).not.toHaveBeenCalled();
	expect(enqueue).not.toHaveBeenCalled();
});
