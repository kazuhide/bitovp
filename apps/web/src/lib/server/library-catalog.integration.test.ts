import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
	type Prisma,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listContents, listQuery } from "./library-catalog";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const at = new Date("2026-10-19T00:00:00Z");
const credentialId = "00000000-0000-4000-8000-000000000002";
const publicLink = {
	key: "hls",
	kind: "HLS",
	label: "Synthetic",
	url: "https://media.invalid/video.m3u8",
	path: "output/video.m3u8",
	via: "derived",
};
const privateLink = {
	...publicLink,
	key: "mp4:video",
	kind: "MP4",
	url: null,
	reason: { code: "NOT_PUBLIC" },
};
const fileOutput = {
	key: "mp4:video",
	kind: "MP4",
	credentialId,
	bucket: "synthetic-private-output",
	path: "output/video.mp4",
};
function snapshot(index: number): Prisma.InputJsonValue {
	return {
		planHash: "retained",
		fileOutputs: index % 3 === 1 ? [fileOutput] : [],
		playbackLinks:
			index % 3 === 2 ? [] : [index % 3 === 1 ? privateLink : publicLink],
	};
}

function instrument(
	base: AppPrismaClient,
	observed: {
		bytes: number;
		fullRows: number;
		maxBatch: number;
		batches: number;
	},
	afterBatch?: () => Promise<void>,
	afterQuery?: (args: Parameters<typeof base.$queryRaw>) => Promise<void>,
): AppPrismaClient {
	return new Proxy(base, {
		get(target, key) {
			if (key === "$transaction")
				return (
					callback: (tx: AppPrismaClient) => Promise<unknown>,
					options: unknown,
				) =>
					target.$transaction(
						(tx) =>
							callback(
								instrument(
									tx as AppPrismaClient,
									observed,
									afterBatch,
									afterQuery,
								),
							),
						options as never,
					);
			if (key === "$queryRaw")
				return async (...args: Parameters<typeof base.$queryRaw>) => {
					const result = (await base.$queryRaw(...args)) as Record<
						string,
						unknown
					>[];
					await afterQuery?.(args);
					observed.bytes += Buffer.byteLength(JSON.stringify(result));
					const rows = Array.isArray(result[0]?.candidates)
						? (result[0]?.candidates as Record<string, unknown>[])
						: Array.isArray(result[0]?.items)
							? (result[0]?.items as Record<string, unknown>[])
							: result;
					observed.fullRows += rows.filter(
						(row) => "description" in row,
					).length;
					observed.maxBatch = Math.max(observed.maxBatch, rows.length);
					if (rows.length && !Array.isArray(result[0]?.items)) {
						observed.batches++;
						if (observed.batches === 1) await afterBatch?.();
					}
					return result;
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Real tenant queries guard paging work without relying on wall-clock thresholds. */
describe.runIf(Boolean(adminUrl && appUrl))(
	"PostgreSQL catalog pagination",
	() => {
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		const organizations: string[] = [];
		beforeAll(() => {
			for (const value of [adminUrl, appUrl]) {
				if (!value) throw new Error("Dedicated catalog test URLs are required");
				const url = new URL(value);
				if (
					url.hostname !== "127.0.0.1" ||
					!/^\/bitovp_integration_[a-f0-9]{32}$/.test(url.pathname)
				)
					throw new Error(
						"Catalog tests require a dedicated loopback PostgreSQL fixture",
					);
			}
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(appUrl);
		});
		afterAll(async () => {
			try {
				if (admin) {
					const where = { organizationId: { in: organizations } };
					await admin.sceneAnalysisRevision.deleteMany({ where });
					await admin.contentRevision.deleteMany({ where });
					await admin.content.deleteMany({ where });
					await admin.librarySource.deleteMany({ where });
					await admin.encodingJob.deleteMany({ where });
					await admin.credential.deleteMany({ where });
					await admin.organization.deleteMany({
						where: { id: { in: organizations } },
					});
				}
			} finally {
				await runtime?.$disconnect();
				await admin?.$disconnect();
			}
		});
		async function tenant() {
			const id = randomUUID();
			await admin.organization.create({
				data: { id, name: "Catalog test", slug: id },
			});
			organizations.push(id);
			return createTenantPrismaClient(runtime, id);
		}
		async function seed(
			db: AppPrismaClient,
			size: number,
			options: {
				snapshot?: (index: number) => Prisma.InputJsonValue;
				jobId?: (index: number) => string | null;
				heavy?: boolean;
			} = {},
		) {
			const ids: string[] = Array.from({ length: size }, () => randomUUID())
				.sort()
				.reverse();
			const sources = ids.map(() => randomUUID());
			for (let start = 0; start < size; start += 250) {
				const batch = ids.slice(start, start + 250).map((id, offset) => ({
					id,
					index: start + offset,
					source: sources[start + offset] as string,
				}));
				await db.librarySource.createMany({
					data: batch.map(({ source, index }) => ({
						id: source,
						sourceKey: source,
						originalJobId: randomUUID(),
						jobId: options.jobId?.(index) ?? null,
						encodingId: "synthetic",
						accountId: randomUUID(),
						locales: ["en"],
						state: "READY",
						snapshot: options.snapshot?.(index) ?? snapshot(index),
					})),
				});
				await db.content.createMany({
					data: batch.map(({ id, index }) => ({
						id,
						registrationKey: id,
						title: index % 20 === 0 ? "Needle_%\\" : `Asset ${index}`,
						description: options.heavy
							? "Synthetic description ".repeat(100)
							: "",
						tags: ["synthetic"],
						locale: "en",
						updatedAt: at,
					})),
				});
				await db.contentRevision.createMany({
					data: batch.map(({ id, source }) => ({
						contentId: id,
						revision: 1,
						sourceId: source,
						title: "Synthetic",
						description: "",
						tags: [],
						locale: "en",
					})),
				});
			}
			return { ids, sources };
		}

		async function publicMp4Job(db: AppPrismaClient) {
			const credential = await db.credential.create({
				data: {
					label: "Synthetic public output",
					provider: "AWS_S3",
					config: { region: "us-east-1" },
					encryptedSecret: "unused-synthetic-secret",
				},
			});
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
			for (const output of plan.outputs)
				if ("credentialId" in output) output.credentialId = credential.id;
			plan.muxings = [
				{
					key: "video",
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
			const job = await db.encodingJob.create({
				data: { name: "Shared legacy catalog fixture", plan },
				select: { id: true, plan: true },
			});
			return {
				id: job.id,
				plan: job.plan as Prisma.InputJsonValue,
				hash: createHash("sha256")
					.update(JSON.stringify(job.plan))
					.digest("hex"),
			};
		}

		it.each([
			false,
			true,
		])("keeps shared legacy plan enrichment across batches with the trigger first: %s", async (triggerFirst) => {
			const db = await tenant();
			const job = await publicMp4Job(db);
			const capturedIndex = triggerFirst ? 260 : 0;
			const triggerIndex = triggerFirst ? 0 : 260;
			const { ids } = await seed(db, 270, {
				jobId: (index) =>
					index === capturedIndex || index === triggerIndex ? job.id : null,
				snapshot: (index) => ({
					planHash: job.hash,
					playbackLinks: [],
					...(index === triggerIndex ? {} : { fileOutputs: [] }),
				}),
			});
			for (const playback of ["all", "playback", "metadata"] as const) {
				const result = await listContents(db, listQuery.parse({ playback }));
				expect(result.counts).toEqual({ all: 270, playback: 2, metadata: 268 });
				if (playback === "playback") {
					expect(result.total).toBe(2);
					expect(result.items.map((item) => item.id)).toEqual([
						ids[0],
						ids[260],
					]);
					const captured = result.items.find(
						(item) => item.id === ids[capturedIndex],
					);
					expect(captured?.catalogPreview?.url).toMatch(/^https:\/\//);
					expect(
						result.items.find((item) => item.id === ids[triggerIndex])
							?.catalogPreview?.url,
					).toMatch(/^\/api\/library\/sources\//);
				} else {
					expect(result.total).toBe(playback === "all" ? 270 : 268);
					expect(result.items.map((item) => item.id)).toEqual(
						(playback === "all"
							? ids
							: ids.filter((_, index) => index !== 0 && index !== 260)
						).slice(0, 25),
					);
				}
			}
		});

		it.each([
			"alone",
			"hash",
			"query",
			"archived",
			"foreign",
		] as const)("does not share legacy projection eligibility from an ineligible %s peer", async (control) => {
			const db = await tenant();
			const job = await publicMp4Job(db);
			const { ids } = await seed(db, 1, {
				jobId: () => job.id,
				snapshot: () => ({
					planHash: job.hash,
					playbackLinks: [],
					fileOutputs: [],
				}),
			});
			await db.content.update({
				where: { id: ids[0] },
				data: { title: "Captured only" },
			});
			if (control !== "alone") {
				const peerDb = control === "foreign" ? await tenant() : db;
				// Tenant reference constraints forbid a foreign source from naming this job.
				const peerJob =
					control === "foreign"
						? await peerDb.encodingJob.create({
								data: { name: "Foreign identical plan", plan: job.plan },
							})
						: job;
				const peer = await seed(peerDb, 1, {
					jobId: () => peerJob.id,
					snapshot: () => ({
						planHash: control === "hash" ? "changed" : job.hash,
						playbackLinks: [],
					}),
				});
				await peerDb.content.update({
					where: { id: peer.ids[0] },
					data: { title: "Trigger peer", archived: control === "archived" },
				});
			}
			const result = await listContents(
				db,
				listQuery.parse({ q: control === "query" ? "Captured only" : "" }),
			);
			expect(result.counts).toEqual({
				all: control === "hash" ? 2 : 1,
				playback: 0,
				metadata: control === "hash" ? 2 : 1,
			});
			expect(
				result.items.find((item) => item.id === ids[0])?.catalogMetadata
					.formats,
			).toEqual([]);
			expect(
				result.items.find((item) => item.id === ids[0])?.catalogPreview,
			).toBeUndefined();
		});

		it("uses one classification scan when captured snapshots need no retained plans", async () => {
			const db = await tenant();
			const { ids } = await seed(db, 501);
			for (const playback of ["all", "playback", "metadata"] as const) {
				const selected = ids.filter((_, index) =>
					playback === "playback"
						? index % 3 !== 2
						: playback === "metadata"
							? index % 3 === 2
							: true,
				);
				const offset = selected.length - 25;
				const observed = { bytes: 0, fullRows: 0, maxBatch: 0, batches: 0 };
				let queries = 0;
				const result = await listContents(
					instrument(db, observed, undefined, async () => {
						queries++;
					}),
					listQuery.parse({ playback, offset }),
				);
				expect(result.counts).toEqual({
					all: 501,
					playback: 334,
					metadata: 167,
				});
				expect(result.total).toBe(selected.length);
				expect(result.items.map((item) => item.id)).toEqual(
					selected.slice(offset),
				);
				expect(observed.batches).toBe(3);
				expect(queries).toBe(4);
				expect(observed.fullRows).toBe(25);
				expect(observed.maxBatch).toBe(250);
			}
		});

		it("discards provisional counts and pages when the last batch activates shared legacy projection", async () => {
			const db = await tenant();
			const job = await publicMp4Job(db);
			const { ids } = await seed(db, 501, {
				jobId: (index) => (index === 0 || index === 500 ? job.id : null),
				snapshot: (index) => ({
					planHash: job.hash,
					playbackLinks: [],
					...(index === 500 ? {} : { fileOutputs: [] }),
				}),
			});
			for (const playback of ["all", "playback", "metadata"] as const) {
				const selected = ids.filter((_, index) =>
					playback === "playback"
						? index === 0 || index === 500
						: playback === "metadata"
							? index !== 0 && index !== 500
							: true,
				);
				for (const offset of new Set([0, Math.max(0, selected.length - 25)])) {
					const observed = { bytes: 0, fullRows: 0, maxBatch: 0, batches: 0 };
					const result = await listContents(
						instrument(db, observed),
						listQuery.parse({ playback, offset }),
					);
					expect(result.counts).toEqual({
						all: 501,
						playback: 2,
						metadata: 499,
					});
					expect(result.total).toBe(selected.length);
					expect(result.items.map((item) => item.id)).toEqual(
						selected.slice(offset, offset + 25),
					);
					for (const item of result.items)
						expect(item.catalogMetadata.formats).toEqual(
							item.id === ids[0] || item.id === ids[500] ? ["MP4"] : [],
						);
					expect(observed.batches).toBe(6);
					expect(observed.fullRows).toBeLessThanOrEqual(25);
					expect(observed.maxBatch).toBe(250);
				}
			}
		});

		it("allows accumulated round-trip latency above five seconds while bounding each classification batch", async () => {
			const db = await tenant();
			await seed(db, 2000);
			const query = listQuery.parse({ offset: 25 });
			const expected = await listContents(db, query);
			const observed = { bytes: 0, fullRows: 0, maxBatch: 0, batches: 0 };
			let delayedQueries = 0;
			const started = performance.now();
			const actual = await listContents(
				instrument(db, observed, undefined, async () => {
					delayedQueries++;
					await new Promise((resolve) => setTimeout(resolve, 600));
				}),
				query,
			);
			expect(actual).toEqual(expected);
			expect(delayedQueries).toBeGreaterThanOrEqual(9);
			expect(performance.now() - started).toBeGreaterThan(5000);
			expect(observed.maxBatch).toBeLessThanOrEqual(250);
			expect(observed.fullRows).toBe(25);
		}, 25000);

		it("bounds scene predicates to scanned windows and advances past empty matching windows", async () => {
			const db = await tenant();
			const { ids, sources } = await seed(db, 501);
			const organizationId = (await db.content.findFirstOrThrow())
				.organizationId;
			for (let start = 0; start < sources.length; start += 250)
				await db.sceneAnalysisRevision.createMany({
					data: sources.slice(start, start + 250).map((sourceId) => ({
						sourceId,
						locale: "en",
						rawHash: sourceId,
						providerVersion: "synthetic",
						raw: {},
						document: {
							duration: 60,
							scenes: [{ title: "WindowSceneMarker" }],
						},
					})),
				});
			type PlanNode = {
				"Relation Name"?: string;
				"Actual Loops"?: number;
				Plans?: PlanNode[];
			};
			const analysisLoops: number[] = [];
			let plans = 0;
			const result = await listContents(
				instrument(
					db,
					{ bytes: 0, fullRows: 0, maxBatch: 0, batches: 0 },
					undefined,
					async ([template, ...values]) => {
						if (plans === 2) return;
						const strings = template as TemplateStringsArray;
						const sql = strings.reduce(
							(text, part, index) => text + (index ? `$${index}` : "") + part,
							"",
						);
						// The restricted runtime role keeps RLS while EXPLAIN uses its raw client.
						const explained = await runtime.$transaction(async (tx) => {
							await tx.$queryRaw`SELECT set_config('bitovp.organization_id', ${organizationId}, true)`;
							return tx.$queryRawUnsafe<
								{ "QUERY PLAN": { Plan: PlanNode }[] }[]
							>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, ...values);
						});
						function visit(node: PlanNode) {
							if (node["Relation Name"] === "SceneAnalysisRevision")
								analysisLoops.push(node["Actual Loops"] ?? 0);
							for (const child of node.Plans ?? []) visit(child);
						}
						const plan = explained[0]?.["QUERY PLAN"][0]?.Plan;
						if (!plan)
							throw new Error(
								"PostgreSQL did not return an analyzed query plan",
							);
						visit(plan);
						plans++;
					},
				),
				listQuery.parse({ q: "WindowSceneMarker" }),
			);
			expect(result.total).toBe(501);
			expect(result.items.map((item) => item.id)).toEqual(ids.slice(0, 25));
			expect(plans).toBe(2);
			expect(analysisLoops.length).toBeGreaterThan(0);
			expect(Math.max(...analysisLoops)).toBeLessThanOrEqual(250);
			await db.content.update({
				where: { id: ids[500] },
				data: { title: "TailWindowMarker", updatedAt: at },
			});
			const tail = await listContents(
				db,
				listQuery.parse({ q: "TailWindowMarker" }),
			);
			expect(tail.total).toBe(1);
			expect(tail.items.map((item) => item.id)).toEqual([ids[500]]);
		});

		it.each([
			100, 10000,
		])("bounds bodies and classification batches for %i matching items without changing pages or counts", async (size) => {
			const db = await tenant();
			const { ids } = await seed(db, size, { heavy: true });
			// Keep seed statistics outside the measured application operation.
			await admin.$executeRawUnsafe(
				'ANALYZE "Content", "ContentRevision", "LibrarySource", "SceneAnalysisRevision"',
			);
			for (const playback of ["all", "playback", "metadata"] as const) {
				const selected = ids.filter((_, index) =>
					playback === "playback"
						? index % 3 !== 2
						: playback === "metadata"
							? index % 3 === 2
							: true,
				);
				for (const offset of [
					0,
					Math.max(0, selected.length - 25),
					selected.length + 25,
				]) {
					const observed = { bytes: 0, fullRows: 0, maxBatch: 0, batches: 0 };
					const result = await listContents(
						instrument(db, observed),
						listQuery.parse({ playback, offset }),
					);
					expect(result.counts).toEqual({
						all: size,
						playback: Math.ceil((size * 2) / 3),
						metadata: Math.floor(size / 3),
					});
					expect(result.total).toBe(selected.length);
					expect(result.items.map((item) => item.id)).toEqual(
						selected.slice(offset, offset + 25),
					);
					expect(observed.fullRows).toBeLessThanOrEqual(25);
					expect(observed.maxBatch).toBeLessThanOrEqual(250);
					// Two slim passes plus the displayed bodies remain below the full aggregate.
					expect(observed.bytes).toBeLessThan(size * 750 + 75000);
					expect(JSON.stringify(result)).not.toContain(
						"synthetic-private-output",
					);
					expect(JSON.stringify(result)).not.toContain("credentialId");
				}
			}
		}, 90000);

		it("keeps legacy plan identity, private MP4, raw-link fallback and unsupported-link classification before paging", async () => {
			const db = await tenant();
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
					key: "video",
					kind: "MP4",
					streamKey: "v360",
					filename: "video.mp4",
					destination: { outputKey: "origin", path: "output/", acl: "PRIVATE" },
				},
			];
			plan.manifests = [];
			const job = await db.encodingJob.create({
				data: { name: "Legacy catalog fixture", plan },
				select: { id: true, plan: true },
			});
			const hash = createHash("sha256")
				.update(JSON.stringify(job.plan))
				.digest("hex");
			const { ids } = await seed(db, 37, {
				jobId: (index) => (index >= 28 && index <= 30 ? job.id : null),
				snapshot: (index) => {
					if (index === 28 || index === 29)
						return { planHash: hash, playbackLinks: [] };
					if (index === 30) return { planHash: "changed", playbackLinks: [] };
					if (index === 31) return { planHash: hash, playbackLinks: [] };
					if (index === 32)
						return {
							planHash: "retained",
							playbackLinks: [privateLink],
							fileOutputs: [fileOutput],
						};
					if (index === 33)
						return {
							planHash: "retained",
							playbackLinks: [{ ...publicLink, kind: "MP4" }],
						};
					if (index === 34)
						return {
							planHash: "retained",
							playbackLinks: [
								{
									...publicLink,
									url: "https://user:password@media.invalid/video.m3u8",
								},
							],
							fileOutputs: [],
						};
					if (index === 35)
						return {
							planHash: "retained",
							playbackLinks: [{ ...publicLink, kind: "SMOOTH" }],
							fileOutputs: [],
						};
					if (index === 36)
						return {
							planHash: "retained",
							playbackLinks: [{ kind: "HLS", url: publicLink.url }],
							fileOutputs: [],
						};
					return { planHash: "retained", playbackLinks: [], fileOutputs: [] };
				},
			});
			const result = await listContents(
				db,
				listQuery.parse({ playback: "playback" }),
			);
			expect(result.counts).toEqual({ all: 37, playback: 5, metadata: 32 });
			expect(result.total).toBe(5);
			expect(result.items.map((item) => item.id)).toEqual(
				[28, 29, 32, 33, 36].map((index) => ids[index]),
			);
			expect(
				result.items
					.slice(0, 3)
					.every((item) =>
						item.catalogPreview?.url.startsWith("/api/library/sources/"),
					),
			).toBe(true);
			expect(JSON.stringify(result)).not.toContain("password");
			expect(JSON.stringify(result)).not.toContain("planHash");
		});

		it("searches literal metadata and only the current revision's latest selected-locale analysis, including archived counts", async () => {
			const db = await tenant();
			const { ids, sources } = await seed(db, 1);
			const oldSource = sources[0] as string;
			const current = await db.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: "synthetic",
					accountId: randomUUID(),
					locales: ["en", "ja"],
					snapshot: snapshot(0),
				},
			});
			await db.contentRevision.create({
				data: {
					contentId: ids[0] as string,
					revision: 2,
					sourceId: current.id,
					title: "Current",
					description: "",
					tags: [],
					locale: "en",
				},
			});
			await db.content.update({
				where: { id: ids[0] },
				data: { revision: 2, title: "Current", tags: ["Tag_%\\"] },
			});
			const analysisIds = [randomUUID(), randomUUID()].sort();
			for (const [id, sourceId, locale, text] of [
				[randomUUID(), oldSource, "en", "OldRevision"],
				[analysisIds[0], current.id, "en", "OldAnalysis"],
				[analysisIds[1], current.id, "en", "CurrentScene_%\\"],
				[randomUUID(), current.id, "ja", "OtherLocale"],
			] as [string, string, string, string][]) {
				await db.sceneAnalysisRevision.create({
					data: {
						id,
						sourceId,
						locale,
						rawHash: id,
						providerVersion: "synthetic",
						raw: {},
						document: {
							duration: 60,
							scenes: [
								{
									id: randomUUID(),
									title: text,
									startInSeconds: 1,
									endInSeconds: 9,
								},
							],
						},
						createdAt: at,
					},
				});
			}
			for (const q of [
				"OldRevision",
				"OldAnalysis",
				"OtherLocale",
				"not-present",
			])
				expect((await listContents(db, listQuery.parse({ q }))).total).toBe(0);
			for (const q of ["CurrentScene_%\\", "Tag_%\\"]) {
				const result = await listContents(db, listQuery.parse({ q }));
				expect(result.total).toBe(1);
				expect(result.items[0]?.catalogMetadata).toEqual({
					formats: ["HLS"],
					duration: 60,
					sceneCount: 1,
				});
				expect(result.items[0]?.catalogPreview?.time).toBeCloseTo(3.4);
			}
			await db.content.update({
				where: { id: ids[0] },
				data: { archived: true },
			});
			expect(
				(await listContents(db, listQuery.parse({ q: "Tag_%\\" }))).total,
			).toBe(0);
			expect(
				(
					await listContents(
						db,
						listQuery.parse({ q: "Tag_%\\", archived: "true" }),
					)
				).counts,
			).toEqual({ all: 1, playback: 1, metadata: 0 });
		});

		it("keeps counts, body lookup and playback links under the caller's tenant RLS", async () => {
			const own = await tenant();
			const foreign = await tenant();
			await seed(own, 2);
			const { ids } = await seed(foreign, 3);
			await foreign.content.update({
				where: { id: ids[0] },
				data: { title: "Foreign-only marker" },
			});
			const result = await listContents(own, listQuery.parse({}));
			expect(result.counts).toEqual({ all: 2, playback: 2, metadata: 0 });
			expect(result.items.some((item) => ids.includes(item.id))).toBe(false);
			expect(
				(await listContents(own, listQuery.parse({ q: "Foreign-only marker" })))
					.total,
			).toBe(0);
			expect(
				(
					await listContents(
						foreign,
						listQuery.parse({ q: "Foreign-only marker" }),
					)
				).total,
			).toBe(1);
		});

		it("uses one read snapshot when a concurrent edit would move an unseen row above the keyset cursor", async () => {
			const db = await tenant();
			const { ids } = await seed(db, 501);
			let edited = false;
			const observed = { bytes: 0, fullRows: 0, maxBatch: 0, batches: 0 };
			const result = await listContents(
				instrument(db, observed, async () => {
					await admin.content.update({
						where: { id: ids[280] },
						data: {
							title: "Moved during scan",
							updatedAt: new Date(at.getTime() + 1000),
						},
					});
					edited = true;
				}),
				listQuery.parse({ offset: 275 }),
			);
			expect(edited).toBe(true);
			expect(result.total).toBe(501);
			expect(result.items.map((item) => item.id)).toEqual(ids.slice(275, 300));
			expect(
				result.items.some((item) => item.title === "Moved during scan"),
			).toBe(false);
			expect(observed.batches).toBe(3);
			const next = await listContents(db, listQuery.parse({}));
			expect(next.items[0]?.title).toBe("Moved during scan");
			expect(next.items[0]?.id).toBe(ids[280]);
		});
	},
);
