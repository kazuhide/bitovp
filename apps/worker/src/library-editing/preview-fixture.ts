/** Local-only fixture. These are authored examples, never real provider output. */
export const PREVIEW_FIXTURE_VERSION = "v2";
export const PREVIEW_REGISTRATION_KEY = "editing-preview:synthetic:v2";
export const PREVIEW_CONTENT_ID = "72b20340-2426-439e-8029-3e5dc764ee01";
export const PREVIEW_SOURCE_ID = "72b20340-2426-439e-8029-3e5dc764ee02";
export const PREVIEW_OBJECT_KEY = "fixtures/v2/aisa-demo.mp4";
export const PREVIEW_TITLE = "AISA編集サンプル：3つの合成シーン";
export const PREVIEW_DESCRIPTION =
	"18秒の合成映像と手作りの検証用AISAメタデータです。実際のAISA解析結果ではありません。左・右・中央のマーカーで区間編集と縦型構図を試せます。";

export function previewSeedEnvironment(env: NodeJS.ProcessEnv) {
	let url: URL;
	try {
		url = new URL(env.DATABASE_URL ?? "");
	} catch {
		throw new Error("PREVIEW_ENVIRONMENT_REQUIRED");
	}
	if (
		env.BITOVP_EDITING_PREVIEW !== "1" ||
		url.protocol !== "postgresql:" ||
		url.hostname !== "postgres" ||
		url.pathname !== "/bitovp_editing_preview" ||
		url.username !== "bitovp_runtime" ||
		!env.EDITING_PREVIEW_S3_ACCESS_KEY ||
		!env.EDITING_PREVIEW_S3_SECRET_KEY
	)
		throw new Error("PREVIEW_ENVIRONMENT_REQUIRED");
	return {
		endpoint: "http://storage:8333",
		bucket: "bitovp-editing-preview",
		accessKeyId: env.EDITING_PREVIEW_S3_ACCESS_KEY,
		secretAccessKey: env.EDITING_PREVIEW_S3_SECRET_KEY,
	};
}

export function previewAnalysis() {
	const scenes = [
		{ start: 0, end: 6, x: 20, color: "緑", position: "左" },
		{ start: 6, end: 12, x: 80, color: "オレンジ", position: "右" },
		{ start: 12, end: 18, x: 50, color: "青", position: "中央" },
	];
	return {
		metadata: { version: `synthetic-preview-${PREVIEW_FIXTURE_VERSION}` },
		duration: 18,
		title: PREVIEW_TITLE,
		summary: PREVIEW_DESCRIPTION,
		scenes: scenes.map((scene, i) => ({
			id: `72b20340-2426-439e-8029-3e5dc764ee1${i}`,
			startInSeconds: scene.start,
			endInSeconds: scene.end,
			type: "MAIN_CONTENT",
			title: `合成シーン${i + 1}：${scene.position}の${scene.color}マーカー`,
			summary: `検証用に作成した中心点です。${scene.position}の${scene.color}マーカーを縦型に収める構図を試せます。`,
			shots: [
				{
					startInSeconds: scene.start,
					endInSeconds: scene.end,
					mainSubjects: [
						{
							classification: "Object",
							description: `合成映像の${scene.color}マーカー`,
							appearanceTimeInSeconds: 0,
							centerX: scene.x,
							centerY: 50,
						},
					],
				},
			],
		})),
	};
}

export function previewSourceSnapshot(credentialId: string) {
	return {
		schemaVersion: 1,
		kind: "VOD_JOB",
		name: PREVIEW_TITLE,
		planHash: "0".repeat(64),
		identity: "UNVERIFIED",
		inputs: [],
		playbackLinks: [
			{
				key: "mp4:editing-preview",
				kind: "MP4",
				label: "合成サンプル MP4",
				url: null,
				path: PREVIEW_OBJECT_KEY,
				via: "AUTHENTICATED",
			},
		],
		fileOutputs: [
			{
				key: "mp4:editing-preview",
				kind: "MP4",
				credentialId,
				bucket: "bitovp-editing-preview",
				path: PREVIEW_OBJECT_KEY,
			},
		],
		qcVerdict: null,
		qcOverriddenAt: null,
	};
}

/** Explicit H264 VUI signaling is required by the editing media profile. */
export function previewMediaArguments(path: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=960x540:rate=30",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000",
		"-t",
		"18",
		"-vf",
		[
			"drawbox=x=112:y=150:w=160:h=240:color=0x22c55e:t=fill:enable='lt(t,6)'",
			"drawbox=x=688:y=150:w=160:h=240:color=0xf97316:t=fill:enable='between(t,6,12)'",
			"drawbox=x=400:y=150:w=160:h=240:color=0x3b82f6:t=fill:enable='gte(t,12)'",
		].join(","),
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"24",
		"-threads",
		"2",
		"-pix_fmt",
		"yuv420p",
		"-color_primaries",
		"bt709",
		"-color_trc",
		"bt709",
		"-colorspace",
		"bt709",
		"-x264-params",
		"colorprim=bt709:transfer=bt709:colormatrix=bt709",
		"-c:a",
		"aac",
		"-b:a",
		"96k",
		"-movflags",
		"+faststart",
		path,
	];
}
