/** Run against an explicit isolated local app/database; no live provider calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ContentDetail, ContentView } from "@bitovp/core";
import { createPrismaClient } from "@bitovp/db";
import planFixture from "../../../packages/core/src/plan/__fixtures__/ai-scene-analysis-passthrough-test.plan.json";
import { createAnalysisSweep } from "../src/library/analysis-sweep";
import { createLibraryCaptureSweep } from "../src/library/capture-sweep";

const databaseUrl = process.env.LIBRARY_E2E_DATABASE_URL;
const base = process.env.LIBRARY_E2E_BASE_URL;
assert(
	databaseUrl && base,
	"Set LIBRARY_E2E_DATABASE_URL and LIBRARY_E2E_BASE_URL",
);
const dbAddress = new URL(databaseUrl);
const appAddress = new URL(base);
assert.equal(dbAddress.pathname, "/bitovp_library_1a_e2e");
assert(["127.0.0.1", "localhost"].includes(dbAddress.hostname));
assert(["127.0.0.1", "localhost"].includes(appAddress.hostname));
assert.equal(appAddress.port, "3115");
const prisma = createPrismaClient(databaseUrl);
async function request(path: string, method = "GET", body?: unknown) {
	return fetch(`${base}${path}`, {
		method,
		headers: { "content-type": "application/json", origin: appAddress.origin },
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(30_000),
	});
}
async function json<T>(response: Response, status = 200): Promise<T> {
	const body = await response.text();
	assert.equal(
		response.status,
		status,
		`${response.url}: ${body.slice(0, 800)}`,
	);
	return JSON.parse(body) as T;
}

async function main() {
	try {
		await json(await request("/api/library"));
		const suffix = randomUUID();
		const account = await prisma.bitmovinAccount.create({
			data: {
				label: `HTTP fixture ${suffix}`,
				encryptedApiKey: "fixture-only",
			},
		});
		const job = await prisma.encodingJob.create({
			data: {
				name: `番組検索${suffix} 100%`,
				status: "FINISHED",
				plan: planFixture,
				bitmovinEncodingId: randomUUID(),
				bitmovinAccountId: account.id,
				qcVerdict: { pass: false, ruleResults: [] },
				qcOverriddenAt: new Date(),
			},
		});
		const report = await prisma.vmafJob.create({
			data: {
				encodingJobId: job.id,
				mode: "VOD",
				model: "vmaf_v0.6.1",
				scoringVersion: 2,
				status: "FINISHED",
				results: {
					create: {
						renditionRef: { label: "180p" },
						pooled: { mean: 91.25 },
						provenance: { reference: { sha256: "fixture" } },
					},
				},
			},
		});
		await createLibraryCaptureSweep({ prisma })();
		const captured = await prisma.librarySource.findFirstOrThrow({
			where: { jobId: job.id },
		});
		const capture = { sourceId: captured.id };
		const automatic = await prisma.content.findUniqueOrThrow({
			where: { registrationKey: capture.sourceId },
		});
		const pending = await json<ContentDetail>(
			await request(`/api/library/${automatic.id}`),
		);
		assert.equal(pending.source.state, "PENDING");
		assert.equal(pending.source.analyses.length, 0);
		// Scene keyword is unique and absent from content metadata, proving analysis search.
		const sceneKeyword = `桜並木${suffix}`;
		const sweep = createAnalysisSweep({
			prisma,
			providerFor: async () => ({
				get: async () => ({
					metadata: { version: "fixture-v1" },
					duration: 3.5,
					scenes: [
						{
							id: randomUUID(),
							startInSeconds: 0.125,
							endInSeconds: 3.375,
							title: sceneKeyword,
							shots: [],
						},
					],
					futureField: "retained",
					apiKey: "must-never-egress",
				}),
			}),
		});
		await sweep();
		const metadata = {
			sourceId: capture.sourceId,
			title: `番組検索${suffix} 100%`,
			description: "",
			tags: [],
			locale: "ja",
		};
		const registrations = await Promise.all([
			request("/api/library", "POST", metadata),
			request("/api/library", "POST", metadata),
		]);
		const registered = await Promise.all(
			registrations.map((response) => json<{ id: string }>(response, 201)),
		);
		const contentId = registered[0]?.id;
		assert(contentId);
		assert.equal(registered[1]?.id, contentId);
		assert.equal(
			await prisma.content.count({
				where: { registrationKey: capture.sourceId },
			}),
			1,
		);
		assert.equal(
			await prisma.contentRevision.count({ where: { contentId } }),
			1,
		);
		const edits = await Promise.all([
			request(`/api/library/${contentId}`, "PATCH", {
				expectedRevision: 1,
				description: "First writer",
			}),
			request(`/api/library/${contentId}`, "PATCH", {
				expectedRevision: 1,
				description: "Second writer",
			}),
		]);
		assert.deepEqual(
			edits.map((response) => response.status).sort(),
			[200, 409],
		);
		const detail = await json<ContentDetail>(
			await request(`/api/library/${contentId}`),
		);
		assert.equal(detail.revision, 2);
		assert.equal(
			await prisma.contentRevision.count({ where: { contentId } }),
			2,
		);
		for (const query of [`番組検索${suffix}`, sceneKeyword]) {
			const results = await json<{ items: ContentView[] }>(
				await request(`/api/library?q=${encodeURIComponent(query)}`),
			);
			assert(
				results.items.some((item) => item.id === contentId),
				`Search failed for ${query}`,
			);
		}
		const percent = await json<{ items: ContentView[] }>(
			await request(`/api/library?q=${encodeURIComponent("%")}`),
		);
		assert(percent.items.some((item) => item.id === contentId));
		assert(
			percent.items.every(
				(item) =>
					item.title.includes("%") ||
					item.description.includes("%") ||
					item.tags.some((tag) => tag.includes("%")),
			),
			"Percent must be literal, not SQL wildcard",
		);
		const beforeSnapshot = detail.source.snapshot;
		assert.equal(
			(beforeSnapshot.qcEvidence?.[0] as { id?: string } | undefined)?.id,
			report.id,
		);
		await json(await request(`/api/encoding-jobs/${job.id}`, "DELETE"));
		assert.equal(await prisma.vmafJob.count({ where: { id: report.id } }), 0);
		const retained = await json<ContentDetail>(
			await request(`/api/library/${contentId}`),
		);
		assert.equal(retained.source.jobId, null);
		assert.equal(retained.source.originalJobId, job.id);
		assert.deepEqual(retained.source.snapshot, beforeSnapshot);
		assert.equal(retained.source.analyses.length, 2);
		assert(!JSON.stringify(retained).includes("must-never-egress"));
		assert(!JSON.stringify(retained).includes("futureField"));
		assert.equal(
			(
				await prisma.sceneAnalysisRevision.findFirstOrThrow({
					where: { sourceId: capture.sourceId },
				})
			).raw !== null,
			true,
		);
		await json(
			await request(`/api/library/${contentId}`, "PATCH", {
				expectedRevision: 2,
				archived: true,
			}),
		);
		const active = await json<{ items: ContentView[] }>(
			await request(`/api/library?q=${suffix}`),
		);
		assert(!active.items.some((item) => item.id === contentId));
		const archived = await json<{ items: ContentView[] }>(
			await request(`/api/library?archived=true&q=${suffix}`),
		);
		assert(archived.items.some((item) => item.id === contentId));
		await createLibraryCaptureSweep({ prisma })();
		assert.equal(
			(await prisma.content.findUniqueOrThrow({ where: { id: contentId } }))
				.archived,
			true,
		);
		assert.equal(await prisma.encodingJob.count({ where: { id: job.id } }), 0);
		const { aiSceneAnalysis: _analysis, ...plainPlan } = planFixture;
		const plain = await prisma.encodingJob.create({
			data: {
				name: `Non-AISA ${suffix}`,
				status: "FINISHED",
				plan: plainPlan,
				bitmovinEncodingId: randomUUID(),
				bitmovinAccountId: account.id,
			},
		});
		await createLibraryCaptureSweep({ prisma })();
		const plainSource = await prisma.librarySource.findFirstOrThrow({
			where: { jobId: plain.id },
		});
		const plainContent = await prisma.content.findUniqueOrThrow({
			where: { registrationKey: plainSource.id },
		});
		assert.equal(plainSource.state, "READY");
		assert.deepEqual(plainSource.locales, []);
		assert.equal(plainContent.locale, "und");
		await json(
			await request(`/api/library/${plainContent.id}`, "PATCH", {
				expectedRevision: 1,
				title: "Edited non-AISA asset",
			}),
		);
		await createLibraryCaptureSweep({ prisma })();
		assert.equal(
			(
				await prisma.content.findUniqueOrThrow({
					where: { id: plainContent.id },
				})
			).title,
			"Edited non-AISA asset",
		);
		console.log(
			JSON.stringify({
				result: "PASS",
				contentId,
				sourceId: capture.sourceId,
				deletedJobId: job.id,
				checks: [
					"automatic registration before optional AISA",
					"non-AISA asset registration and editing",
					"no recreation or unarchive after deletion",
					"duplicate registration",
					"CAS 200/409",
					"Japanese metadata search",
					"Japanese scene search",
					"literal percent",
					"archive filter",
					"HTTP job deletion",
					"QC snapshot retention",
					"safe detail projection",
				],
			}),
		);
	} finally {
		await prisma.$disconnect();
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
