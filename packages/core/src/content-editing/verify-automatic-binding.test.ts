import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import type { EditingAnalysisBinding } from "./automatic-binding";
import {
	AutomaticBindingError,
	hashEditingEvidence,
	verifyAutomaticAnalysisBinding,
} from "./verify-automatic-binding";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
	const organizationId = id(1);
	const media = {
		organizationId,
		id: id(2),
		sourceId: id(3),
		sha256: "a".repeat(64),
		width: 1280,
		height: 720,
		timeMap: {
			id: id(4),
			mediaVersionId: id(2),
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		},
		probe: {} as Record<string, unknown>,
	};
	const analysis = {
		organizationId,
		id: id(5),
		sourceId: id(3),
		locale: "ja",
		rawHash: "b".repeat(64),
		document: normalizeSceneAnalysis({
			metadata: { version: "binding-test" },
			duration: 2,
			scenes: [],
		}),
	};
	const binding: EditingAnalysisBinding = {
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId: media.sourceId,
		locale: analysis.locale,
		analysisRevisionId: analysis.id,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		mediaVersionId: media.id,
		mediaSha256: media.sha256,
		timeMapId: media.timeMap.id,
		timeMapHash: hashEditingEvidence(media.timeMap),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 1280,
		height: 720,
	};
	return {
		organizationId,
		media,
		analysis,
		binding,
		bindings: [binding] as unknown,
	};
}

function unverified(
	input: Parameters<typeof verifyAutomaticAnalysisBinding>[0],
) {
	expect(() => verifyAutomaticAnalysisBinding(input)).toThrowError(
		AutomaticBindingError,
	);
	try {
		verifyAutomaticAnalysisBinding(input);
	} catch (error) {
		expect(error).toMatchObject({ code: "ANALYSIS_BINDING_UNVERIFIED" });
	}
}

describe("automatic analysis evidence", () => {
	it("hashes canonical JSON rather than JSONB object insertion order", () => {
		expect(hashEditingEvidence({ b: 2, a: 1 })).toBe(
			"43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
		);
		expect(hashEditingEvidence({ a: { y: 2, x: 1 }, b: [1, 2] })).toBe(
			hashEditingEvidence({ b: [1, 2], a: { x: 1, y: 2 } }),
		);
		expect(hashEditingEvidence([1, 2])).not.toBe(hashEditingEvidence([2, 1]));
	});
	it.each([
		"FIXTURE_AUTHORED",
		"CAPTURED_INPUT",
	] as const)("returns a fully matching stored %s proof without upgrading its kind", (kind) => {
		const f = fixture();
		f.binding.kind = kind;
		expect(verifyAutomaticAnalysisBinding(f)).toEqual(f.binding);
	});
	it("selects a matching proof from the sealed append-only list", () => {
		const f = fixture();
		f.bindings = [{ ...f.binding, analysisRevisionId: id(90) }, f.binding];
		expect(
			verifyAutomaticAnalysisBinding({ ...f, binding: undefined }),
		).toEqual(f.binding);
	});
	it("accepts JSONB key reordering in saved snapshots, documents and time maps", () => {
		const f = fixture();
		const reversed = (value: object) =>
			Object.fromEntries(Object.entries(value).reverse());
		f.analysis.document = reversed(
			f.analysis.document,
		) as typeof f.analysis.document;
		f.media.timeMap = reversed(f.media.timeMap) as typeof f.media.timeMap;
		expect(
			verifyAutomaticAnalysisBinding({ ...f, binding: reversed(f.binding) }),
		).toEqual(f.binding);
	});
	it("does not treat equal source IDs or duration as evidence", () => {
		const f = fixture();
		f.bindings = undefined;
		unverified(f);
	});
	it("ignores a legacy probe proof when no database binding is supplied", () => {
		const f = fixture();
		f.media.probe.bitovpAnalysisBindings = [f.binding];
		f.bindings = undefined;
		unverified(f);
	});
	it.each([
		[
			"media organization",
			(f: ReturnType<typeof fixture>) => {
				f.media.organizationId = id(99);
			},
		],
		[
			"analysis organization",
			(f: ReturnType<typeof fixture>) => {
				f.analysis.organizationId = id(99);
			},
		],
		[
			"media source",
			(f: ReturnType<typeof fixture>) => {
				f.media.sourceId = id(99);
			},
		],
		[
			"analysis source",
			(f: ReturnType<typeof fixture>) => {
				f.analysis.sourceId = id(99);
			},
		],
		[
			"locale",
			(f: ReturnType<typeof fixture>) => {
				f.analysis.locale = "en";
			},
		],
		[
			"raw hash",
			(f: ReturnType<typeof fixture>) => {
				f.analysis.rawHash = "c".repeat(64);
			},
		],
		[
			"document",
			(f: ReturnType<typeof fixture>) => {
				f.analysis.document.title = "changed";
			},
		],
		[
			"source SHA",
			(f: ReturnType<typeof fixture>) => {
				f.media.sha256 = "c".repeat(64);
			},
		],
		[
			"geometry",
			(f: ReturnType<typeof fixture>) => {
				f.media.width = 720;
			},
		],
		[
			"time-map owner",
			(f: ReturnType<typeof fixture>) => {
				f.media.timeMap.mediaVersionId = id(99);
			},
		],
		[
			"time-map offset",
			(f: ReturnType<typeof fixture>) => {
				f.media.timeMap.sourceStartUs = 1_000_000;
				f.media.timeMap.sourceEndUs = 3_000_000;
			},
		],
		[
			"time-map frame offset",
			(f: ReturnType<typeof fixture>) => {
				f.media.timeMap.editingStartFrame = 30;
				f.media.timeMap.editingEndFrame = 90;
			},
		],
	])("rejects changed %s even when revision IDs remain fixed", (_name, mutate) => {
		const f = fixture();
		mutate(f);
		unverified(f);
	});
	it("requires the saved binding to be one exact stored entry", () => {
		const f = fixture();
		unverified({ ...f, binding: { ...f.binding, kind: "CAPTURED_INPUT" } });
	});
	it.each([
		null,
		{},
		[],
		[{ schemaVersion: 1 }],
		Array(26).fill(null),
	])("rejects malformed or over-limit evidence lists", (list) => {
		const f = fixture();
		f.bindings = list;
		unverified(f);
	});
	it("rejects an ambiguous matching authority when no saved snapshot is supplied", () => {
		const f = fixture();
		f.bindings = [f.binding, { ...f.binding, kind: "CAPTURED_INPUT" }];
		unverified({ ...f, binding: undefined });
	});
	it("allows an exact saved snapshot even if another authority also exists", () => {
		const f = fixture();
		f.bindings = [f.binding, { ...f.binding, kind: "CAPTURED_INPUT" }];
		expect(verifyAutomaticAnalysisBinding(f)).toEqual(f.binding);
	});
});
