import {
	anyEditingDocumentSchema,
	type CompositionDocument,
	compositionDocumentSchema,
	hashEditingEvidence,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));

import {
	confirmEditingRevision,
	saveEditingDraft,
} from "./library-editing-projects";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const map = {
	id: id(2),
	mediaVersionId: id(2),
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 6_000_000,
	editingStartFrame: 0,
	editingEndFrame: 180,
	fps: { num: 30, den: 1 },
};
function document(sourceInUs = 0): CompositionDocument {
	return compositionDocumentSchema.parse({
		schemaVersion: 2,
		mediaVersionId: id(2),
		analysisRevisionId: id(7),
		locale: "en",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		timeMapId: id(2),
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		presentation: {
			version: "portrait-layout-v1",
			videoFit: "FILL",
			captionPlacement: "OVERLAY",
			centerCropConfirmed: false,
		},
		autoGeneration: {
			policyVersion: "aisa-shot-window-v1",
			requestHash: "d".repeat(64),
			requestedDurationFrames: 60,
			generatedDurationFrames: 60,
			reasonCodes: ["TRACKING_FIT_FALLBACK"],
			binding: {
				schemaVersion: 1,
				kind: "FIXTURE_AUTHORED",
				organizationId: id(5),
				sourceId: id(3),
				locale: "en",
				analysisRevisionId: id(7),
				analysisRawHash: "a".repeat(64),
				analysisDocumentHash: "b".repeat(64),
				mediaVersionId: id(2),
				mediaSha256: "c".repeat(64),
				timeMapId: id(2),
				timeMapHash: "e".repeat(64),
				sourceStartUs: 0,
				sourceEndUs: 6_000_000,
				width: 640,
				height: 360,
			},
		},
		clips: [
			{
				id: id(4),
				sourceInUs,
				durationFrames: 60,
				timelineStartFrame: 0,
				framing: [
					{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "AUTO_POLICY" },
					{
						fromFrame: 30,
						toFrame: 60,
						mode: "CROP",
						origin: "AISA_PROPOSAL",
						rect: { x: 0.3, y: 0, w: 0.3, h: 1 },
					},
				],
				evidence: { sceneId: id(8), shotIndex: 0 },
				audio: { mode: "SOURCE" },
			},
		],
	});
}
function fixtureRow() {
	return {
		id: id(1),
		contentId: id(3),
		title: "Reviewable portrait",
		variant: "PORTRAIT",
		draftRevision: 1,
		draft: document(),
		currentRevisionId: null as string | null,
		currentRevision: null as {
			id: string;
			document: CompositionDocument;
		} | null,
		mediaVersion: {
			id: id(2),
			sourceId: id(3),
			state: "READY",
			sha256: "c".repeat(64),
			error: null,
			width: 640,
			height: 360,
			durationUs: 6_000_000n,
			timeMap: map,
			probe: { streams: [{ codec_type: "audio" }] },
		},
		renderRuns: [],
	};
}
let row: ReturnType<typeof fixtureRow>;
let immutable: CompositionDocument[];
let afterTransaction: (() => void) | undefined;
beforeEach(() => {
	row = fixtureRow();
	immutable = [];
	afterTransaction = undefined;
	const delegates = {
		editProject: {
			findUnique: vi.fn(async () => structuredClone(row)),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { draftRevision: number };
					data: { draft: unknown };
				}) => {
					if (row.draftRevision !== where.draftRevision) return { count: 0 };
					row.draft = compositionDocumentSchema.parse(data.draft);
					row.draftRevision++;
					return { count: 1 };
				},
			),
			update: vi.fn(async ({ data }: { data: Partial<typeof row> }) => {
				Object.assign(row, data);
				return structuredClone(row);
			}),
		},
		editRevision: {
			create: vi.fn(async ({ data }: { data: { document: unknown } }) => {
				const saved = compositionDocumentSchema.parse(data.document);
				immutable.push(structuredClone(saved));
				row.currentRevision = { id: id(6), document: structuredClone(saved) };
				return { id: id(6), ...data };
			}),
		},
		editProjectResource: { createMany: vi.fn(async () => ({ count: 1 })) },
		libraryMediaVersion: { findMany: vi.fn(async () => []) },
		libraryImageAsset: { findMany: vi.fn(async () => []) },
		sceneAnalysisRevision: {
			findFirst: vi.fn(async () => ({
				id: id(7),
				sourceId: id(3),
				locale: "en",
				document: normalizeSceneAnalysis({
					metadata: { version: "presentation-confirmation-fixture" },
					duration: 6,
					scenes: [
						{
							id: id(8),
							type: "MAIN_CONTENT",
							startInSeconds: 0,
							endInSeconds: 6,
							shots: [{ startInSeconds: 0, endInSeconds: 6 }],
						},
					],
				}),
			})),
		},
		renderRun: { findFirst: vi.fn(async () => null) },
	};
	const prisma = {
		...delegates,
		$transaction: async <T>(action: (tx: typeof delegates) => Promise<T>) => {
			const snapshot = structuredClone(row),
				previous = structuredClone(immutable);
			try {
				const result = await action(delegates);
				afterTransaction?.();
				return result;
			} catch (error) {
				row = snapshot;
				immutable = previous;
				throw error;
			}
		},
	};
	holder.context = {
		prisma,
		tenant: { organizationId: id(5) },
	} as unknown as ServerContext;
});

