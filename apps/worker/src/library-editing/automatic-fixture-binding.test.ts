import { createHash } from "node:crypto";
import {
	normalizeSceneAnalysis,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	ANIMATION_REGISTRATION_KEY,
	ANIMATION_SOURCE_ID,
	animationAnalysis,
	animationDemo,
} from "./animation-fixture";
import { sealAutomaticFixtureBindings } from "./automatic-fixture-binding";
import {
	PREVIEW_REGISTRATION_KEY,
	PREVIEW_SOURCE_ID,
	previewAnalysis,
} from "./preview-fixture";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const organizationId = id(1);
const sourceSha256 = "c".repeat(64);

function setup(kind: "ANIMATION" | "SYNTHETIC" = "ANIMATION") {
	const animation = kind === "ANIMATION";
	const sourceId = animation ? ANIMATION_SOURCE_ID : PREVIEW_SOURCE_ID;
	const raw = animation ? animationAnalysis() : previewAnalysis();
	const source = {
		id: sourceId,
		organizationId,
		sourceKey: animation
			? ANIMATION_REGISTRATION_KEY
			: PREVIEW_REGISTRATION_KEY,
	};
	const analysis = {
		id: id(3),
		organizationId,
		sourceId,
		locale: "ja",
		raw,
		rawHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
		document: normalizeSceneAnalysis(raw),
	};
	const media = {
		id: id(4),
		organizationId,
		sourceId,
		state: "READY",
		sha256: sourceSha256,
		width: animation ? 1280 : 960,
		height: animation ? 720 : 540,
		durationUs: animation ? 30_000_000n : 18_000_000n,
		fpsNum: 30,
		fpsDen: 1,
		timeMap: {
			id: id(4),
			mediaVersionId: id(4),
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: animation ? 30_000_000 : 18_000_000,
			editingStartFrame: 0,
			editingEndFrame: animation ? 900 : 540,
			fps: { num: 30, den: 1 },
		},
		probe: {
			streams: [{ codec_type: "video", width: animation ? 1280 : 960 }],
			privateProbeField: "retain",
		} as Record<string, unknown>,
	};
	const mediaRows = [media];
	const bindings: Array<{
		organizationId: string;
		mediaVersionId: string;
		analysisRevisionId: string;
		proof: Record<string, unknown>;
	}> = [];
	const db = {
		librarySource: { findUnique: vi.fn(async () => source) },
		sceneAnalysisRevision: { findMany: vi.fn(async () => [analysis]) },
		libraryMediaVersion: {
			findMany: vi.fn(async () =>
				mediaRows.filter((row) => row.state === "READY"),
			),
			updateMany: vi.fn(async () => {
				throw new Error("Prepared media versions are immutable");
			}),
		},
		libraryAnalysisBinding: {
			findFirst: vi.fn(
				async ({ where }) =>
					bindings.find(
						(row) =>
							row.organizationId === where.organizationId &&
							row.mediaVersionId === where.mediaVersionId &&
							row.analysisRevisionId === where.analysisRevisionId,
					) ?? null,
			),
			create: vi.fn(async ({ data }) => {
				if (
					bindings.some(
						(row) =>
							row.organizationId === data.organizationId &&
							row.mediaVersionId === data.mediaVersionId &&
							row.analysisRevisionId === data.analysisRevisionId,
					)
				)
					throw Object.assign(new Error("Duplicate binding"), {
						code: "P2002",
					});
				bindings.push(data);
				return data;
			}),
		},
	};
	const seal = () =>
		sealAutomaticFixtureBindings({
			prisma: db as unknown as AppPrismaClient,
			organizationId,
			fixture: kind,
			sourceSha256,
		});
	return { media, mediaRows, source, analysis, db, seal, bindings };
}

