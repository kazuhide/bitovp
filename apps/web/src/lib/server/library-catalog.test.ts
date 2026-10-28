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
it.each([
	"MP4",
	"WEBM",
] as const)("supports %s while preserving manifest preference and refusing unavailable links", (kind) => {
	const file = { kind, url: `https://media.test/video.${kind.toLowerCase()}` };
	expect(catalogPreview([file], null)).toEqual({ ...file, time: 5 });
	expect(catalogPreview([file, links[0]], null)?.kind).toBe("DASH");
	expect(
		catalogPreview([{ ...file, reason: { code: "INSECURE_HTTP" } }], null),
	).toBeUndefined();
});
it.each([
	"MP4",
	"WEBM",
] as const)("allows only the local library media endpoint as a relative %s source", (kind) => {
	const url = `/api/library/sources/a1111111-1111-4111-8111-111111111111/media?key=${kind.toLowerCase()}%3Avideo`;
	expect(catalogPreview([{ kind, url }], null)?.url).toBe(url);
	for (const invalid of [
		"//other.example/video.webm",
		"/api/credentials",
		`${url}&url=https://other.example`,
		"/video.webm",
	])
		expect(catalogPreview([{ kind, url: invalid }], null)).toBeUndefined();
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
		"00000000-0000-4000-8000-000000000001",
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
it.each([
	"MP4",
	"WEBM",
] as const)("includes private %s without a thumbnail, retains analysis-only data and strips private locators", async (kind) => {
	const privateFile = {
		...asset(0),
		fileOutputs: [
			{
				key: `${kind.toLowerCase()}:video`,
				kind,
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "private-bucket",
				path: `output/video.${kind.toLowerCase()}`,
			},
		],
		playbackLinks: [
			{
				key: `${kind.toLowerCase()}:video`,
				kind,
				label: kind,
				url: null,
				path: `output/video.${kind.toLowerCase()}`,
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
		privateFile,
		analysisOnly,
		unsupported,
	]);
	const result = await listContents(
		prisma,
		listQuery.parse({}),
		"00000000-0000-4000-8000-000000000001",
	);
	expect(result.counts).toEqual({ all: 3, playback: 1, metadata: 2 });
	expect(result.items[0]?.catalogMetadata?.formats).toEqual([kind]);
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
		await listContents(
			prisma,
			listQuery.parse({ playback: "metadata" }),
			"00000000-0000-4000-8000-000000000001",
		),
	).toMatchObject({
		total: 0,
		items: [],
		counts: { all: 1, playback: 1, metadata: 0 },
	});
});
