/** Explicit isolated PostgreSQL only. Provider reads use a deterministic fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPrismaClient, requestLibrarySource } from "@bitovp/db";
import planFixture from "../../../packages/core/src/plan/__fixtures__/ai-scene-analysis-passthrough-test.plan.json";
import { createAnalysisSweep } from "../src/library/analysis-sweep";

const databaseUrl = process.env.LIBRARY_E2E_DATABASE_URL;
assert(databaseUrl, "Set LIBRARY_E2E_DATABASE_URL explicitly");
const parsed = new URL(databaseUrl);
assert.equal(parsed.pathname, "/bitovp_library_1a_e2e");
assert(["127.0.0.1", "localhost"].includes(parsed.hostname));
const prisma = createPrismaClient(databaseUrl);
try {
	const account = await prisma.bitmovinAccount.create({
		data: {
			label: "Library fixture account",
			encryptedApiKey: "fixture-not-a-real-api-key",
		},
	});
	const createJob = (name: string) =>
		prisma.encodingJob.create({
			data: {
				name,
				status: "FINISHED",
				finishedAt: new Date(),
				plan: planFixture,
				bitmovinEncodingId: randomUUID(),
				bitmovinAccountId: account.id,
				qcVerdict: { pass: true, ruleResults: [] },
			},
		});
	const durableJob = await createJob("永続化テスト映像");
	const [source, duplicate] = await Promise.all([
		requestLibrarySource(prisma, durableJob.id),
		requestLibrarySource(prisma, durableJob.id),
	]);
	assert.equal(
		source.id,
		duplicate.id,
		"simultaneous capture must be idempotent",
	);
	await prisma.encodingJob.delete({ where: { id: durableJob.id } });
	const detached = await prisma.librarySource.findUniqueOrThrow({
		where: { id: source.id },
	});
	assert.equal(detached.jobId, null);
	assert.equal(detached.originalJobId, durableJob.id);
	let failJapanese = true;
	const calls: string[] = [];
	const raw = (locale: string) => ({
		metadata: { version: "1.0" },
		duration: 12.5,
		title: locale === "ja" ? "公園の朝" : "Morning in the park",
		description: "Isolated deterministic analysis fixture",
		keywords: ["park", "morning"],
		secret: "fixture-secret",
		futureField: { retained: true },
		scenes: [
			{
				id: "00000000-0000-4000-8000-000000000010",
				startInSeconds: 0.25,
				endInSeconds: 8.75,
				title: locale === "ja" ? "朝の散歩" : "A morning walk",
				summary: "A person walks through a park.",
				shots: [
					{
						startInSeconds: 0.25,
						endInSeconds: 8.75,
						detailedDescription: "Green trees beside the path",
						mainSubjects: [],
					},
				],
			},
		],
	});
	const sweep = createAnalysisSweep({
		prisma,
		providerFor: async () => ({
			get: async (_encoding, locale) => {
				calls.push(locale);
				if (failJapanese && locale === "ja") throw new Error("fixture failure");
				return raw(locale);
			},
		}),
	});
	await sweep();
	assert.equal(
		(await prisma.librarySource.findUniqueOrThrow({ where: { id: source.id } }))
			.state,
		"ERROR",
	);
	assert.equal(
		await prisma.sceneAnalysisRevision.count({
			where: { sourceId: source.id },
		}),
		1,
	);
	failJapanese = false;
	await prisma.librarySource.update({
		where: { id: source.id },
		data: { availableAt: new Date(0) },
	});
	await Promise.all([sweep(), sweep()]);
	assert.equal(
		(await prisma.librarySource.findUniqueOrThrow({ where: { id: source.id } }))
			.state,
		"READY",
	);
	assert.deepEqual(calls.sort(), ["ja", "ja", "ko"]);
	const analyses = await prisma.sceneAnalysisRevision.findMany({
		where: { sourceId: source.id },
	});
	assert.equal(analyses.length, 2);
	assert.equal((analyses[0]?.raw as { secret: string }).secret, "[REDACTED]");
	assert.deepEqual((analyses[0]?.raw as { futureField: unknown }).futureField, {
		retained: true,
	});
	const uiJob = await createJob("Library UI 検証用映像");
	const uiSource = await requestLibrarySource(prisma, uiJob.id);
	await sweep();
	assert.equal(
		(await prisma.encodingJob.findUniqueOrThrow({ where: { id: uiJob.id } }))
			.status,
		"FINISHED",
	);
	console.log(
		JSON.stringify({
			result: "PASS",
			checks: [
				"concurrent capture",
				"job deletion SetNull",
				"partial locale retry",
				"concurrent sweeps",
				"raw retained and redacted",
				"encoding status preserved",
			],
			detachedSourceId: source.id,
			originalDeletedJobId: durableJob.id,
			uiJobId: uiJob.id,
			uiSourceId: uiSource.id,
			accountId: account.id,
		}),
	);
} finally {
	await prisma.$disconnect();
}
