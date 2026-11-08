import { createHash } from "node:crypto";
import {
	canonicalEditingJson,
	cfrTimeMapSchema,
	editingAnalysisBindingSchema,
	editingMediaStorageSchema,
	hashEditingEvidence,
	librarySnapshotSchema,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import type { EditingMediaFacts } from "./media";

export const DIALOGUE_CONTENT_ID = "72b40340-2426-439e-8029-3e5dc764ee01";
export const DIALOGUE_SOURCE_ID = "72b40340-2426-439e-8029-3e5dc764ee02";
export const DIALOGUE_CREDENTIAL_ID = "72b40340-2426-439e-8029-3e5dc764ee03";
export const DIALOGUE_ANALYSIS_ID = "72b40340-2426-439e-8029-3e5dc764ee04";
export const DIALOGUE_MEDIA_ID = "72b40340-2426-439e-8029-3e5dc764ee05";
export const dialogueDemo = {
	id: "sintel-dialogue-v1",
	registrationKey: "editing-preview:dialogue:sintel:v1",
	objectKey: "fixtures/sintel-dialogue/v1/source.mp4",
	outputPrefix: "fixtures/sintel-dialogue/v1/generated/",
	title: "Sintel：原音声と字幕の検証（手動メタデータ）",
	original: {
		url: "https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4",
		bytes: 4372373,
		sha256: "b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254",
	},
	excerpt: { sourceStartSeconds: 12, durationSeconds: 14 },
	prepared: {
		bytes: 2061365,
		sha256: "498b9b18398810bf742007135530a32f0699516b6f6012c7f063ca1de0583cd7",
		width: 854,
		height: 480,
		frameCount: 420,
	},
	credit: {
		title: "Sintel trailer",
		creator: "Blender Foundation / Durian Open Movie Team",
		sourceUrl: "https://durian.blender.org/download/",
		sharingUrl: "https://durian.blender.org/sharing/",
		licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
		notice:
			"Sintel trailer © copyright Blender Foundation | durian.blender.org. CC BY 3.0. No endorsement implied.",
		changes: [
			"原本00:12–00:26の14秒を抜粋。声は映画の原音声であり合成音声ではない。",
			"24fpsから30fpsへ変換し、H.264/AAC48kHzに再エンコード。原本で未記載のcolor/SARはデモ注釈としてBT.709 limited・square pixelを仮定し明示。原本の色計測結果ではない。",
			"構図とシーン区間は目視による手動の目安。実AISA解析・精密検出・連続追跡の結果ではない。",
		],
	},
};
export const DIALOGUE_DESCRIPTION = [
	"英語の元映画音声を使い、実ローカルASRと強調字幕を試す14秒の検証素材です。メタデータは手作りであり、実AISAの解析結果ではありません。",
	dialogueDemo.credit.notice,
	`出典: ${dialogueDemo.credit.sourceUrl} / ライセンス: ${dialogueDemo.credit.licenseUrl}`,
	...dialogueDemo.credit.changes,
].join("\n");

export function dialogueInputArgument(args: readonly string[]): string {
	if (
		args.length === 2 &&
		args[0] === "--dialogue" &&
		args[1] === "/fixtures/sintel-dialogue-cfr30.mp4"
	)
		return args[1];
	throw new Error("PREVIEW_DIALOGUE_ARGUMENTS_INVALID");
}

export function assertDialogueMediaFacts(facts: EditingMediaFacts): void {
	const streams = Array.isArray(facts.probe.streams) ? facts.probe.streams : [];
	const audio = streams.find(
		(stream: unknown): stream is Record<string, unknown> =>
			!!stream &&
			typeof stream === "object" &&
			"codec_type" in stream &&
			stream.codec_type === "audio",
	);
	if (
		facts.width !== 854 ||
		facts.height !== 480 ||
		facts.frameCount !== 420 ||
		facts.durationUs !== 14_000_000 ||
		facts.fps.num !== 30 ||
		facts.fps.den !== 1 ||
		!facts.hasAudio ||
		Number(audio?.sample_rate) !== 48000 ||
		Number(audio?.channels) !== 2
	)
		throw new Error("PREVIEW_DIALOGUE_MEDIA_INVALID");
}

/** Authored source windows/boxes; dialogue words are NOT supplied to the ASR. */
export function dialogueAnalysis() {
	const windows = [
		{
			start: 0,
			end: 3.5,
			title: "老人の問いかけ",
			description: "室内の老人の顔。静的な目視box。",
			box: [180, 340, 880, 840],
		},
		{
			start: 3.5,
			end: 5,
			title: "Sintelの顔",
			description: "暗い室内に見える女性の顔。静的な目視box。",
			box: [220, 300, 850, 680],
		},
		{
			start: 5,
			end: 8.5,
			title: "街路のSintelと原音声",
			description:
				"街路にいる左寄りの人物。静的な目視boxで、話者位置の推定結果ではない。",
			box: [460, 350, 760, 410],
		},
		{
			start: 8.5,
			end: 14,
			title: "走る人物と屋上",
			description:
				"速い場面転換と広い屋上。追跡していないためFITで確認する区間。",
			box: null,
		},
	];
	return {
		metadata: {
			version: "manual-sintel-dialogue-v1",
			provenance: "MANUALLY_ANNOTATED_DEMO",
			generatedByAisa: false,
			voiceProvenance: "ORIGINAL_FILM_AUDIO",
			sourceSha256: dialogueDemo.original.sha256,
			preparedSha256: dialogueDemo.prepared.sha256,
			sourceStartSeconds: 12,
			timeDomain: "NORMALIZED_EXCERPT_CFR30",
			credit: dialogueDemo.credit,
		},
		duration: 14,
		title: dialogueDemo.title,
		description: DIALOGUE_DESCRIPTION,
		scenes: windows.map((entry, index) => ({
			id: `72b40340-2426-439e-8029-3e5dc764ee1${index}`,
			startInSeconds: entry.start,
			endInSeconds: entry.end,
			type: "MAIN_CONTENT",
			title: entry.title,
			summary: `${entry.description} 手動annotationであり実AISAではない。`,
			shots: [
				{
					startInSeconds: entry.start,
					endInSeconds: entry.end,
					detailedDescription: entry.description,
					mainSubjects: entry.box
						? [
								{
									classification: "Person",
									description: entry.description,
									appearanceTimeInSeconds: 0,
									centerX: (Number(entry.box[1]) + Number(entry.box[3])) / 20,
									centerY: (Number(entry.box[0]) + Number(entry.box[2])) / 20,
									box2d: entry.box,
								},
							]
						: [],
				},
			],
		})),
	};
}

export function dialogueSourceSnapshot() {
	return librarySnapshotSchema.parse({
		schemaVersion: 1,
		kind: "VOD_JOB",
		name: dialogueDemo.title,
		planHash: hashEditingEvidence({
			fixture: dialogueDemo.id,
			original: dialogueDemo.original.sha256,
			prepared: dialogueDemo.prepared.sha256,
		}),
		identity: "UNVERIFIED",
		inputs: [],
		playbackLinks: [
			{
				key: "mp4:sintel-dialogue",
				kind: "MP4",
				label: "Sintel原音声デモ（手動メタデータ）",
				url: null,
				path: dialogueDemo.objectKey,
				via: "AUTHENTICATED",
			},
		],
		fileOutputs: [
			{
				key: "mp4:sintel-dialogue",
				kind: "MP4",
				credentialId: DIALOGUE_CREDENTIAL_ID,
				bucket: "bitovp-editing-preview",
				path: dialogueDemo.objectKey,
			},
		],
		qcVerdict: null,
		qcOverriddenAt: null,
	});
}

type DialogueEvidence = {
	organizationId: string;
	source: {
		id: string;
		organizationId: string;
		sourceKey: string;
		snapshot: unknown;
	};
	analysis: {
		id: string;
		organizationId: string;
		sourceId: string;
		locale: string;
		rawHash: string;
		raw: unknown;
		document: unknown;
	};
	media: {
		id: string;
		organizationId: string;
		sourceId: string;
		state: string;
		sha256: string | null;
		width: number | null;
		height: number | null;
		durationUs: bigint | null;
		fpsNum: number | null;
		fpsDen: number | null;
		timeMap: unknown;
		storage: unknown;
	};
};
/** Requires actual file/probe/storage checks by the seed caller before this pure authoring gate. */
export function dialogueBindingProof(input: DialogueEvidence) {
	try {
		const { source, analysis, media, organizationId } = input;
		const expectedRaw = dialogueAnalysis();
		const expectedDocument = normalizeSceneAnalysis(expectedRaw);
		const map = cfrTimeMapSchema.parse(media.timeMap);
		const storage = editingMediaStorageSchema.parse(media.storage);
		if (
			source.id !== DIALOGUE_SOURCE_ID ||
			source.organizationId !== organizationId ||
			source.sourceKey !== dialogueDemo.registrationKey ||
			canonicalEditingJson(source.snapshot) !==
				canonicalEditingJson(dialogueSourceSnapshot()) ||
			analysis.id !== DIALOGUE_ANALYSIS_ID ||
			analysis.organizationId !== organizationId ||
			analysis.sourceId !== source.id ||
			analysis.locale !== "en" ||
			analysis.rawHash !==
				createHash("sha256")
					.update(JSON.stringify(expectedRaw))
					.digest("hex") ||
			hashEditingEvidence(analysis.raw) !== hashEditingEvidence(expectedRaw) ||
			hashEditingEvidence(analysis.document) !==
				hashEditingEvidence(expectedDocument) ||
			media.id !== DIALOGUE_MEDIA_ID ||
			media.organizationId !== organizationId ||
			media.sourceId !== source.id ||
			media.state !== "READY" ||
			media.sha256 !== dialogueDemo.prepared.sha256 ||
			media.width !== 854 ||
			media.height !== 480 ||
			media.durationUs !== 14_000_000n ||
			media.fpsNum !== 30 ||
			media.fpsDen !== 1 ||
			map.id !== media.id ||
			map.mediaVersionId !== media.id ||
			map.sourceStartUs !== 0 ||
			map.sourceEndUs !== 14_000_000 ||
			map.editingStartFrame !== 0 ||
			map.editingEndFrame !== 420 ||
			storage.source.credentialId !== DIALOGUE_CREDENTIAL_ID ||
			storage.source.bucket !== "bitovp-editing-preview" ||
			storage.source.key !== dialogueDemo.objectKey ||
			storage.source.size !== dialogueDemo.prepared.bytes ||
			!storage.source.expect ||
			storage.output.credentialId !== DIALOGUE_CREDENTIAL_ID ||
			storage.output.bucket !== "bitovp-editing-preview" ||
			storage.output.prefix !== dialogueDemo.outputPrefix ||
			(storage.prepared &&
				canonicalEditingJson(storage.prepared) !==
					canonicalEditingJson(storage.source))
		)
			throw new Error("changed");
		return editingAnalysisBindingSchema.parse({
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId,
			sourceId: source.id,
			locale: "en",
			analysisRevisionId: analysis.id,
			analysisRawHash: analysis.rawHash,
			analysisDocumentHash: hashEditingEvidence(analysis.document),
			mediaVersionId: media.id,
			mediaSha256: media.sha256,
			timeMapId: map.id,
			timeMapHash: hashEditingEvidence(media.timeMap),
			sourceStartUs: 0,
			sourceEndUs: 14_000_000,
			width: 854,
			height: 480,
		});
	} catch {
		throw new Error("PREVIEW_DIALOGUE_EVIDENCE_CHANGED");
	}
}
