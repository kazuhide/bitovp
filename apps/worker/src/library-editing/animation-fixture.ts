import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import manifest from "./animation-demo.json";

export const animationDemo = manifest;
export const ANIMATION_CONTENT_ID = "72b30340-2426-439e-8029-3e5dc764ee01";
export const ANIMATION_SOURCE_ID = "72b30340-2426-439e-8029-3e5dc764ee02";
export const ANIMATION_REGISTRATION_KEY =
	"editing-preview:animation:caminandes2:v1";
export const ANIMATION_OBJECT_KEY = "fixtures/caminandes2/v1/source.mp4";
export const ANIMATION_TITLE = "Caminandes 2：アニメの縦型構図デモ";
export const ANIMATION_DESCRIPTION = [
	"検証用に作成した手動メタデータ。実AISAの解析結果ではありません。公式アニメの30秒抜粋を目視した静的な中心・大きさの目安であり、精密な検出・連続追跡ではありません。",
	manifest.credit.notice,
	`出典: ${manifest.credit.sourceUrl} / ライセンス: ${manifest.credit.licenseUrl}`,
	manifest.credit.changes.join("。"),
	manifest.credit.colorAssumption,
].join("\n");

/** Only the explicit, read-only Compose mount can opt into the additional film. */
export function animationInputArgument(args: readonly string[]): string | null {
	if (args.length === 0) return null;
	if (
		args.length === 2 &&
		args[0] === "--animation" &&
		args[1] === "/fixtures/caminandes2.mp4"
	)
		return args[1];
	throw new Error("PREVIEW_ANIMATION_ARGUMENTS_INVALID");
}

/** Verify the immutable owned copy that FFmpeg will consume, not a reopened host path. */
export async function copyVerifiedAnimationSource(
	inputPath: string,
	destinationPath: string,
	expected: { bytes: number; sha256: string } = manifest.source,
) {
	const invalid = () => new Error("PREVIEW_ANIMATION_SOURCE_INVALID");
	const input = await open(
		inputPath,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	).catch(() => {
		throw invalid();
	});
	let owned = false;
	try {
		const facts = await input.stat();
		if (!facts.isFile() || facts.size !== expected.bytes) throw invalid();
		let bytes = 0;
		const sha = createHash("sha256");
		const output = createWriteStream(destinationPath, {
			flags: "wx",
			mode: 0o600,
		});
		output.once("open", () => {
			owned = true;
		});
		await pipeline(
			input.createReadStream(),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					bytes += chunk.length;
					if (bytes > expected.bytes) {
						callback(invalid());
						return;
					}
					sha.update(chunk);
					callback(null, chunk);
				},
			}),
			output,
		);
		if (bytes !== expected.bytes || sha.digest("hex") !== expected.sha256)
			throw invalid();
	} catch {
		if (owned) await rm(destinationPath, { force: true });
		throw invalid();
	} finally {
		await input.close().catch(() => {});
	}
}

export function animationAnalysis() {
	return {
		metadata: {
			version: "manual-animation-caminandes2-v1",
			...manifest.metadata,
			sourceStartSeconds: manifest.excerpt.sourceStartSeconds,
			sourceSha256: manifest.source.sha256,
			credit: manifest.credit,
		},
		duration: manifest.excerpt.durationSeconds,
		title: ANIMATION_TITLE,
		summary:
			"実映像を目視して作った6つのshot annotation。自動AISA解析ではなく、静的な中心・大きさを比較するための検証用データです。",
		scenes: manifest.shots.map((shot, index) => {
			const [ymin, xmin, ymax, xmax] = shot.box2d;
			if (
				shot.box2d.length !== 4 ||
				ymin === undefined ||
				xmin === undefined ||
				ymax === undefined ||
				xmax === undefined
			)
				throw new Error("PREVIEW_ANIMATION_METADATA_INVALID");
			const box: [number, number, number, number] = [ymin, xmin, ymax, xmax];
			return {
				id: `72b30340-2426-439e-8029-3e5dc764ee1${index}`,
				startInSeconds: shot.startFrame / 30,
				endInSeconds: shot.endFrame / 30,
				type: "MAIN_CONTENT",
				title: shot.title,
				summary: `${shot.description} 手動のデモannotationであり、AISAの実行結果ではありません。`,
				shots: [
					{
						startInSeconds: shot.startFrame / 30,
						endInSeconds: shot.endFrame / 30,
						mainSubjects: [
							{
								classification: shot.classification,
								description: shot.description,
								appearanceTimeInSeconds: 0,
								centerX: (box[1] + box[3]) / 20,
								centerY: (box[0] + box[2]) / 20,
								box2d: box,
							},
						],
					},
				],
			};
		}),
	};
}

export function animationSourceSnapshot(credentialId: string) {
	const file = {
		key: "mp4:animation-demo",
		kind: "MP4",
		credentialId,
		bucket: "bitovp-editing-preview",
		path: ANIMATION_OBJECT_KEY,
	};
	return {
		schemaVersion: 1,
		kind: "VOD_JOB",
		name: ANIMATION_TITLE,
		planHash: "0".repeat(64),
		identity: "UNVERIFIED",
		inputs: [],
		playbackLinks: [
			{
				key: file.key,
				kind: "MP4",
				label: "Caminandes 2・30秒抜粋",
				url: null,
				path: file.path,
				via: "AUTHENTICATED",
			},
		],
		fileOutputs: [file],
		qcVerdict: null,
		qcOverriddenAt: null,
	};
}

export function animationMediaArguments(
	inputPath: string,
	destinationPath: string,
): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-ss",
		"9",
		"-i",
		inputPath,
		"-t",
		"30",
		"-map",
		"0:v:0",
		"-map",
		"0:a:0",
		"-vf",
		"fps=30:start_time=0,scale=1280:720:flags=lanczos:in_color_matrix=bt709:out_color_matrix=bt709,setsar=1",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"21",
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
		"-ar",
		"48000",
		"-movflags",
		"+faststart",
		destinationPath,
	];
}
