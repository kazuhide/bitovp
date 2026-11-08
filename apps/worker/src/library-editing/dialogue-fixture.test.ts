import { createHash } from "node:crypto";
import {
	hashEditingEvidence,
	normalizeSceneAnalysis,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	assertDialogueMediaFacts,
	DIALOGUE_ANALYSIS_ID,
	DIALOGUE_CREDENTIAL_ID,
	DIALOGUE_MEDIA_ID,
	DIALOGUE_SOURCE_ID,
	dialogueAnalysis,
	dialogueBindingProof,
	dialogueDemo,
	dialogueInputArgument,
	dialogueSourceSnapshot,
} from "./dialogue-fixture";

const org = "00000000-0000-4000-8000-000000000001";
function evidence() {
	const raw = dialogueAnalysis();
	const map = {
		id: DIALOGUE_MEDIA_ID,
		mediaVersionId: DIALOGUE_MEDIA_ID,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 14_000_000,
		editingStartFrame: 0,
		editingEndFrame: 420,
		fps: { num: 30, den: 1 },
	};
	return {
		organizationId: org,
		source: {
			id: DIALOGUE_SOURCE_ID,
			organizationId: org,
			sourceKey: dialogueDemo.registrationKey,
			snapshot: dialogueSourceSnapshot(),
		},
		analysis: {
			id: DIALOGUE_ANALYSIS_ID,
			organizationId: org,
			sourceId: DIALOGUE_SOURCE_ID,
			locale: "en",
			rawHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
			raw,
			document: normalizeSceneAnalysis(raw),
		},
		media: {
			id: DIALOGUE_MEDIA_ID,
			organizationId: org,
			sourceId: DIALOGUE_SOURCE_ID,
			state: "READY",
			sha256: dialogueDemo.prepared.sha256,
			width: 854,
			height: 480,
			durationUs: 14_000_000n,
			fpsNum: 30,
			fpsDen: 1,
			timeMap: map,
			storage: {
				source: {
					credentialId: DIALOGUE_CREDENTIAL_ID,
					bucket: "bitovp-editing-preview",
					key: dialogueDemo.objectKey,
					size: dialogueDemo.prepared.bytes,
					expect: { etag: "fixed" },
				},
				output: {
					credentialId: DIALOGUE_CREDENTIAL_ID,
					bucket: "bitovp-editing-preview",
					prefix: dialogueDemo.outputPrefix,
				},
			},
		},
	};
}
describe("licensed original dialogue fixture authoring boundary", () => {
	it("records official source/license, exact excerpt bytes and authored metadata honestly", () => {
		expect(dialogueDemo.original.url).toBe(
			"https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4",
		);
		expect(dialogueDemo.original.sha256).toBe(
			"b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254",
		);
		expect(dialogueDemo.excerpt).toEqual({
			sourceStartSeconds: 12,
			durationSeconds: 14,
		});
		const raw = dialogueAnalysis();
		expect(raw.metadata.generatedByAisa).toBe(false);
		expect(raw.metadata.provenance).toBe("MANUALLY_ANNOTATED_DEMO");
		expect(raw.metadata.voiceProvenance).toBe("ORIGINAL_FILM_AUDIO");
		expect(dialogueDemo.credit.licenseUrl).toBe(
			"https://creativecommons.org/licenses/by/3.0/",
		);
		expect(dialogueDemo.credit.notice).toContain("Blender Foundation");
		expect(dialogueDemo.credit.changes.join(" ")).toContain("BT.709");
		expect(normalizeSceneAnalysis(raw).duration).toBe(14);
	});
	it("admits only the exact explicit readonly mount argument", () => {
		expect(
			dialogueInputArgument([
				"--dialogue",
				"/fixtures/sintel-dialogue-cfr30.mp4",
			]),
		).toBe("/fixtures/sintel-dialogue-cfr30.mp4");
		for (const args of [
			[],
			["--dialogue", "/tmp/input.mp4"],
			["--animation", "/fixtures/sintel-dialogue-cfr30.mp4"],
		])
			expect(() => dialogueInputArgument(args)).toThrow(
				"PREVIEW_DIALOGUE_ARGUMENTS_INVALID",
			);
	});
	it("seals the exact stored media/raw/document as FIXTURE_AUTHORED only", () => {
		const f = evidence();
		const proof = dialogueBindingProof(f);
		expect(proof.kind).toBe("FIXTURE_AUTHORED");
		expect(proof.analysisDocumentHash).toBe(
			hashEditingEvidence(f.analysis.document),
		);
		expect(verifyAutomaticAnalysisBinding({ ...f, bindings: [proof] })).toEqual(
			proof,
		);
	});
	it.each([
		"geometry",
		"frames",
		"audio",
		"channels",
	])("rejects a changed actual probe %s before publication", (field) => {
		const facts = {
			width: 854,
			height: 480,
			frameCount: 420,
			durationUs: 14_000_000,
			fps: { num: 30 as const, den: 1 as const },
			hasAudio: true,
			probe: {
				streams: [{ codec_type: "audio", sample_rate: "48000", channels: 2 }],
			},
		};
		assertDialogueMediaFacts(facts);
		if (field === "geometry") facts.width = 640;
		if (field === "frames") facts.frameCount = 419;
		if (field === "audio") facts.hasAudio = false;
		if (field === "channels") {
			const stream = facts.probe.streams[0];
			if (!stream) throw new Error("Missing fixture");
			stream.channels = 1;
		}
		expect(() => assertDialogueMediaFacts(facts)).toThrow(
			"PREVIEW_DIALOGUE_MEDIA_INVALID",
		);
	});
	it.each([
		[
			"tenant",
			(f: ReturnType<typeof evidence>) => {
				f.analysis.organizationId = "00000000-0000-4000-8000-000000000099";
			},
		],
		[
			"source",
			(f: ReturnType<typeof evidence>) => {
				f.source.sourceKey = "another-source";
			},
		],
		[
			"snapshot",
			(f: ReturnType<typeof evidence>) => {
				f.source.snapshot.name = "changed";
			},
		],
		[
			"raw",
			(f: ReturnType<typeof evidence>) => {
				f.analysis.raw.metadata.provenance = "PROVIDER";
			},
		],
		[
			"document",
			(f: ReturnType<typeof evidence>) => {
				f.analysis.document.title = "changed";
			},
		],
		[
			"rawHash",
			(f: ReturnType<typeof evidence>) => {
				f.analysis.rawHash = "e".repeat(64);
			},
		],
		[
			"prepared SHA",
			(f: ReturnType<typeof evidence>) => {
				f.media.sha256 = "e".repeat(64);
			},
		],
		[
			"geometry",
			(f: ReturnType<typeof evidence>) => {
				f.media.width = 640;
			},
		],
		[
			"READY",
			(f: ReturnType<typeof evidence>) => {
				f.media.state = "PENDING";
			},
		],
		[
			"time map",
			(f: ReturnType<typeof evidence>) => {
				f.media.timeMap.sourceStartUs = 1;
			},
		],
		[
			"object",
			(f: ReturnType<typeof evidence>) => {
				f.media.storage.source.key = "changed.mp4";
			},
		],
	])("cannot silently repair or author a modified %s tuple", (_label, mutate) => {
		const f = evidence();
		mutate(f);
		expect(() => dialogueBindingProof(f)).toThrow(
			"PREVIEW_DIALOGUE_EVIDENCE_CHANGED",
		);
	});
});