describe("local fixture automatic authoring manifest", () => {
	it.each([
		"ANIMATION",
		"SYNTHETIC",
	] as const)("adds only a FIXTURE_AUTHORED proof for the exact prepared %s fixture", async (kind) => {
		const f = setup(kind);
		const before = structuredClone(f.media);
		expect(await f.seal()).toEqual({ attached: 1, preserved: 0 });
		const binding = verifyAutomaticAnalysisBinding({
			organizationId,
			media: f.media,
			analysis: f.analysis,
			bindings: f.bindings.map((row) => row.proof),
		});
		expect(binding.kind).toBe("FIXTURE_AUTHORED");
		expect(binding.mediaSha256).toBe(sourceSha256);
		expect(binding.mediaSha256).not.toBe(animationDemo.source.sha256);
		expect(f.media.probe.privateProbeField).toBe("retain");
		expect(f.db.libraryAnalysisBinding.create).toHaveBeenCalledWith({
			data: {
				organizationId,
				mediaVersionId: f.media.id,
				analysisRevisionId: f.analysis.id,
				proof: binding,
			},
		});
		expect(f.media).toEqual(before);
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
	});
	it("preserves the existing proof and probe without any write when reseeded", async () => {
		const f = setup();
		await f.seal();
		const before = structuredClone({ media: f.media, bindings: f.bindings });
		f.db.libraryAnalysisBinding.create.mockClear();
		expect(await f.seal()).toEqual({ attached: 0, preserved: 1 });
		expect({ media: f.media, bindings: f.bindings }).toEqual(before);
		expect(f.db.libraryAnalysisBinding.create).not.toHaveBeenCalled();
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
	});
	it("permits preparation later and adds proof only after READY", async () => {
		const f = setup();
		f.media.state = "PENDING";
		expect(await f.seal()).toEqual({ attached: 0, preserved: 0 });
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
		expect(f.db.libraryAnalysisBinding.create).not.toHaveBeenCalled();
		f.media.state = "READY";
		expect(await f.seal()).toEqual({ attached: 1, preserved: 0 });
	});
	it("accepts the exact captured animation JSON storage representation without changing it", async () => {
		const f = setup();
		// The original Prisma JSON write rounded this one frame boundary in
		// both documents. The authored ingestion hash still identifies the input.
		f.analysis.raw = JSON.parse(
			JSON.stringify(f.analysis.raw).replaceAll(
				"18.966666666666665",
				"18.96666666666667",
			),
		) as typeof f.analysis.raw;
		f.analysis.document = normalizeSceneAnalysis(f.analysis.raw);
		const before = structuredClone(f.analysis);
		expect(await f.seal()).toEqual({ attached: 1, preserved: 0 });
		expect(f.analysis).toEqual(before);
		expect(
			verifyAutomaticAnalysisBinding({
				organizationId,
				media: f.media,
				analysis: f.analysis,
				bindings: f.bindings.map((row) => row.proof),
			}).kind,
		).toBe("FIXTURE_AUTHORED");
	});
	it.each([
		"raw",
		"document",
	] as const)("rejects an unregistered mixed storage representation of %s", async (field) => {
		const f = setup();
		f.analysis[field] = JSON.parse(
			JSON.stringify(f.analysis[field]).replaceAll(
				"18.966666666666665",
				"18.96666666666667",
			),
		);
		await expect(f.seal()).rejects.toThrow("PREVIEW_ANALYSIS_WAS_CHANGED");
		expect(f.db.libraryAnalysisBinding.create).not.toHaveBeenCalled();
	});
	it("rejects other sub-frame timestamp changes", async () => {
		const f = setup();
		f.analysis.raw = JSON.parse(
			JSON.stringify(f.analysis.raw).replaceAll(
				"18.966666666666665",
				"18.96666666666667",
			),
		) as typeof f.analysis.raw;
		f.analysis.raw.scenes = f.analysis.raw.scenes.map((scene, index) =>
			index === 0
				? { ...scene, endInSeconds: scene.endInSeconds + 1e-12 }
				: scene,
		);
		f.analysis.document = normalizeSceneAnalysis(f.analysis.raw);
		await expect(f.seal()).rejects.toThrow("PREVIEW_ANALYSIS_WAS_CHANGED");
		expect(f.db.libraryAnalysisBinding.create).not.toHaveBeenCalled();
	});
	it("accepts JSONB reordering without replacing raw or normalized analysis", async () => {
		const f = setup();
		const reversed = (value: object) =>
			Object.fromEntries(Object.entries(value).reverse());
		f.analysis.raw = reversed(f.analysis.raw) as typeof f.analysis.raw;
		f.analysis.document = reversed(
			f.analysis.document,
		) as typeof f.analysis.document;
		expect(await f.seal()).toEqual({ attached: 1, preserved: 0 });
	});
	it.each([
		[
			"source registration",
			(f: ReturnType<typeof setup>) => {
				f.source.sourceKey = "changed";
			},
		],
		[
			"analysis raw",
			(f: ReturnType<typeof setup>) => {
				f.analysis.raw = { ...f.analysis.raw, duration: 29 };
			},
		],
		[
			"analysis raw hash",
			(f: ReturnType<typeof setup>) => {
				f.analysis.rawHash = "e".repeat(64);
			},
		],
		[
			"analysis document",
			(f: ReturnType<typeof setup>) => {
				f.analysis.document.title = "changed";
			},
		],
		[
			"analysis organization",
			(f: ReturnType<typeof setup>) => {
				f.analysis.organizationId = id(99);
			},
		],
		[
			"source SHA",
			(f: ReturnType<typeof setup>) => {
				f.media.sha256 = animationDemo.source.sha256;
			},
		],
		[
			"dimensions",
			(f: ReturnType<typeof setup>) => {
				f.media.width = 1920;
			},
		],
		[
			"duration",
			(f: ReturnType<typeof setup>) => {
				f.media.durationUs = 30_000_001n;
			},
		],
		[
			"frame coverage",
			(f: ReturnType<typeof setup>) => {
				f.media.timeMap.editingEndFrame = 899;
			},
		],
		[
			"source offset",
			(f: ReturnType<typeof setup>) => {
				f.media.timeMap.sourceStartUs = 9_000_000;
				f.media.timeMap.sourceEndUs = 39_000_000;
			},
		],
		[
			"media organization",
			(f: ReturnType<typeof setup>) => {
				f.media.organizationId = id(99);
			},
		],
	])("refuses changed %s without repairing any existing row", async (_name, mutate) => {
		const f = setup();
		mutate(f);
		await expect(f.seal()).rejects.toThrow(/^PREVIEW_/);
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
		expect(f.db.libraryAnalysisBinding.create).not.toHaveBeenCalled();
	});
	it("retains other sealed proofs and refuses to replace a different proof for this analysis", async () => {
		const f = setup();
		await f.seal();
		const row = f.bindings[0];
		if (!row) throw new Error("Missing binding fixture");
		row.proof.mediaSha256 = "e".repeat(64);
		f.db.libraryAnalysisBinding.create.mockClear();
		await expect(f.seal()).rejects.toThrow("PREVIEW_BINDING_WAS_CHANGED");
		expect(f.db.libraryAnalysisBinding.create).not.toHaveBeenCalled();
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
	});
	it("appends after an unrelated proof without changing its bytes", async () => {
		const f = setup();
		await f.seal();
		const row = f.bindings[0];
		if (!row) throw new Error("Missing binding fixture");
		const other = {
			...row,
			analysisRevisionId: id(50),
			proof: { ...row.proof, analysisRevisionId: id(50) },
		};
		f.bindings.splice(0, 1, other);
		expect(await f.seal()).toEqual({ attached: 1, preserved: 0 });
		expect(f.bindings[0]).toEqual(other);
	});
	it("preserves one exact proof when a concurrent seed wins the unique key", async () => {
		const f = setup();
		await f.seal();
		f.db.libraryAnalysisBinding.findFirst.mockResolvedValueOnce(null);
		expect(await f.seal()).toEqual({ attached: 0, preserved: 1 });
		expect(f.bindings).toHaveLength(1);
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
		expect(f.media.probe.bitovpAnalysisBindings).toBeUndefined();
	});
	it("rejects a different concurrent winner without overwriting it", async () => {
		const f = setup();
		await f.seal();
		const row = f.bindings[0];
		if (!row) throw new Error("Missing binding fixture");
		row.proof.mediaSha256 = "d".repeat(64);
		const before = structuredClone(f.bindings);
		f.db.libraryAnalysisBinding.findFirst.mockResolvedValueOnce(null);
		await expect(f.seal()).rejects.toThrow("PREVIEW_BINDING_WAS_CHANGED");
		expect(f.bindings).toEqual(before);
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
	});
	it("does not reinterpret arbitrary database errors as a duplicate binding", async () => {
		const f = setup();
		f.db.libraryAnalysisBinding.create.mockRejectedValue(
			new Error("Unavailable database"),
		);
		await expect(f.seal()).rejects.toThrow("Unavailable database");
		expect(f.bindings).toHaveLength(0);
		expect(f.db.libraryMediaVersion.updateMany).not.toHaveBeenCalled();
	});
});
