import { createReadStream } from "node:fs";
import { chmod, link, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAX_EDIT_FRAMING_SEGMENTS, type RenderRecipe } from "@bitovp/core";
import { digestStream } from "@bitovp/storage";
import {
	assertLocalMediaPath,
	type EditingMediaFacts,
	probeEditingMedia,
} from "./media";
import { MediaOperationError, runMediaProcess } from "./process";

export {
	type CompositionRenderImage,
	type CompositionRenderSource,
	renderCompositionRecipe,
} from "./composition-render";

export type EditingRenderMode = "PREVIEW" | "EXPORT";
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const invalid = (): never => {
	throw new MediaOperationError("INVALID_RENDER_RECIPE");
};

export function editingRenderCanvas(
	canvas: RenderRecipe["canvas"],
	mode: EditingRenderMode,
) {
	if (
		!(
			(canvas.width === 1920 && canvas.height === 1080) ||
			(canvas.width === 1080 && canvas.height === 1920)
		)
	)
		return invalid();
	if (mode === "EXPORT") return { ...canvas };
	if (mode !== "PREVIEW") return invalid();
	const factor = 640 / Math.max(canvas.width, canvas.height);
	return {
		width: Math.round((canvas.width * factor) / 2) * 2,
		height: Math.round((canvas.height * factor) / 2) * 2,
	};
}

