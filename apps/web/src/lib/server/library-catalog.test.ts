import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./context", () => ({ getServerContext: vi.fn() }));

import type { AppPrismaClient } from "@bitovp/db";
import { catalogPreview, listContents, listQuery } from "./library";

const links = [
	{ kind: "DASH", url: "https://media.test/a.mpd" },
	{ kind: "HLS", url: "https://media.test/a.m3u8" },
];
it("projects only a playable manifest and bounded thumbnail timing", () => {
	expect(
		catalogPreview(links, { duration: 100, sceneCount: 3, start: 10, end: 20 }),
	).toEqual({
		kind: "HLS",
		url: "https://media.test/a.m3u8",
		time: 13,
		duration: 100,
		sceneCount: 3,
	});
});
it("falls back without analysis and refuses credentialed or non-HTTP URLs", () => {
	expect(catalogPreview(links, null)).toMatchObject({ time: 5 });
	expect(
		catalogPreview(
			[{ kind: "HLS", url: "https://user:password@media.test/x" }],
			null,
		),
	).toBeUndefined();
	expect(
		catalogPreview([{ kind: "HLS", url: "javascript:alert(1)" }], null),
	).toBeUndefined();
	expect(catalogPreview([{ kind: "HLS", url: null }], null)).toBeUndefined();
});
it("supports MP4 while preserving manifest preference and refusing unavailable links", () => {
	const mp4 = { kind: "MP4", url: "https://media.test/video.mp4" };
	expect(catalogPreview([mp4], null)).toEqual({ ...mp4, time: 5 });
	expect(catalogPreview([mp4, links[0]], null)?.kind).toBe("DASH");
	expect(
		catalogPreview([{ ...mp4, reason: { code: "INSECURE_HTTP" } }], null),
	).toBeUndefined();
});
it("allows only the local library media endpoint as a relative MP4 source", () => {
	const url =
		"/api/library/sources/a1111111-1111-4111-8111-111111111111/media?key=mp4%3Avideo";
	expect(catalogPreview([{ kind: "MP4", url }], null)?.url).toBe(url);
	for (const invalid of [
		"//other.example/video.mp4",
		"/api/credentials",
		`${url}&url=https://other.example`,
		"/video.mp4",
	]) {
		expect(
			catalogPreview([{ kind: "MP4", url: invalid }], null),
		).toBeUndefined();
	}
});

function catalogDatabase(items: Record<string, unknown>[]) {
	const db = {
		$transaction: vi.fn(async function <T>(
			this: AppPrismaClient,
			callback: (tx: AppPrismaClient) => Promise<T>,
		) {
			return callback(this);
		}),
		$queryRaw: vi.fn(
			async (sql: TemplateStringsArray, ...values: unknown[]) => {
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
			},
		),
		encodingJob: { findMany: vi.fn(async () => []) },
		credential: { findMany: vi.fn(async () => []) },
	};
	return { db, prisma: db as unknown as AppPrismaClient };
}
function asset(index: number, playback = false) {
	return {
		id: `content-${index}`,
		title: `Asset ${index}`,
		description: "",
		tags: [],
		locale: "und",
		revision: 1,
		archived: false,
		updatedAt: "2026-10-04",
		sourceId: "a1111111-1111-4111-8111-111111111111",
		sourceJobId: null,
		planHash: "retained",
		fileOutputs: [],
		analysisSummary: null,
		playbackLinks: playback
			? [
					{
						key: "dash",
						kind: "DASH",
						label: "DASH",
						url: `https://media.test/${index}.mpd`,
						path: "video.mpd",
						via: "derived",
					},
				]
			: [],
	};
}
it("filters before pagination and counts every search/archive-scoped asset", async () => {
	const { db, prisma } = catalogDatabase(
		Array.from({ length: 60 }, (_, i) => asset(i, i >= 28)),
	);
	const result = await listContents(
		prisma,
		listQuery.parse({
			playback: "playback",
			offset: 25,
			q: "Nature_%",
			archived: "true",
		}),
	);
	expect(result.counts).toEqual({ all: 60, playback: 32, metadata: 28 });
	expect(result.total).toBe(32);
	expect(result.items.map((item) => item.id)).toEqual(
		Array.from({ length: 7 }, (_, i) => `content-${i + 53}`),
	);
	const [sql, ...values] = db.$queryRaw.mock.calls[0] as unknown as [
		TemplateStringsArray,
		...unknown[],
	];
	expect(sql.join("?")).toContain(
		'ORDER BY c."updatedAt" DESC, c.id DESC LIMIT',
	);
	expect(values).toContain(250);
	expect(sql.join("?")).toContain("c.archived =");
	expect(sql.join("?")).toContain("r.revision = c.revision");
	expect(values).toContain(true);
	expect(values).toContain("%Nature\\_\\%%");
});
it("includes private MP4 without a thumbnail, retains analysis-only data and strips private locators", async () => {
	const privateMp4 = {
		...asset(0),
		fileOutputs: [
			{
				key: "mp4:video",
				kind: "MP4",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "private-bucket",
				path: "output/video.mp4",
			},
		],
		playbackLinks: [
			{
				key: "mp4:video",
				kind: "MP4",
				label: "MP4",
				url: null,
				path: "output/video.mp4",
				via: "derived",
				reason: { code: "NOT_PUBLIC" },
			},
		],
	};
	const analysisOnly = {
		...asset(1),
		analysisSummary: { duration: 60, sceneCount: 5, start: 0, end: 8 },
	};
	const unsupported = {
		...asset(2),
		playbackLinks: [
			{
				kind: "SMOOTH",
				key: "smooth",
				label: "Smooth",
				path: "a.ism",
				url: "https://media.test/a.ism",
				via: "derived",
			},
		],
	};
	const { db, prisma } = catalogDatabase([
		privateMp4,
		analysisOnly,
		unsupported,
	]);
	const result = await listContents(prisma, listQuery.parse({}));
	expect(result.counts).toEqual({ all: 3, playback: 1, metadata: 2 });
	expect(result.items[0]?.catalogMetadata?.formats).toEqual(["MP4"]);
	expect(result.items[0]?.catalogPreview?.url).toContain(
		"/api/library/sources/",
	);
	expect(result.items[1]?.catalogMetadata).toEqual({
		formats: [],
		duration: 60,
		sceneCount: 5,
	});
	expect(result.items[1]?.catalogPreview).toBeUndefined();
	expect(JSON.stringify(result)).not.toContain("private-bucket");
	expect(JSON.stringify(result)).not.toContain("credentialId");
	expect(db.encodingJob.findMany).not.toHaveBeenCalled();
});
it("validates filter values and returns an empty filtered page with global counts", async () => {
	expect(listQuery.safeParse({ playback: "remote-reachable" }).success).toBe(
		false,
	);
	const { prisma } = catalogDatabase([asset(0, true)]);
	expect(
		await listContents(prisma, listQuery.parse({ playback: "metadata" })),
	).toMatchObject({
		total: 0,
		items: [],
		counts: { all: 1, playback: 1, metadata: 0 },
	});
});
