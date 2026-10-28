import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	librarySceneOptions,
	sceneSearchQuery,
	searchLibraryScenes,
} from "./library-scene-search";

// Opt in only with the private configuration of a disposable, restricted-role DB.
const configFile = process.env.LIBRARY_SCENE_TEST_CONFIG;
describe.runIf(Boolean(configFile))(
	"scene search PostgreSQL boundaries",
	() => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		const sceneIds: string[] = Array.from({ length: 26 }, () => randomUUID());
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let a: AppPrismaClient;
		let b: AppPrismaClient;
		let contentId: string;
		let analysisRevisionId: string;
		let fixturesCreated = false;

		const scene = (word: string, index = 0) => ({
			id: randomUUID() as string,
			startInSeconds: index * 2 + 0.25,
			endInSeconds: index * 2 + 1.25,
			title: word,
			summary: "",
			keywords: [],
			shots: [],
		});
		const document = (scenes: ReturnType<typeof scene>[]) => ({
			duration: 100,
			scenes,
		});
		async function source(client: AppPrismaClient) {
			return client.librarySource.create({
				data: {
					sourceKey: `scene-proof-${randomUUID()}`,
					originalJobId: randomUUID(),
					encodingId: "synthetic-no-provider",
					accountId: randomUUID(),
					snapshot: { planHash: "fixture", playbackLinks: [], fileOutputs: [] },
					locales: ["en", "ja"],
					state: "READY",
				},
			});
		}
		async function analysis(
			client: AppPrismaClient,
			sourceId: string,
			locale: string,
			scenes: ReturnType<typeof scene>[],
			createdAt: string,
		) {
			return client.sceneAnalysisRevision.create({
				data: {
					sourceId,
					locale,
					rawHash: randomUUID(),
					providerVersion: "synthetic",
					raw: { private: "PRIVATE_RAW_NOT_SEARCHABLE" },
					document: document(scenes),
					createdAt: new Date(createdAt),
				},
			});
		}
		async function content(
			client: AppPrismaClient,
			sourceId: string,
			archived = false,
			revision = 1,
		) {
			const row = await client.content.create({
				data: {
					registrationKey: `scene-proof-${randomUUID()}`,
					title: "Content title alone must not match",
					tags: [],
					locale: "en",
					archived,
					revision,
				},
			});
			await client.contentRevision.create({
				data: {
					contentId: row.id,
					sourceId,
					revision,
					title: row.title,
					description: "",
					tags: [],
					locale: "en",
				},
			});
			return row;
		}

		beforeAll(async () => {
			const config = JSON.parse(readFileSync(configFile as string, "utf8"));
			if (!/^bitovp_(mt|scene)_/.test(config.database)) {
				throw new Error("A disposable scene-test database is required");
			}
			admin = createPrismaClient(config.adminUrl);
			runtime = createPrismaClient(config.runtimeUrl);
			const [role] = await runtime.$queryRaw<
				{ database: string; rolsuper: boolean; rolbypassrls: boolean }[]
			>`SELECT current_database() AS database, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
			expect(role).toEqual({
				database: config.database,
				rolsuper: false,
				rolbypassrls: false,
			});
			a = createTenantPrismaClient(runtime, orgA);
			b = createTenantPrismaClient(runtime, orgB);
			await admin.organization.createMany({
				data: [orgA, orgB].map((id) => ({
					id,
					name: "Disposable scene-search proof",
					slug: `scene-proof-${id}`,
				})),
			});
			fixturesCreated = true;
			const old = await source(a);
			await analysis(a, old.id, "en", [scene("obsolete-source")], "2026-01-01");
			const current = await source(a);
			await analysis(
				a,
				current.id,
				"en",
				[scene("obsolete-analysis")],
				"2026-01-01",
			);
			await analysis(
				a,
				current.id,
				"ja",
				[scene("wrong-locale")],
				"2026-03-01",
			);
			const scenes = sceneIds.map((id, index) => ({
				...scene(index === 0 ? "fox_%\\trail" : "fox", index),
				id,
			}));
			Object.assign(scenes[1] as object, {
				shots: [
					{
						detailedDescription: "shot-description-only",
						keywords: ["shot-keyword-only"],
					},
				],
			});
			Object.assign(scenes[2] as object, {
				keywords: ["scene-keyword-only"],
				unknown: "PRIVATE_UNKNOWN_NOT_SEARCHABLE",
			});
			scenes.push(
				{ ...scene("fox"), startInSeconds: -1 },
				{ ...scene("fox"), endInSeconds: 101 },
				{ ...scene("fox"), endInSeconds: 0.25 },
				{ ...scene("fox"), id: "invalid-uuid" },
			);
			analysisRevisionId = (
				await analysis(a, current.id, "en", scenes, "2026-02-01")
			).id;
			const head = await content(a, current.id, false, 2);
			contentId = head.id;
			await a.contentRevision.create({
				data: {
					contentId,
					revision: 1,
					sourceId: old.id,
					title: "Old",
					description: "",
					tags: [],
					locale: "en",
				},
			});
			const archived = await source(a);
			await analysis(
				a,
				archived.id,
				"en",
				[scene("archive-only")],
				"2026-02-01",
			);
			await content(a, archived.id, true);
			const unregistered = await source(a);
			await analysis(
				a,
				unregistered.id,
				"en",
				[scene("unregistered-only")],
				"2026-02-01",
			);
			const other = await source(b);
			await analysis(
				b,
				other.id,
				"en",
				[scene("fox other-organization-only")],
				"2026-02-01",
			);
			await content(b, other.id);
		}, 20_000);

		afterAll(async () => {
			if (admin && fixturesCreated) {
				const where = { organizationId: { in: [orgA, orgB] } };
				await admin.contentRevision.deleteMany({ where });
				await admin.content.deleteMany({ where });
				await admin.sceneAnalysisRevision.deleteMany({ where });
				await admin.librarySource.deleteMany({ where });
				await admin.organization.deleteMany({
					where: { id: { in: [orgA, orgB] } },
				});
			}
			if (admin) await admin.$disconnect();
			if (runtime) await runtime.$disconnect();
		});

		const search = (q: string, options = {}) =>
			searchLibraryScenes(a, sceneSearchQuery.parse({ q, ...options }), orgA);
		it("does not repeat scene JSON text extraction for coverage, weight and matched rows", async () => {
			let statement: TemplateStringsArray | undefined;
			let parameters: unknown[] = [];
			const capture = {
				$queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
					statement = sql;
					parameters = values;
					return [];
				},
			} as unknown as AppPrismaClient;
			await searchLibraryScenes(
				capture,
				sceneSearchQuery.parse({ q: "fox kelp", match: "any" }),
				orgA,
			);
			const parts = [...(statement as unknown as string[])];
			parts[0] = `EXPLAIN (FORMAT JSON) ${parts[0]}`;
			const sql = Object.assign(parts, { raw: parts });
			const rows = await runtime.$transaction(async (tx) => {
				// The tenant facade deliberately disallows EXPLAIN. This fixed test
				// uses the same restricted runtime role and transaction-local RLS scope.
				await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
				await tx.$executeRaw`SELECT set_config('bitovp.organization_id', ${orgA}, true)`;
				return tx.$queryRaw<Record<string, { Plan: unknown }[]>[]>(
					sql,
					...parameters,
				);
			});
			const functions: string[] = [];
			const expandedSceneFilters: string[] = [];
			const visit = (value: unknown) => {
				if (!value || typeof value !== "object") return;
				if (
					"Function Name" in value &&
					value["Function Name"] === "jsonb_array_elements" &&
					"Filter" in value &&
					typeof value.Filter === "string"
				)
					expandedSceneFilters.push(value.Filter);
				for (const [key, child] of Object.entries(value)) {
					if (key === "Function Name" && typeof child === "string")
						functions.push(child);
					else visit(child);
				}
			};
			visit(rows);
			// One scene-keyword, shot-keyword and shot-description expansion;
			// scoring/counting/paging must reuse those computed fields.
			expect(
				functions.filter((name) => name === "jsonb_path_query"),
			).toHaveLength(3);
			// Duration belongs to the selected analysis, not each expanded scene:
			// decompressing its entire document in this filter caused the main delay.
			expect(expandedSceneFilters.join(" ")).not.toContain("document");
		});
		it("pages 26 valid hits before enrichment and pins current head/latest selected locale", async () => {
			const first = await search("fox");
			const second = await search("fox", { offset: 25 });
			expect(first.total).toBe(26);
			expect(first.items.map((row) => row.sceneId)).toEqual(
				sceneIds.slice(0, 25),
			);
			expect(second.total).toBe(26);
			expect(second.items.map((row) => row.sceneId)).toEqual(
				sceneIds.slice(25),
			);
			for (const hit of [...first.items, ...second.items]) {
				expect(hit).toMatchObject({
					contentId,
					contentRevision: 2,
					analysisRevisionId,
					locale: "en",
					archived: false,
				});
			}
			expect(await search("fox", { offset: 100000 })).toEqual({
				items: [],
				total: 26,
			});
		});
		it("uses literal case-insensitive text and only approved scene/shot fields", async () => {
			const literal = await search("FOX_%\\trail");
			expect(literal.total).toBe(1);
			expect(literal.items[0]?.sceneId).toBe(sceneIds[0]);
			for (const term of [
				"scene-keyword-only",
				"shot-description-only",
				"shot-keyword-only",
			]) {
				expect((await search(term)).total).toBe(1);
			}
			for (const term of [
				"PRIVATE_UNKNOWN_NOT_SEARCHABLE",
				"PRIVATE_RAW_NOT_SEARCHABLE",
				"Content title alone",
				"obsolete-source",
				"obsolete-analysis",
				"wrong-locale",
				"unregistered-only",
			]) {
				expect(await search(term)).toEqual({ items: [], total: 0 });
			}
		});
		it("keeps tenant RLS and archive modes isolated", async () => {
			expect(await search("other-organization-only")).toEqual({
				items: [],
				total: 0,
			});
			expect(
				(
					await searchLibraryScenes(
						b,
						sceneSearchQuery.parse({ q: "fox" }),
						orgB,
					)
				).total,
			).toBe(1);
			expect(await search("archive-only")).toEqual({ items: [], total: 0 });
			expect(
				(await search("archive-only", { archived: "true" })).items[0]?.archived,
			).toBe(true);
			expect(await search("fox", { archived: "true" })).toEqual({
				items: [],
				total: 0,
			});
			expect(
				await searchLibraryScenes(
					runtime,
					sceneSearchQuery.parse({ q: "fox" }),
					orgA,
				),
			).toEqual({ items: [], total: 0 });
		});
		it("matches separate normalized terms across fields and ranks title/keywords ahead of descriptions", async () => {
			const s = await source(a);
			const rows = [
				scene("otter kelp", 0),
				scene("Keywords", 1),
				scene("Summary", 2),
				scene("Shot", 3),
				scene("ＳＥＡ ｶﾓﾒ", 4),
			];
			Object.assign(rows[1] as object, { keywords: ["kelp", "otter"] });
			Object.assign(rows[2] as object, { summary: "otter beside kelp" });
			Object.assign(rows[3] as object, {
				shots: [{ detailedDescription: "kelp with otter" }],
			});
			await analysis(a, s.id, "en", rows, "2026-02-01");
			await content(a, s.id);
			expect(
				(await search("kelp otter")).items.map((hit) => hit.sceneId),
			).toEqual(rows.slice(0, 4).map((row) => row.id));
			expect(
				(await search("kelp otter")).items.map((hit) => hit.relevance?.score),
			).toEqual([100, 88, 80, 72]);
			expect(
				(await search("kelp otter otter")).items.map(
					(hit) => hit.relevance?.score,
				),
			).toEqual([100, 88, 80, 72]);
			expect(
				(await search("kelp otter otter")).items.map((hit) => hit.sceneId),
			).toEqual(rows.slice(0, 4).map((row) => row.id));
			expect((await search("sea カモメ")).items[0]?.sceneId).toBe(rows[4]?.id);
			expect((await search("otter missingterm")).total).toBe(0);
			expect((await search("otter missingterm", { match: "any" })).total).toBe(
				4,
			);
			const separate = scene("dolphin", 5);
			Object.assign(separate, { shots: [{ keywords: ["sunset"] }] });
			await analysis(a, s.id, "en", [separate], "2026-04-01");
			expect((await search("sunset dolphin")).items[0]?.sceneId).toBe(
				separate.id,
			);
			expect((await search("otter")).total).toBe(0);
		});
		it("can sort by update time and filter by registered analysis locale without exposing other tenants", async () => {
			const old = await source(a);
			const title = scene("walrus glacier");
			await analysis(a, old.id, "en", [title], "2026-02-01");
			const oldContent = await content(a, old.id);
			await a.content.update({
				where: { id: oldContent.id },
				data: { updatedAt: new Date("2026-01-01") },
			});
			const recent = await source(a);
			const summary = { ...scene("Description"), summary: "glacier walrus" };
			await analysis(a, recent.id, "en", [summary], "2026-02-01");
			await content(a, recent.id);
			expect(
				(await search("walrus glacier")).items.map((hit) => hit.sceneId),
			).toEqual([title.id, summary.id]);
			expect(
				(await search("walrus glacier", { sort: "recent" })).items.map(
					(hit) => hit.sceneId,
				),
			).toEqual([summary.id, title.id]);
			expect(
				(await search("walrus glacier", { sort: "recent" })).items.map(
					(hit) => hit.relevance?.score,
				),
			).toEqual([80, 100]);
			const japanese = await source(a);
			await analysis(
				a,
				japanese.id,
				"ja",
				[scene("walrus glacier")],
				"2026-02-01",
			);
			const jaContent = await content(a, japanese.id);
			await a.content.update({
				where: { id: jaContent.id },
				data: { locale: "ja" },
			});
			await a.contentRevision.update({
				where: { contentId_revision: { contentId: jaContent.id, revision: 1 } },
				data: { locale: "ja" },
			});
			expect(
				(await search("walrus glacier", { locale: "ja" })).items,
			).toHaveLength(1);
			expect(
				(await search("walrus glacier", { locale: "en" })).items,
			).toHaveLength(2);
			expect(await librarySceneOptions(a, { archived: "false" })).toEqual({
				locales: ["en", "ja"],
			});
			expect(await librarySceneOptions(a, { archived: "true" })).toEqual({
				locales: ["en"],
			});
			expect(await librarySceneOptions(b, { archived: "false" })).toEqual({
				locales: ["en"],
			});
			expect(await librarySceneOptions(runtime, { archived: "false" })).toEqual(
				{ locales: [] },
			);
			expect((await search("walrus glacier", { locale: "fr" })).total).toBe(0);
		});
		it("prioritizes term coverage in any-term mode and treats SQL metacharacters literally", async () => {
			const s = await source(a);
			const partial = scene("harbor", 0);
			const complete = {
				...scene("Description", 1),
				summary: "harbor lighthouse",
			};
			const literal = scene("50%_\\signal", 2);
			await analysis(a, s.id, "en", [partial, complete, literal], "2026-02-01");
			await content(a, s.id);
			expect(
				(await search("harbor lighthouse", { match: "any" })).items.map(
					(hit) => hit.sceneId,
				),
			).toEqual([complete.id, partial.id]);
			expect(
				(await search("50%_\\signal")).items.map((hit) => hit.sceneId),
			).toEqual([literal.id]);
			expect(await search("' OR 1=1 --")).toEqual({ items: [], total: 0 });
		});
	},
);