/** RenderRecipe is compiler-owned: no raw user filter text crosses this boundary. */
export function buildEditingFilterGraph(
	recipe: RenderRecipe,
	facts: EditingMediaFacts,
	mode: EditingRenderMode,
): string {
	const canvas = editingRenderCanvas(recipe.canvas, mode);
	if (
		recipe.schemaVersion !== 1 ||
		recipe.compilerVersion !== "content-editing-v1" ||
		recipe.fps.num !== 30 ||
		recipe.fps.den !== 1 ||
		facts.fps.num !== 30 ||
		facts.fps.den !== 1
	)
		return invalid();
	if (
		!integer(recipe.durationFrames) ||
		recipe.durationFrames < 1 ||
		recipe.durationFrames > 5400 ||
		!recipe.segments.length ||
		recipe.segments.length > MAX_EDIT_FRAMING_SEGMENTS
	)
		return invalid();
	if (
		!integer(facts.width) ||
		!integer(facts.height) ||
		facts.width < 2 ||
		facts.height < 2 ||
		!integer(facts.frameCount)
	)
		return invalid();
	const filters: string[] = [];
	let cursor = 0;
	for (const [index, segment] of recipe.segments.entries()) {
		if (
			![
				segment.editingStartFrame,
				segment.editingEndFrame,
				segment.timelineStartFrame,
				segment.durationFrames,
			].every(integer) ||
			segment.timelineStartFrame !== cursor ||
			segment.durationFrames < 1 ||
			segment.editingEndFrame - segment.editingStartFrame !==
				segment.durationFrames ||
			segment.editingEndFrame > facts.frameCount
		)
			return invalid();
		cursor += segment.durationFrames;
		let framing: string;
		if (segment.framing.mode === "CROP") {
			const { x, y, w, h } = segment.framing.rect;
			if (
				![x, y, w, h].every(Number.isFinite) ||
				x < 0 ||
				y < 0 ||
				w <= 0 ||
				h <= 0 ||
				x + w > 1 + 1e-12 ||
				y + h > 1 + 1e-12
			)
				return invalid();
			const left = Math.round(x * facts.width);
			const top = Math.round(y * facts.height);
			const width = Math.round((x + w) * facts.width) - left;
			const height = Math.round((y + h) * facts.height) - top;
			if (
				width < 1 ||
				height < 1 ||
				left + width > facts.width ||
				top + height > facts.height
			)
				return invalid();
			framing = `format=yuv444p,crop=${width}:${height}:${left}:${top}:exact=1,scale=${canvas.width}:${canvas.height}:flags=lanczos`;
		} else if (segment.framing.mode === "FIT") {
			framing = `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
		} else return invalid();
		filters.push(
			`[0:v:0]trim=start_frame=${segment.editingStartFrame}:end_frame=${segment.editingEndFrame},setpts=PTS-STARTPTS,${framing},setsar=1,format=yuv420p,settb=1/30,setpts=N[v${index}]`,
		);
		const samples = segment.durationFrames * 1600;
		if (segment.audio.mode === "SOURCE" && facts.hasAudio) {
			filters.push(
				`[0:a:0]aresample=48000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${segment.editingStartFrame * 1600}:end_sample=${segment.editingEndFrame * 1600},asetpts=PTS-STARTPTS,apad=whole_len=${samples},atrim=end_sample=${samples}[a${index}]`,
			);
		} else if (
			segment.audio.mode === "MUTE" ||
			segment.audio.mode === "SOURCE"
		) {
			filters.push(
				`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a${index}]`,
			);
		} else return invalid();
	}
	if (cursor !== recipe.durationFrames) return invalid();
	filters.push(
		`${recipe.segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${recipe.segments.length}:v=1:a=1[video][audio]`,
	);
	const graph = filters.join(";\n");
	if (Buffer.byteLength(graph) > 100_000)
		throw new MediaOperationError("RECIPE_TOO_COMPLEX");
	return graph;
}

export async function renderEditingRecipe(input: {
	sourcePath: string;
	destinationPath: string;
	recipe: RenderRecipe;
	sourceFacts: EditingMediaFacts;
	mode: EditingRenderMode;
	ffmpegPath?: string;
	ffprobePath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<
	Omit<EditingMediaFacts, "probe" | "fps"> & { sha256: string; bytes: number }
> {
	assertLocalMediaPath(input.sourcePath);
	assertLocalMediaPath(input.destinationPath);
	if (resolve(input.sourcePath) === resolve(input.destinationPath))
		throw new MediaOperationError("INVALID_LOCAL_PATH");
	const graph = buildEditingFilterGraph(
		input.recipe,
		input.sourceFacts,
		input.mode,
	);
	const canvas = editingRenderCanvas(input.recipe.canvas, input.mode);
	if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
	const scratch = await mkdtemp(
		join(dirname(input.destinationPath), ".bitovp-render-"),
	);
	let linked = false;
	let complete = false;
	try {
		const outputPath = join(scratch, "artifact.mp4");
		await runMediaProcess(
			input.ffmpegPath ?? "ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-n",
				"-threads",
				"2",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				"mov",
				"-enable_drefs",
				"0",
				"-use_absolute_path",
				"0",
				"-i",
				input.sourcePath,
				"-filter_complex_threads",
				"2",
				"-filter_complex",
				graph,
				"-map",
				"[video]",
				"-map",
				"[audio]",
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"18",
				"-threads",
				"2",
				"-pix_fmt",
				"yuv420p",
				"-r",
				"30",
				"-fps_mode",
				"cfr",
				"-frames:v",
				String(input.recipe.durationFrames),
				"-video_track_timescale",
				"30000",
				"-movie_timescale",
				"30000",
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
				"-ar",
				"48000",
				"-ac",
				"2",
				"-b:a",
				"192k",
				"-movflags",
				"+faststart",
				"-f",
				"mp4",
				outputPath,
			],
			{ signal: input.signal, timeoutMs: input.timeoutMs },
		);
		const facts = await probeEditingMedia({
			sourcePath: outputPath,
			ffprobePath: input.ffprobePath,
			signal: input.signal,
			timeoutMs: input.timeoutMs,
		});
		if (
			facts.frameCount !== input.recipe.durationFrames ||
			facts.width !== canvas.width ||
			facts.height !== canvas.height ||
			!facts.hasAudio
		)
			throw new MediaOperationError("RENDER_VALIDATION_FAILED");
		const digest = await digestStream(createReadStream(outputPath));
		if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
		await chmod(outputPath, 0o600);
		await link(outputPath, input.destinationPath);
		linked = true;
		if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
		complete = true;
		return {
			...digest,
			width: facts.width,
			height: facts.height,
			durationUs: facts.durationUs,
			frameCount: facts.frameCount,
			hasAudio: facts.hasAudio,
		};
	} finally {
		if (linked && !complete) await rm(input.destinationPath, { force: true });
		await rm(scratch, { recursive: true, force: true });
	}
}
