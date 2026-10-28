import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { expect, it, vi } from "vitest";

vi.mock("./context", () => ({ getServerContext: vi.fn() }));

import { listContents, sourceView } from "./library";
import {
	enrichLibraryPlayback,
	libraryFileOutputsForSource,
} from "./library-playback";

const plan = encodingPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
			),
			"utf8",
		),
	),
);
plan.muxings = [
	{
		key: "mp4",
		kind: "MP4",
		streamKey: "v360",
		filename: "video.mp4",
		destination: {
			outputKey: "origin",
			path: "output/",
			acl: "PUBLIC_READ",
		},
	},
];
plan.manifests = [];
const planHash = createHash("sha256")
	.update(JSON.stringify(plan))
	.digest("hex");
const stored = {
	key: "old",
	kind: "HLS" as const,
	label: "Retained",
	url: "https://old.example/a.m3u8",
	path: "a.m3u8",
	via: "derived",
};
const sourceId = "a1111111-1111-4111-8111-111111111111";
const source = { sourceId, jobId: "job-1", planHash, playbackLinks: [stored] };
const fileOutputs = [
	{
		key: "mp4:mp4",
		kind: "MP4" as const,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "sample-output-bucket",
		path: "output/video.mp4",
	},
];
const mediaUrl = `/api/library/sources/${sourceId}/media?key=mp4%3Amp4`;
function database(jobs = [{ id: "job-1", plan }]) {
	const db = {
		$transaction: vi.fn(async function <T>(
			this: AppPrismaClient,
			callback: (tx: AppPrismaClient) => Promise<T>,
		) {
			return callback(this);
		}),
		encodingJob: { findMany: vi.fn(async () => jobs) },
		credential: {
			findMany: vi.fn(async () => [
				{
					id: plan.outputs[0]?.credentialId,
					provider: "AWS_S3",
					config: { region: "ap-northeast-1", privateExtra: "never-expose" },
				},
			]),
		},
	};
	return { db, prisma: db as unknown as AppPrismaClient };
}
function catalogQueries(items: Record<string, unknown>[]) {
	return vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
		if (sql.join("").includes("AS candidates"))
			return [
				{
					candidates: items,
					scanned: items.length,
					cursorId: items.at(-1)?.id,
					cursorUpdatedAt: new Date(0),
				},
			];
		const ids = values[0] as string[];
		const fields = [
			"id",
			"title",
			"description",
			"tags",
			"locale",
			"revision",
			"archived",
			"updatedAt",
			"analysisSummary",
		];
		return [
			{
				items: items
					.filter((item) => ids.includes(item.id as string))
					.map((item) =>
						Object.fromEntries(fields.map((key) => [key, item[key]])),
					),
			},
		];
	});
}
it("adds legacy MP4 links in batches while preserving stored manifests and narrowing credential reads", async () => {
	const { db, prisma } = database();
	const result = await enrichLibraryPlayback(prisma, [source, source]);
	expect(result[0]).toEqual([
		stored,
		expect.objectContaining({
			kind: "MP4",
			url: mediaUrl,
		}),
	]);
	expect(result[1]).toEqual(result[0]);
	expect(db.encodingJob.findMany).toHaveBeenCalledTimes(1);
	expect(db.encodingJob.findMany).toHaveBeenCalledWith({
		where: { id: { in: ["job-1"] } },
		select: { id: true, plan: true },
	});
	expect(db.credential.findMany).toHaveBeenCalledTimes(1);
	expect(db.credential.findMany).toHaveBeenCalledWith({
		where: { id: { in: [plan.outputs[0]?.credentialId] } },
		select: { id: true, provider: true, config: true },
	});
	expect(JSON.stringify(result)).not.toContain("never-expose");
	expect(source.playbackLinks).toEqual([stored]);
});
it("does not invent outputs for a deleted job or changed plan", async () => {
	const { db, prisma } = database();
	expect(
		await enrichLibraryPlayback(prisma, [{ ...source, jobId: null }]),
	).toEqual([[stored]]);
	expect(db.encodingJob.findMany).not.toHaveBeenCalled();
	expect(
		await enrichLibraryPlayback(prisma, [{ ...source, planHash: "changed" }]),
	).toEqual([[stored]]);
	expect(db.credential.findMany).not.toHaveBeenCalled();
	const missing = database([]);
	expect(await enrichLibraryPlayback(missing.prisma, [source])).toEqual([
		[stored],
	]);
});
it("keeps already captured MP4 URLs and does not read live job data", async () => {
	const { db, prisma } = database();
	const playbackLinks = [
		{
			...stored,
			kind: "MP4" as const,
			url: "https://retained.example/video.mp4",
		},
	];
	expect(
		await enrichLibraryPlayback(prisma, [{ ...source, playbackLinks }]),
	).toEqual([playbackLinks]);
	expect(db.encodingJob.findMany).not.toHaveBeenCalled();
	expect(db.credential.findMany).not.toHaveBeenCalled();
});
it("projects legacy MP4 on source detail without modifying the retained snapshot", async () => {
	const { db } = database();
	const snapshot = {
		schemaVersion: 1,
		kind: "VOD_JOB",
		name: "Old asset",
		planHash,
		identity: "UNVERIFIED",
		inputs: [],
		playbackLinks: [],
		qcVerdict: null,
		qcOverriddenAt: null,
	};
	const before = JSON.stringify(snapshot);
	const prisma = {
		...db,
		librarySource: {
			findUnique: vi.fn(async () => ({
				id: sourceId,
				jobId: "job-1",
				originalJobId: "job-1",
				state: "READY",
				error: null,
				locales: [],
				snapshot,
			})),
		},
		contentRevision: { findMany: vi.fn(async () => []) },
	} as unknown as AppPrismaClient;
	const view = await sourceView(prisma, sourceId);
	expect(view.snapshot.playbackLinks).toEqual([
		expect.objectContaining({ kind: "MP4" }),
	]);
	expect(JSON.stringify(snapshot)).toBe(before);
	expect(JSON.stringify(view)).not.toContain("never-expose");
});
it("projects legacy MP4 catalog previews in one batch and strips internal projection data", async () => {
	const { db } = database();
	const item = {
		id: "content-1",
		title: "Old asset",
		description: "",
		tags: [],
		locale: "und",
		revision: 1,
		archived: false,
		updatedAt: "2026-09-30",
		playbackLinks: [],
		analysisSummary: null,
		sourceJobId: "job-1",
		sourceId,
		planHash,
	};
	const prisma = {
		...db,
		$queryRaw: catalogQueries([item, { ...item, id: "content-2" }]),
	} as unknown as AppPrismaClient;
	const result = await listContents(prisma, {
		q: "",
		archived: "false",
		offset: 0,
	});
	expect(result.items.map((entry) => entry.catalogPreview?.kind)).toEqual([
		"MP4",
		"MP4",
	]);
	expect(db.encodingJob.findMany).toHaveBeenCalledTimes(1);
	expect(db.credential.findMany).toHaveBeenCalledTimes(1);
	expect(result.items[0]).not.toHaveProperty("sourceJobId");
	expect(result.items[0]).not.toHaveProperty("sourceId");
	expect(result.items[0]).not.toHaveProperty("planHash");
	expect(result.items[0]).not.toHaveProperty("playbackLinks");
	expect(JSON.stringify(result)).not.toContain("never-expose");
});
it.each([
	"MP4",
	"WEBM",
] as const)("retains exact stored %s locators after job deletion and projects private media without credentials", async (kind) => {
	const { db, prisma } = database();
	const files = fileOutputs.map((file) => ({
		...file,
		kind,
		key: `${kind.toLowerCase()}:mp4`,
		path: `output/video.${kind.toLowerCase()}`,
	}));
	const input = {
		...source,
		jobId: null,
		fileOutputs: files,
		playbackLinks: [
			{
				...stored,
				key: files[0]?.key ?? "",
				kind,
				url: null,
				reason: { code: "NOT_PUBLIC" },
			},
		],
	};
	expect(await libraryFileOutputsForSource(prisma, input)).toEqual(files);
	const [links] = await enrichLibraryPlayback(prisma, [input]);
	expect(links?.[0]).toMatchObject({
		url: `/api/library/sources/${sourceId}/media?key=${encodeURIComponent(files[0]?.key ?? "")}`,
		kind,
	});
	expect(links?.[0]).not.toHaveProperty("reason");
	expect(db.encodingJob.findMany).not.toHaveBeenCalled();
	expect(db.credential.findMany).not.toHaveBeenCalled();
});
it("projects a legacy concat QC WebM without direct-ingest or normal-MP4 assumptions", async () => {
	const qc = encodingPlanSchema.parse({
		...plan,
		qc: { vmaf: true, only: true },
		renditions: [
			{
				key: "v360",
				codec: "VP9",
				mode: "STANDARD",
				ingestKey: "clip",
				width: 640,
				height: 360,
				bitrate: 350000,
				rate: 24,
			},
		],
		trimmingStreams: [
			{
				key: "piece",
				kind: "TIME_BASED",
				sourceKey: "video",
				offset: 0,
				duration: 2,
			},
		],
		concatenationStreams: [
			{
				key: "clip",
				sources: [{ sourceKey: "piece", position: 0, isMain: true }],
			},
		],
		muxings: [
			{
				key: "segmented",
				kind: "WEBM",
				streamKey: "v360",
				destination: { outputKey: "origin", path: "output/", acl: "PRIVATE" },
			},
		],
	});
	const { db, prisma } = database([{ id: "job-1", plan: qc }]);
	const input = {
		...source,
		planHash: createHash("sha256").update(JSON.stringify(qc)).digest("hex"),
		playbackLinks: [],
	};
	const [links] = await enrichLibraryPlayback(prisma, [input]);
	expect(links?.[0]).toMatchObject({
		kind: "WEBM",
		key: "qc-webm:v360",
		url: `/api/library/sources/${sourceId}/media?key=qc-webm%3Av360`,
	});
	expect(db.credential.findMany).toHaveBeenCalledWith(
		expect.objectContaining({
			where: { id: { in: [qc.outputs[0]?.credentialId] } },
		}),
	);
});

