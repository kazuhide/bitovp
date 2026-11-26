import {
	type CompositionSourceFacts,
	type ContentDetail,
	type SceneAnalysisDocument,
	sceneAnalysisDocumentSchema,
} from "@bitovp/core";
import type { EditingMediaView } from "@/lib/library-editing";

const samples = [
	{
		title: "Big Buck Bunny",
		description: "A meadow, an unexpected encounter and a comic pursuit.",
		tags: ["animation", "bunny", "meadow"],
		scenes: [
			[
				"Morning in the meadow",
				"A rabbit wakes in a quiet meadow.",
				"草原の朝",
				"静かな草原でウサギが目を覚ます。",
			],
			[
				"An unexpected encounter",
				"Forest animals interrupt the peaceful morning.",
				"突然の出会い",
				"森の動物たちが穏やかな朝に現れる。",
			],
			[
				"A playful pursuit",
				"The animals dash past the trees.",
				"森の追いかけっこ",
				"動物たちが木々の間を駆け抜ける。",
			],
		],
	},
	{
		title: "Harbor at Sunrise",
		description: "A fictional harbor documentary with timed scene notes.",
		tags: ["documentary", "harbor", "sunrise"],
		scenes: [
			[
				"Empty pier",
				"A wide shot shows the harbor before sunrise.",
				"無人の桟橋",
				"日の出前の港を広い画角で映す。",
			],
			[
				"Fishing boats",
				"Small boats return as warm light reaches the water.",
				"漁船の帰港",
				"水面が朝日に照らされ、小さな漁船が戻ってくる。",
			],
			[
				"Market opens",
				"Fishers carry baskets into the morning market.",
				"朝市の開店",
				"漁師たちが籠を持って朝市に入る。",
			],
		],
	},
	{
		title: "Studio Interview",
		description:
			"A fictional interview for experimenting with rough cuts and captions.",
		tags: ["interview", "studio", "captions"],
		scenes: [
			[
				"Introduction",
				"The host introduces the guest.",
				"オープニング",
				"司会者がゲストを紹介する。",
			],
			[
				"The first cut",
				"The guest talks about assembling a short film.",
				"最初の編集",
				"ゲストが短編映像の編集について話す。",
			],
			[
				"Closing remarks",
				"The host asks what the guest will make next.",
				"次の作品",
				"司会者がゲストの次回作を尋ねる。",
			],
		],
	},
];

export function demoLibraryId(number: number) {
	return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

const duration = 24;

function demoAnalysis(
	sample: (typeof samples)[number],
	base: number,
	locale: "en" | "ja",
): SceneAnalysisDocument {
	const japanese = locale === "ja";
	return sceneAnalysisDocumentSchema.parse({
		providerVersion: "simulated",
		duration,
		title: sample.title,
		description: japanese
			? "デモ用に作成したシーン解析のサンプルです。"
			: "Scene analysis prepared for the demo.",
		keywords: sample.tags,
		scenes: sample.scenes.map(([name, summary, jaName, jaSummary], index) => {
			const startInSeconds = index * 8;
			const endInSeconds = startInSeconds + 8;
			return {
				id: demoLibraryId(base + (japanese ? 20 : 10) + index),
				startInSeconds,
				endInSeconds,
				type: "SCENE",
				title: japanese ? jaName : name,
				summary: japanese ? jaSummary : summary,
				keywords: sample.tags,
				shots: [
					{
						startInSeconds,
						endInSeconds,
						detailedDescription: japanese ? jaSummary : summary,
					},
				],
			};
		}),
	});
}

export function demoLibrarySamples(timestamp: number) {
	return samples.map((sample, index) => {
		const base = 1000 + index * 100;
		const id = demoLibraryId(base + 1);
		const sourceId = demoLibraryId(base + 2);
		const mediaVersionId = demoLibraryId(base + 3);
		const timeMapId = demoLibraryId(base + 4);
		const updatedAt = new Date(timestamp - index * 60000).toISOString();
		const analyses = (["en", "ja"] as const).map((locale, number) => ({
			id: demoLibraryId(base + 5 + number),
			locale,
			createdAt: updatedAt,
			document: demoAnalysis(sample, base, locale),
		}));
		const content: ContentDetail = {
			id,
			title: sample.title,
			description: sample.description,
			tags: sample.tags,
			locale: index === 1 ? "ja" : "en",
			revision: 1,
			archived: false,
			updatedAt,
			source: {
				id: sourceId,
				jobId: null,
				originalJobId: null,
				state: "READY",
				error: null,
				locales: ["en", "ja"],
				snapshot: {
					schemaVersion: 1,
					kind: "VOD_JOB",
					name: sample.title,
					planHash: "demo-library",
					identity: "UNVERIFIED",
					inputs: [],
					playbackLinks: [],
					qcVerdict: null,
					qcOverriddenAt: null,
				},
				analyses,
				contents: [{ id, title: sample.title, archived: false }],
			},
		};
		const facts: CompositionSourceFacts = {
			mediaVersionId,
			width: 1920,
			height: 1080,
			hasAudio: false,
			timeMap: {
				id: timeMapId,
				mediaVersionId,
				kind: "CFR",
				sourceStartUs: 0,
				sourceEndUs: duration * 1_000_000,
				editingStartFrame: 0,
				editingEndFrame: duration * 30,
				fps: { num: 30, den: 1 },
			},
		};
		const media: EditingMediaView = {
			id: mediaVersionId,
			sourceId,
			state: "READY",
			error: null,
			durationUs: facts.timeMap.sourceEndUs,
			width: facts.width,
			height: facts.height,
			timeMap: facts.timeMap,
			url: null,
		};
		return { content, media, facts, projectId: demoLibraryId(base + 7) };
	});
}
