import { MAX_SCENE_ANALYSIS_BYTES, normalizeSceneAnalysis } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./context", () => ({ getServerContext: vi.fn() }));

import { sourceView } from "./library";

const raw = {
	metadata: { version: "1.0" },
	duration: 10,
	inputLanguageCodes: ["ja"],
	ratings: [{ region: "TEST", rating: "A", system: "Example" }],
	futureAnalysis: { zero: 0, disabled: false, absent: null, empty: "" },
	credits: {
		persons: [{ name: "Person A", role: "Director", department: "Production" }],
		songs: [{ name: "Song A", artist: "Artist A" }],
		copyright: "Example",
	},
	scenes: [
		{
			id: "a1111111-1111-4111-8111-111111111111",
			startInSeconds: 0,
			endInSeconds: 10,
			content: {
				dynamics: { tension: "High", pacing: "Fast" },
				settings: [
					{ location: { name: "Garden" }, atmosphere: { mood: "Quiet" } },
				],
			},
			shots: [
				{
					startInSeconds: 5,
					endInSeconds: 10,
					mainSubjects: [
						{
							classification: "person",
							description: "Out-of-range observation",
							appearanceTimeInSeconds: 9,
							centerX: 50,
							centerY: 50,
						},
					],
				},
			],
		},
	],
	privateProviderPayload: {
		token: "private-secret",
		url: "https://private.example",
	},
};
const stored = normalizeSceneAnalysis({ metadata: raw.metadata, duration: 10 });

function database(retainedRaw: unknown, document: unknown = stored) {
	const row: Record<string, unknown> = {
		id: "analysis-1",
		locale: "en",
		createdAt: new Date("2026-09-15"),
		raw: retainedRaw,
		document,
	};
	const findFirst = vi.fn(
		async ({ select }: { select: Record<string, boolean> }) =>
			Object.fromEntries(Object.entries(row).filter(([key]) => select[key])),
	);
	const db = {
		librarySource: {
			findUnique: vi.fn(async () => ({
				id: "source-1",
				jobId: null,
				originalJobId: "job-1",
				state: "READY",
				error: null,
				locales: ["en"],
				snapshot: {
					schemaVersion: 1,
					kind: "VOD_JOB",
					name: "Asset",
					planHash: "hash",
					identity: "UNVERIFIED",
					inputs: [],
					playbackLinks: [],
					qcVerdict: null,
					qcOverriddenAt: null,
				},
			})),
		},
		sceneAnalysisRevision: { findFirst },
		contentRevision: { findMany: vi.fn(async () => []) },
	};
	return { db: db as unknown as AppPrismaClient, row };
}

describe("Library source detail retained-raw projection", () => {
	it("recovers scene context and sanitized provider fields without changing history", async () => {
		const { db, row } = database(raw);
		const before = JSON.stringify(row);
		const view = await sourceView(db, "source-1");
		expect(view.analyses[0]?.document.scenes[0]?.content).toMatchObject({
			dynamics: { tension: "High", pacing: "Fast" },
			settings: [
				{ location: { name: "Garden" }, atmosphere: { mood: "Quiet" } },
			],
		});
		expect(view.analyses[0]?.document.omittedSubjectCount).toBe(1);
		expect(view.analyses[0]?.document).toMatchObject({ credits: raw.credits });
		expect(JSON.stringify(view)).not.toMatch(/private-secret|"raw"/);
		expect(view.analyses[0]?.providerAnalysis).toMatchObject({
			source: "PROVIDER",
			data: {
				inputLanguageCodes: raw.inputLanguageCodes,
				ratings: raw.ratings,
				futureAnalysis: raw.futureAnalysis,
				credits: raw.credits,
				privateProviderPayload: {
					token: "[REDACTED]",
					url: "https://private.example",
				},
			},
		});
		expect(JSON.stringify(row)).toBe(before);
	});
	it.each([
		null,
		{ metadata: { version: "" } },
		{ ...raw, duration: -1 },
	])("falls back to validated stored data when retained raw is unavailable or invalid: %#", async (retainedRaw) => {
		const fallback = {
			...stored,
			omittedSubjectCount: 3,
			credits: raw.credits,
			token: "private-secret",
		};
		const { db } = database(retainedRaw, fallback);
		const view = await sourceView(db, "source-1");
		expect(view.analyses[0]?.document).toEqual({
			...stored,
			omittedSubjectCount: 3,
			credits: raw.credits,
		});
		expect(JSON.stringify(view)).not.toContain("private-secret");
		expect(view.analyses[0]?.providerAnalysis).toMatchObject({
			source: "NORMALIZED",
			data: { credits: raw.credits },
		});
	});
	it("refuses an invalid stored fallback instead of returning unvalidated metadata", async () => {
		const { db } = database(null, { duration: -1, token: "private-secret" });
		await expect(sourceView(db, "source-1")).rejects.toThrow();
	});
});

it("retains literal provider field names through read-time redaction without changing history", async () => {
	const extras = JSON.parse(
		'{"__proto__":{"token":"private-secret","value":"kept"}}',
	);
	const { db, row } = database({ ...raw, extras });
	const before = JSON.stringify(row);
	const view = await sourceView(db, "source-1");
	const analysis = view.analyses[0]?.providerAnalysis;
	expect(analysis?.source).toBe("PROVIDER");
	expect(JSON.stringify(analysis?.data)).toContain(
		'"__proto__":{"token":"[REDACTED]","value":"kept"}',
	);
	expect(JSON.stringify(view)).not.toContain("private-secret");
	expect(JSON.stringify(row)).toBe(before);
	expect(Object.hasOwn(Object.prototype, "value")).toBe(false);
});

it("keeps valid stored analysis when secret masking expands provider display beyond 8 MiB", async () => {
	const large = {
		...raw,
		extra: Array.from({ length: 500_000 }, () => ({ token: "x" })),
	};
	expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(
		MAX_SCENE_ANALYSIS_BYTES,
	);
	const { db, row } = database(large);
	const view = await sourceView(db, "source-1");
	expect(view.analyses[0]?.providerAnalysis?.source).toBe("NORMALIZED");
	expect(view.analyses[0]?.document).toEqual(stored);
	expect(
		Buffer.byteLength(JSON.stringify(view.analyses[0]?.providerAnalysis?.data)),
	).toBeLessThanOrEqual(MAX_SCENE_ANALYSIS_BYTES);
	expect(row.raw).toBe(large);
});