describe("portrait presentation confirmation at the saved revision boundary", () => {
	it("normalizes edited subtitle translations at the API boundary without rewriting native evidence", async () => {
		row.draft.captions = [
			{
				id: id(9),
				fromFrame: 0,
				toFrame: 30,
				text: "Hello",
				translation: {
					targetLanguage: "ja",
					text: "こんにちは",
					sourceText: "Hello",
					sourceTextHash: hashEditingEvidence("Hello"),
					origin: "LOCAL_LLM",
					evidenceHash: "b".repeat(64),
				},
			},
		];
		const next = structuredClone(row.draft);
		const translation = next.captions?.[0]?.translation;
		if (!translation) throw Error("missing translation fixture");
		translation.text = "手直しした訳";
		const saved = await saveEditingDraft(id(1), {
			expectedRevision: 1,
			document: next,
		});
		if (saved.draft.schemaVersion !== 2) throw Error("composition");
		expect(saved.draft.captions?.[0]?.translation).toMatchObject({
			text: "手直しした訳",
			origin: "MANUAL",
			derivedFromEvidenceHash: "b".repeat(64),
		});
		expect(
			saved.draft.captions?.[0]?.translation?.evidenceHash,
		).toBeUndefined();
	});
	it("does not confirm a central fallback when the confirmation option is false", async () => {
		for (const clip of row.draft.clips)
			for (const framing of clip.framing) framing.origin = "MANUAL";
		const before = structuredClone(row);
		await expect(
			confirmEditingRevision(
				id(1),
				{ expectedRevision: 1, confirmSuggestions: false },
				"fixture",
			),
		).rejects.toMatchObject({ code: "UNCONFIRMED_FRAMING" });
		expect(row).toEqual(before);
		expect(immutable).toEqual([]);
	});
	it("confirms the central fallback and existing proposals only after an explicit confirmation, including a saved manualized draft", async () => {
		const next = document(1_000_000);
		const saved = await saveEditingDraft(id(1), {
			expectedRevision: 1,
			document: next,
		});
		expect(saved.draftRevision).toBe(2);
		expect(saved.draft.clips[0]?.framing[0]?.origin).toBe("MANUAL");
		if (saved.draft.schemaVersion !== 2) throw Error("Expected composition");
		expect(saved.draft.presentation?.centerCropConfirmed).toBe(false);
		const confirmed = await confirmEditingRevision(
			id(1),
			{ expectedRevision: 2, confirmSuggestions: true },
			"fixture",
		);
		if (confirmed.draft.schemaVersion !== 2)
			throw Error("Expected composition");
		expect(confirmed.draft.presentation?.centerCropConfirmed).toBe(true);
		expect(confirmed.draft.clips[0]?.framing[1]?.origin).toBe(
			"EDITOR_CONFIRMED",
		);
		expect(confirmed.draft.autoGeneration).toEqual(next.autoGeneration);
		expect(confirmed.draftRevision).toBe(3);
		expect(confirmed.currentRevisionId).toBe(id(6));
		expect(confirmed.currentRevisionMatchesDraft).toBe(true);
		expect(immutable).toEqual([confirmed.draft]);
		expect(row.renderRuns).toEqual([]);
	});
	it("refuses a stale confirmation without confirming a newer body or creating a revision", async () => {
		row.draft = document(2_000_000);
		row.draftRevision = 2;
		const newer = structuredClone(row);
		await expect(
			confirmEditingRevision(
				id(1),
				{ expectedRevision: 1, confirmSuggestions: true },
				"fixture",
			),
		).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
		expect(row).toEqual(newer);
		expect(immutable).toEqual([]);
	});
	it("returns the exact confirmed body when another editor immediately saves a later unconfirmed body", async () => {
		afterTransaction = () => {
			row.draft = document(2_000_000);
			row.draftRevision++;
		};
		const confirmed = await confirmEditingRevision(
			id(1),
			{ expectedRevision: 1, confirmSuggestions: true },
			"fixture",
		);
		if (confirmed.draft.schemaVersion !== 2)
			throw Error("Expected composition");
		expect(confirmed.draftRevision).toBe(2);
		expect(confirmed.draft.presentation?.centerCropConfirmed).toBe(true);
		expect(confirmed.currentRevisionMatchesDraft).toBe(true);
		expect(row.draftRevision).toBe(3);
		expect(row.draft.presentation?.centerCropConfirmed).toBe(false);
		expect(immutable).toEqual([
			anyEditingDocumentSchema.parse(confirmed.draft),
		]);
	});
});