it("classifies legacy private MP4 beyond the first page with one batched plan and credential read", async () => {
	const { db } = database();
	const items = Array.from({ length: 30 }, (_, index) => ({
		id: `content-${index}`,
		title: "Retained asset",
		description: "",
		tags: [],
		locale: "und",
		revision: 1,
		archived: false,
		updatedAt: "2026-10-04",
		playbackLinks: [],
		analysisSummary: null,
		sourceJobId: index >= 28 ? "job-1" : null,
		sourceId,
		planHash,
	}));
	const prisma = {
		...db,
		$queryRaw: catalogQueries(items),
	} as unknown as AppPrismaClient;
	const result = await listContents(prisma, {
		q: "",
		archived: "false",
		offset: 0,
		playback: "playback",
	});
	expect(result.counts).toEqual({ all: 30, playback: 2, metadata: 28 });
	expect(result.total).toBe(2);
	expect(result.items.map((item) => item.id)).toEqual([
		"content-28",
		"content-29",
	]);
	expect(result.items.map((item) => item.catalogMetadata.formats)).toEqual([
		["MP4"],
		["MP4"],
	]);
	expect(db.encodingJob.findMany).toHaveBeenCalledOnce();
	expect(db.credential.findMany).toHaveBeenCalledOnce();
});
it("resolves legacy media locators only from the identical retained job plan", async () => {
	const { prisma } = database();
	expect(await libraryFileOutputsForSource(prisma, source)).toEqual(
		fileOutputs,
	);
	expect(
		await libraryFileOutputsForSource(prisma, {
			...source,
			planHash: "different",
		}),
	).toEqual([]);
	expect(
		await libraryFileOutputsForSource(prisma, { ...source, jobId: null }),
	).toEqual([]);
});
it("does not expose private file coordinates in source detail after job deletion", async () => {
	const { db } = database();
	const snapshot = {
		schemaVersion: 1,
		kind: "VOD_JOB",
		name: "Private asset",
		planHash,
		identity: "UNVERIFIED",
		inputs: [],
		fileOutputs,
		playbackLinks: [
			{
				...stored,
				key: "mp4:mp4",
				kind: "MP4",
				url: null,
				reason: { code: "NOT_PUBLIC" },
			},
		],
		qcVerdict: null,
		qcOverriddenAt: null,
	};
	const prisma = {
		...db,
		librarySource: {
			findUnique: vi.fn(async () => ({
				id: sourceId,
				jobId: null,
				originalJobId: "job-1",
				state: "READY",
				error: null,
				locales: [],
				snapshot,
			})),
		},
		contentRevision: { findMany: vi.fn(async () => []) },
	} as unknown as AppPrismaClient;
	const view = await sourceView(prisma, sourceId);
	expect(view.snapshot.playbackLinks[0]?.url).toBe(mediaUrl);
	expect(view.snapshot).not.toHaveProperty("fileOutputs");
	expect(JSON.stringify(view)).not.toContain("sample-output-bucket");
	expect(JSON.stringify(view)).not.toContain(fileOutputs[0]?.credentialId);
	expect(db.encodingJob.findMany).not.toHaveBeenCalled();
});
