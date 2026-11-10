import { createReadStream } from "node:fs";
import {
	chmod,
	copyFile,
	link,
	mkdtemp,
	open,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	COMPOSITION_CAPTION_LINE_HEIGHT,
	COMPOSITION_COMPILER_VERSION,
	type CompositionAudioAutomation,
	type CompositionFrame,
	type CompositionPlan,
	type CompositionTextStyle,
	compileComposition,
	compositionCaptionRows,
	compositionRenderCanvas,
	evaluateCompositionFrame,
	evaluateCompositionVideoLayers,
	type PixelRect,
	resolveCompositionCaptionDisplay,
} from "@bitovp/core";
import { digestStream } from "@bitovp/storage";
import {
	assertLocalMediaPath,
	type EditingMediaFacts,
	probeEditingMedia,
} from "./media";
import { MediaOperationError, runMediaProcess } from "./process";

const invalid = (): never => {
	throw new MediaOperationError("INVALID_RENDER_RECIPE");
};
const number = (value: number) => {
	if (!Number.isFinite(value)) return invalid();
	return String(value);
};
const ramp = (value: string) => `max(0,min(1,${value}))`;
const transition = (local: string, duration: number) =>
	duration === 1 ? `gte(${local},0)` : ramp(`(${local})/${duration - 1}`);
export function compositionFilterScriptOption(version: string) {
	const major = Number(
		version.match(/^ffmpeg version n?(\d+)(?:\.|[- ])/i)?.[1],
	);
	if (!Number.isSafeInteger(major) || major < 5)
		throw new MediaOperationError("UNSUPPORTED_FFMPEG");
	return major >= 8 ? "-/filter_complex" : "-filter_complex_script";
}

/** Numeric expression generated solely from the shared, validated automation DTO. */
export function compositionAudioExpression(
	a: CompositionAudioAutomation,
): string {
	const local = "(t*30)";
	const output = `(${local}+${a.timelineStartFrame})`;
	const fade = `(${local}+${a.fadeWindow?.offsetFrames ?? 0})`;
	const duration = a.fadeWindow?.durationFrames ?? a.durationFrames;
	const factors = [number(10 ** (a.gainDb / 20))];
	if (a.fadeInFrames) factors.push(ramp(`${fade}/${a.fadeInFrames}`));
	if (a.fadeOutFrames)
		factors.push(ramp(`(${duration}-${fade})/${a.fadeOutFrames}`));
	if (a.transitionInFrames)
		factors.push(transition(local, a.transitionInFrames));
	if (a.transitionOut)
		factors.push(
			`(1-${transition(`(${output}-${a.transitionOut.fromFrame})`, a.transitionOut.durationFrames)})`,
		);
	if (a.ducking) {
		const duck = a.ducking;
		const low = number(10 ** (duck.gainDb / 20));
		let envelope = "1";
		for (const interval of duck.intervals) {
			let before = "1",
				after = "1";
			if (duck.attackFrames)
				before = `(1+(${low}-1)*${ramp(`(${output}-${interval.fromFrame}+${duck.attackFrames})/${duck.attackFrames}`)})`;
			if (duck.releaseFrames)
				after = `(${low}+(1-${low})*${ramp(`(${output}-${interval.toFrame})/${duck.releaseFrames}`)})`;
			const value = `if(lt(${output},${interval.fromFrame}),${before},if(lt(${output},${interval.toFrame}),${low},${after}))`;
			envelope = `min(${envelope},${value})`;
		}
		factors.push(envelope);
	}
	return factors.map((f) => `(${f})`).join("*");
}

/** libass escapes literal braces; a word-joiner prevents literal \N/\h commands. */
export function escapeCompositionAssText(text: string): string {
	return text
		.replace(/\\/g, "\\\u2060")
		.replace(/\{/g, "\\{")
		.replace(/\}/g, "\\}")
		.replace(/\r\n|\r|\n/g, "\\N")
		.replace(/\t/g, " ");
}
const assTime = (frame: number) => {
	const cs = Math.floor((frame * 100) / 30);
	return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
function assColor(input: string, opacity = 1) {
	const rgb = input.slice(1, 7);
	const alpha =
		(input.length === 9 ? Number.parseInt(input.slice(7, 9), 16) / 255 : 1) *
		opacity;
	return `&H${Math.round((1 - alpha) * 255)
		.toString(16)
		.padStart(
			2,
			"0",
		)}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}
function assPrimaryColor(input: string) {
	const color = assColor(input);
	return `{\\1c&H${color.slice(4)}&\\1a&H${color.slice(2, 4)}&}`;
}
function assHeader(
	canvas: { width: number; height: number },
	style: CompositionTextStyle,
	opacity = 1,
) {
	const fontSize = Math.max(1, Math.round(style.fontSize * canvas.height));
	const alignment =
		style.align === "LEFT" ? 7 : style.align === "RIGHT" ? 9 : 8;
	return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${canvas.width}\nPlayResY: ${canvas.height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Noto Sans CJK JP,${fontSize},${assColor(style.color, opacity)},${assColor(style.color, opacity)},${assColor(style.backgroundColor, opacity)},${assColor(style.backgroundColor, opacity)},0,0,0,0,100,100,0,0,3,${Math.max(1, Math.round(fontSize * 0.08))},0,${alignment},0,0,0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
}
function assEvent(
	from: number,
	to: number,
	text: string,
	rect: PixelRect,
	canvas: { width: number; height: number },
	style: CompositionTextStyle,
	captionFontOverride = false,
	captionRowOffset = 0,
) {
	const fontSize = Math.max(1, Math.round(style.fontSize * canvas.height));
	const fontOverride = captionFontOverride
		? `\\fs${fontSize}\\bord${Math.max(1, Math.round(fontSize * 0.08))}\\q2`
		: "";
	const x =
		style.align === "LEFT"
			? rect.x
			: style.align === "RIGHT"
				? rect.x + rect.w
				: rect.x + rect.w / 2;
	const y = Math.round((rect.y + captionRowOffset) * 1_000_000) / 1_000_000;
	return `Dialogue: 0,${assTime(from)},${assTime(to)},Default,,${rect.x},${canvas.width - rect.x - rect.w},${rect.y},,{\\pos(${x},${y})\\clip(${rect.x},${rect.y},${rect.x + rect.w},${rect.y + rect.h})${fontOverride}}${text}\n`;
}
export type CompositionRenderProgram = {
	canvas: { width: number; height: number };
	durationFrames: number;
	graph: string;
	files: { name: string; contents: string }[];
	needsFont: boolean;
	/** Separate decoders for concat segments avoid decoded-frame source fanout. */
	videoInputs?: { mediaVersionId: string; seekSeconds: number }[];
	planningMetrics: {
		videoFrameEvaluations: number;
		fullFrameEvaluations: number;
		fullDurationClipBranches: number;
		concatenatedTracks: number;
		graphBytes: number;
		commandBytes: number;
	};
};

/** Paths inside this private resource directory are generated, not document input. */
export function buildCompositionRenderProgram(
	input: CompositionPlan,
	canvas: { width: number; height: number },
	resourceDirectory: string,
): CompositionRenderProgram {
	if (
		input.schemaVersion !== 2 ||
		input.compilerVersion !== COMPOSITION_COMPILER_VERSION ||
		!/^\/[A-Za-z0-9/_.-]+$/.test(resourceDirectory)
	)
		return invalid();
	const plan = compileComposition(input.document, input.sources);
	const files: CompositionRenderProgram["files"] = [];
	const filters: string[] = [];
	const planningMetrics = {
		videoFrameEvaluations: 0,
		fullFrameEvaluations: 0,
		fullDurationClipBranches: plan.clips.length,
		concatenatedTracks: 0,
		graphBytes: 0,
		commandBytes: 0,
	};
	// Static text/overlay samples are bounded by document items, not video
	// duration. Video commands never repeat caption shaping or retain frames.
	const samples = new Map<number, CompositionFrame>();
	const sampleAt = (frame: number) => {
		let state = samples.get(frame);
		if (!state) {
			state = evaluateCompositionFrame(plan, frame, canvas);
			samples.set(frame, state);
			planningMetrics.fullFrameEvaluations++;
		}
		return state;
	};
	const videoAt = (frame: number) => {
		planningMetrics.videoFrameEvaluations++;
		return evaluateCompositionVideoLayers(plan, frame, canvas);
	};
	const tracks = [...new Set(plan.clips.map((c) => c.trackOrder))].sort(
		(a, b) => a - b,
	);
	const sequentialTracks = new Map<number, number[]>();
	const videoInputs: NonNullable<CompositionRenderProgram["videoInputs"]> = [];
	for (const order of tracks) {
		const indexes = plan.clips
			.flatMap((clip, index) => (clip.trackOrder === order ? [index] : []))
			.sort(
				(a, b) =>
					(plan.clips[a]?.outputFromFrame ?? 0) -
					(plan.clips[b]?.outputFromFrame ?? 0),
			);
		if (
			indexes.length > 1 &&
			indexes.every(
				(index, at) =>
					at === 0 ||
					(plan.clips[indexes[at - 1] ?? -1]?.outputToFrame ?? Infinity) <=
						(plan.clips[index]?.outputFromFrame ?? -1),
			)
		) {
			sequentialTracks.set(order, indexes);
			planningMetrics.fullDurationClipBranches -= indexes.length;
			planningMetrics.concatenatedTracks++;
		}
	}
	const sourceIndex = (id: string) => {
		const index = plan.sources.findIndex(
			(source) => source.mediaVersionId === id,
		);
		if (index < 0) return invalid();
		return index;
	};
	for (const [index, item] of plan.clips.entries()) {
		const sequential = sequentialTracks.has(item.trackOrder);
		const seekSeconds = sequential ? Math.floor(item.sourceFromFrame / 30) : 0;
		const videoIndex = sequential
			? plan.sources.length +
				(plan.document.imageAssets?.length ?? 0) +
				videoInputs.length
			: sourceIndex(item.mediaVersionId);
		if (sequential)
			videoInputs.push({ mediaVersionId: item.mediaVersionId, seekSeconds });
		// Seek only to an integer second. The remaining exact CFR frame offset
		// is trimmed in the filter, avoiding fractional-second seek rounding.
		const trimFromFrame = item.sourceFromFrame - seekSeconds * 30;
		const commands: string[] = [];
		let previous = "";
		const first = videoAt(item.outputFromFrame).find(
			(layer) => layer.clipId === item.clip.id,
		);
		if (!first) return invalid();
		let backdrop = first.backdrop;
		for (
			let frame = item.outputFromFrame;
			frame < item.outputToFrame;
			frame++
		) {
			const layer =
				frame === item.outputFromFrame
					? first
					: videoAt(frame).find((l) => l.clipId === item.clip.id);
			if (!layer) return invalid();
			backdrop ??= layer.backdrop;
			const r = layer.sourceRect;
			const d = layer.drawRect;
			const values = `crop@crop${index} w ${r.w},crop@crop${index} h ${r.h},crop@crop${index} x ${r.x},crop@crop${index} y ${r.y},scale@scale${index} w ${d.w},scale@scale${index} h ${d.h},colorchannelmixer@alpha${index} aa ${number(layer.opacity)}`;
			if (values !== previous)
				commands.push(
					`${(Math.floor(((frame - item.outputFromFrame) * 1000000) / 30) / 1000000).toFixed(6)} ${values};`,
				);
			previous = values;
		}
		const name = `clip-${index}.cmd`;
		files.push({ name, contents: `${commands.join("\n")}\n` });
		const l = first.layoutRect,
			d = first.drawRect,
			r = first.sourceRect;
		const tail = sequentialTracks.has(item.trackOrder)
			? `setsar=1,settb=1/30,setpts=N[clip${index}]`
			: `tpad=start=${item.outputFromFrame}:stop=${plan.durationFrames - item.outputToFrame}:start_mode=add:stop_mode=add:color=black@0,trim=end_frame=${plan.durationFrames},settb=1/30,setpts=N[clip${index}]`;
		if (backdrop) {
			const b = backdrop.sourceRect,
				bd = backdrop.drawRect,
				bc = backdrop.clipRect,
				shade = number(1 - backdrop.shadeOpacity);
			// One source frame feeds both branches; flatten before the clip's alpha.
			filters.push(
				`[${videoIndex}:v:0]trim=start_frame=${trimFromFrame}:end_frame=${trimFromFrame + item.clip.durationFrames},settb=1/30,setpts=N,format=yuv444p,split=2[backdropSource${index}][foregroundSource${index}]`,
				`[backdropSource${index}]crop=${b.w}:${b.h}:${b.x}:${b.y}:exact=1,scale=${bd.w}:${bd.h}:flags=lanczos,format=gbrp,gblur=sigma=${number(backdrop.blurPx)},colorchannelmixer=rr=${shade}:gg=${shade}:bb=${shade},crop=${bc.w}:${bc.h}:${bc.x - bd.x}:${bc.y - bd.y}:exact=1,format=rgba,pad=${canvas.width}:${canvas.height}:${bc.x}:${bc.y}:color=black@0[backdrop${index}]`,
				`[foregroundSource${index}]sendcmd=f=${resourceDirectory}/${name},crop@crop${index}=${r.w}:${r.h}:${r.x}:${r.y}:exact=1,scale@scale${index}=${d.w}:${d.h}:flags=lanczos,format=rgba,pad=${l.w}:${l.h}:x=floor((ow-iw)/4)*2:y=floor((oh-ih)/4)*2:color=black@0:eval=frame,pad=${canvas.width}:${canvas.height}:${l.x}:${l.y}:color=black@0[foreground${index}]`,
				`[backdrop${index}][foreground${index}]overlay=x=0:y=0:format=auto:shortest=1,colorchannelmixer@alpha${index}=aa=${number(first.opacity)},format=gbrap,premultiply=inplace=1,${tail}`,
			);
		} else
			filters.push(
				`[${videoIndex}:v:0]trim=start_frame=${trimFromFrame}:end_frame=${trimFromFrame + item.clip.durationFrames},settb=1/30,setpts=N,format=yuv444p,sendcmd=f=${resourceDirectory}/${name},crop@crop${index}=${r.w}:${r.h}:${r.x}:${r.y}:exact=1,scale@scale${index}=${d.w}:${d.h}:flags=lanczos,format=rgba,pad=${l.w}:${l.h}:x=floor((ow-iw)/4)*2:y=floor((oh-ih)/4)*2:color=black:eval=frame,pad=${canvas.width}:${canvas.height}:${l.x}:${l.y}:color=black@0,colorchannelmixer@alpha${index}=aa=${number(first.opacity)},format=gbrap,premultiply=inplace=1,${tail}`,
			);
	}
	filters.push(
		`color=c=black:s=${canvas.width}x${canvas.height}:r=30,trim=end_frame=${plan.durationFrames},settb=1/30,setpts=N,format=rgba[base0]`,
	);
	let current = "base0";
	for (const [trackNumber, order] of tracks.entries()) {
		const indexes = plan.clips.flatMap((clip, index) =>
			clip.trackOrder === order ? [index] : [],
		);
		let track = `clip${indexes[0]}`;
		const sequence = sequentialTracks.get(order);
		if (sequence) {
			const parts: string[] = [];
			let cursor = 0;
			const gap = (end: number) => {
				if (end === cursor) return;
				const label = `track${trackNumber}gap${parts.length}`;
				filters.push(
					`color=c=black@0:s=${canvas.width}x${canvas.height}:r=30,format=gbrap,trim=end_frame=${end - cursor},setsar=1,settb=1/30,setpts=N[${label}]`,
				);
				parts.push(label);
			};
			for (const index of sequence) {
				const clip = plan.clips[index];
				if (!clip) return invalid();
				gap(clip.outputFromFrame);
				parts.push(`clip${index}`);
				cursor = clip.outputToFrame;
			}
			gap(plan.durationFrames);
			track = `track${trackNumber}concat`;
			filters.push(
				`${parts.map((part) => `[${part}]`).join("")}concat=n=${parts.length}:v=1:a=0,settb=1/30,setpts=N[${track}]`,
			);
		}
		for (const [blendNumber, index] of (sequence
			? []
			: indexes.slice(1)
		).entries()) {
			const next = `track${trackNumber}blend${blendNumber}`;
			filters.push(
				`[${track}][clip${index}]blend=all_mode=addition:shortest=1[${next}]`,
			);
			track = next;
		}
		const straight = `straight${trackNumber}`;
		filters.push(`[${track}]unpremultiply=inplace=1,format=rgba[${straight}]`);
		const next = `base${trackNumber + 1}`;
		filters.push(
			`[${current}][${straight}]overlay=x=0:y=0:format=auto:shortest=1[${next}]`,
		);
		current = next;
	}
	let needsFont = false;
	const overlays = [...(plan.document.overlays ?? [])].sort(
		(a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1),
	);
	for (const [index, overlay] of overlays.entries()) {
		const state = sampleAt(overlay.fromFrame).overlays.find(
			(o) => o.id === overlay.id,
		);
		if (!state) return invalid();
		const rect = state.pixelRect;
		const next = `overlay${index}`;
		if (overlay.kind === "IMAGE") {
			const imageIndex = (plan.document.imageAssets ?? []).findIndex(
				(image) => image.id === overlay.assetId,
			);
			if (imageIndex < 0) return invalid();
			const inputIndex = plan.sources.length + imageIndex;
			filters.push(
				`[${inputIndex}:v:0]scale=${rect.w}:${rect.h}:flags=lanczos,format=rgba,colorchannelmixer=aa=${number(overlay.opacity)},settb=1/30,setpts=N[image${index}]`,
			);
			filters.push(
				`[${current}][image${index}]overlay=x=${rect.x}:y=${rect.y}:format=auto:enable='gte(n,${overlay.fromFrame})*lt(n,${overlay.toFrame})':eof_action=repeat[${next}]`,
			);
		} else {
			needsFont = true;
			const style = state.resolvedStyle;
			if (!style) return invalid();
			const name = `overlay-${index}.ass`;
			files.push({
				name,
				contents:
					assHeader(canvas, style, overlay.opacity) +
					assEvent(
						overlay.fromFrame,
						overlay.toFrame,
						escapeCompositionAssText(overlay.text),
						rect,
						canvas,
						style,
					),
			});
			filters.push(
				`[${current}]subtitles=filename=${resourceDirectory}/${name}:fontsdir=${resourceDirectory}/fonts:alpha=1[${next}]`,
			);
		}
		current = next;
	}
	if (plan.document.captions?.length) {
		needsFont = true;
		const first = plan.document.captions[0];
		const state = first
			? sampleAt(first.fromFrame).captions.find((c) => c.id === first.id)
			: undefined;
		if (!state) return invalid();
		let ass = assHeader(canvas, state.style);
		for (const originalCaption of plan.document.captions) {
			const caption = {
				...originalCaption,
				...resolveCompositionCaptionDisplay(
					originalCaption,
					plan.document.captionDisplayLanguage,
				),
			};
			const sample = sampleAt(caption.fromFrame).captions.find(
				(c) => c.id === caption.id,
			);
			if (!sample) return invalid();
			const rows = compositionCaptionRows({
				text: caption.text,
				width: sample.rect.w,
				fontSizePx: Math.max(
					1,
					Math.round(sample.style.fontSize * canvas.height),
				),
			});
			const boundaries = [
				...new Set([
					caption.fromFrame,
					caption.toFrame,
					...(caption.words ?? []).flatMap((w) => [w.fromFrame, w.toFrame]),
				]),
			].sort((a, b) => a - b);
			for (let i = 0; i < boundaries.length - 1; i++) {
				const from = boundaries[i],
					to = boundaries[i + 1];
				if (from === undefined || to === undefined) return invalid();
				const activeWords = (caption.words ?? []).filter(
					(w) => from >= w.fromFrame && from < w.toFrame,
				);
				for (const [rowIndex, row] of rows.entries()) {
					if (!row.text.length) continue;
					let text = "",
						position = 0;
					for (const word of activeWords) {
						const start = Math.max(word.startChar, row.offset) - row.offset,
							end =
								Math.min(word.endChar, row.offset + row.text.length) -
								row.offset;
						if (end <= start) continue;
						text +=
							escapeCompositionAssText(row.text.slice(position, start)) +
							assPrimaryColor(sample.style.emphasisColor) +
							escapeCompositionAssText(row.text.slice(start, end)) +
							assPrimaryColor(sample.style.color);
						position = end;
					}
					text += escapeCompositionAssText(row.text.slice(position));
					ass += assEvent(
						from,
						to,
						text,
						sample.rect,
						canvas,
						sample.style,
						true,
						rowIndex *
							Math.max(1, Math.round(sample.style.fontSize * canvas.height)) *
							COMPOSITION_CAPTION_LINE_HEIGHT,
					);
				}
			}
		}
		files.push({ name: "captions.ass", contents: ass });
		filters.push(
			`[${current}]subtitles=filename=${resourceDirectory}/captions.ass:fontsdir=${resourceDirectory}/fonts:alpha=1[captioned]`,
		);
		current = "captioned";
	}
	filters.push(
		`[${current}]format=yuv420p,setsar=1,settb=1/30,setpts=N[video]`,
	);
	for (const [index, item] of plan.audio.entries()) {
		const a = item.automation;
		const samples = a.durationFrames * 1600;
		const expression = compositionAudioExpression(a);
		filters.push(
			`[${sourceIndex(item.mediaVersionId)}:a:0]aresample=48000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${item.sourceFromFrame * 1600}:end_sample=${(item.sourceFromFrame + a.durationFrames) * 1600},asetpts=PTS-STARTPTS,apad=whole_len=${samples},atrim=end_sample=${samples},aeval=exprs='val(0)*(${expression})|val(1)*(${expression})',adelay=${a.timelineStartFrame * 1600}S:all=1,apad=whole_len=${plan.durationFrames * 1600},atrim=end_sample=${plan.durationFrames * 1600}[audio${index}]`,
		);
	}
	if (plan.audio.length)
		filters.push(
			`${plan.audio.map((_, i) => `[audio${i}]`).join("")}amix=inputs=${plan.audio.length}:normalize=0:duration=longest,atrim=end_sample=${plan.durationFrames * 1600},asetpts=PTS-STARTPTS[audio]`,
		);
	else
		filters.push(
			`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=${plan.durationFrames * 1600},asetpts=PTS-STARTPTS[audio]`,
		);
	const graph = filters.join(";\n");
	if (
		Buffer.byteLength(graph) > 1024 * 1024 ||
		files.reduce((sum, file) => sum + Buffer.byteLength(file.contents), 0) >
			32 * 1024 * 1024
	)
		throw new MediaOperationError("RECIPE_TOO_COMPLEX");
	return {
		canvas: { ...canvas },
		durationFrames: plan.durationFrames,
		graph,
		files,
		needsFont,
		...(videoInputs.length ? { videoInputs } : {}),
		planningMetrics: {
			...planningMetrics,
			graphBytes: Buffer.byteLength(graph),
			commandBytes: files
				.filter((file) => file.name.endsWith(".cmd"))
				.reduce((sum, file) => sum + Buffer.byteLength(file.contents), 0),
		},
	};
}

export type CompositionRenderSource = {
	mediaVersionId: string;
	sourcePath: string;
	sourceFacts: EditingMediaFacts;
};
export type CompositionRenderImage = { assetId: string; sourcePath: string };

/** Input order matches videoInputs in the program, after sources and PNGs. */
export function compositionVideoInputArgs(
	inputs: CompositionRenderProgram["videoInputs"],
	sources: readonly Pick<
		CompositionRenderSource,
		"mediaVersionId" | "sourcePath"
	>[],
): string[] {
	return (inputs ?? []).flatMap((item) => {
		const source = sources.find(
			(source) => source.mediaVersionId === item.mediaVersionId,
		);
		if (
			!source ||
			!Number.isSafeInteger(item.seekSeconds) ||
			item.seekSeconds < 0
		)
			return invalid();
		assertLocalMediaPath(source.sourcePath);
		return [
			"-threads",
			"1",
			"-protocol_whitelist",
			"file,pipe",
			"-format_whitelist",
			"mov",
			"-enable_drefs",
			"0",
			"-use_absolute_path",
			"0",
			"-ss",
			String(item.seekSeconds),
			"-an",
			"-sn",
			"-dn",
			"-i",
			source.sourcePath,
		];
	});
}
async function validatePng(
	path: string,
	ffprobe: string,
	signal?: AbortSignal,
	timeoutMs?: number,
) {
	assertLocalMediaPath(path);
	const metadata = await stat(path);
	if (
		!metadata.isFile() ||
		metadata.size < 24 ||
		metadata.size > 8 * 1024 * 1024
	)
		throw new MediaOperationError("INVALID_IMAGE_ASSET");
	const file = await open(path, "r");
	const header = Buffer.alloc(24);
	try {
		await file.read(header, 0, 24, 0);
	} finally {
		await file.close();
	}
	if (
		!header
			.subarray(0, 8)
			.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		header.toString("ascii", 12, 16) !== "IHDR"
	)
		throw new MediaOperationError("INVALID_IMAGE_ASSET");
	const width = header.readUInt32BE(16),
		height = header.readUInt32BE(20);
	if (width < 1 || height < 1 || width > 2048 || height > 2048)
		throw new MediaOperationError("INVALID_IMAGE_ASSET");
	const probe = await runMediaProcess(
		ffprobe,
		[
			"-v",
			"error",
			"-protocol_whitelist",
			"file,pipe",
			"-f",
			"png_pipe",
			"-i",
			path,
			"-show_frames",
			"-show_streams",
			"-of",
			"json",
		],
		{ signal, timeoutMs, maxOutputBytes: 1024 * 1024 },
	);
	let parsed: {
		streams?: { codec_name?: string; width?: number; height?: number }[];
		frames?: unknown[];
	};
	try {
		parsed = JSON.parse(probe.stdout);
	} catch {
		throw new MediaOperationError("INVALID_IMAGE_ASSET");
	}
	if (
		probe.stderr ||
		parsed.streams?.length !== 1 ||
		parsed.streams[0]?.codec_name !== "png" ||
		parsed.streams[0]?.width !== width ||
		parsed.streams[0]?.height !== height ||
		parsed.frames?.length !== 1
	)
		throw new MediaOperationError("INVALID_IMAGE_ASSET");
}

/** All source/image paths are already tenant-authorized and hash-pinned by the caller. */
export async function renderCompositionRecipe(input: {
	plan: CompositionPlan;
	sources: readonly CompositionRenderSource[];
	images?: readonly CompositionRenderImage[];
	destinationPath: string;
	mode: "PREVIEW" | "EXPORT";
	fontPath?: string;
	ffmpegPath?: string;
	ffprobePath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<
	Omit<EditingMediaFacts, "probe" | "fps"> & { sha256: string; bytes: number }
> {
	assertLocalMediaPath(input.destinationPath);
	if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
	if (input.plan.compilerVersion !== COMPOSITION_COMPILER_VERSION)
		return invalid();
	const plan = compileComposition(input.plan.document, input.plan.sources);
	const canvas = compositionRenderCanvas(plan.document.canvas, input.mode);
	if (
		input.sources.length !== plan.sources.length ||
		new Set(input.sources.map((s) => s.mediaVersionId)).size !==
			input.sources.length
	)
		return invalid();
	const sources = plan.sources.map((source) => {
		const local = input.sources.find(
			(item) => item.mediaVersionId === source.mediaVersionId,
		);
		if (!local) return invalid();
		assertLocalMediaPath(local.sourcePath);
		const facts = local.sourceFacts;
		if (
			resolve(local.sourcePath) === resolve(input.destinationPath) ||
			facts.width !== source.width ||
			facts.height !== source.height ||
			facts.hasAudio !== source.hasAudio ||
			facts.fps.num !== 30 ||
			facts.fps.den !== 1 ||
			!Number.isSafeInteger(facts.frameCount) ||
			facts.frameCount < source.timeMap.editingEndFrame
		)
			return invalid();
		return local;
	});
	const declared = plan.document.imageAssets ?? [];
	if (
		(input.images?.length ?? 0) !== declared.length ||
		new Set(input.images?.map((i) => i.assetId)).size !==
			(input.images?.length ?? 0)
	)
		return invalid();
	const images = declared.map((image) => {
		const local = input.images?.find((i) => i.assetId === image.id);
		if (!local) return invalid();
		if (resolve(local.sourcePath) === resolve(input.destinationPath))
			return invalid();
		return local;
	});
	for (const image of images)
		await validatePng(
			image.sourcePath,
			input.ffprobePath ?? "ffprobe",
			input.signal,
			input.timeoutMs,
		);
	const scratch = await mkdtemp(
		join(dirname(input.destinationPath), ".bitovp-composition-"),
	);
	let resources: string | undefined;
	let linked = false,
		complete = false;
	try {
		resources = await mkdtemp(join(tmpdir(), "bitovp-composition-"));
		const program = buildCompositionRenderProgram(plan, canvas, resources);
		if (program.needsFont) {
			const font =
				input.fontPath ??
				process.env.EDITING_FONT_PATH ??
				"/usr/local/share/fonts/bitovp/NotoSansCJKjp-Regular.otf";
			assertLocalMediaPath(font);
			const metadata = await stat(font).catch(() => {
				throw new MediaOperationError("FONT_UNAVAILABLE");
			});
			if (
				!metadata.isFile() ||
				metadata.size < 1000 ||
				metadata.size > 64 * 1024 * 1024
			)
				throw new MediaOperationError("FONT_UNAVAILABLE");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(join(resources, "fonts"), { mode: 0o700 });
			await copyFile(
				font,
				join(resources, "fonts", "NotoSansCJKjp-Regular.otf"),
			);
		}
		for (const file of program.files)
			await writeFile(join(resources, file.name), file.contents, {
				mode: 0o600,
				flag: "wx",
			});
		const graphPath = join(resources, "composition.ffgraph");
		await writeFile(graphPath, program.graph, { mode: 0o600, flag: "wx" });
		const output = join(scratch, "artifact.mp4");
		const inputs = sources.flatMap((source) => [
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
			source.sourcePath,
		]);
		const imageInputs = images.flatMap((image) => [
			"-threads",
			"1",
			"-protocol_whitelist",
			"file,pipe",
			"-f",
			"png_pipe",
			"-loop",
			"1",
			"-framerate",
			"30",
			"-i",
			image.sourcePath,
		]);
		const clipVideoInputs = compositionVideoInputArgs(
			program.videoInputs,
			sources,
		);
		const version = await runMediaProcess(
			input.ffmpegPath ?? "ffmpeg",
			["-version"],
			{ signal: input.signal, timeoutMs: input.timeoutMs },
		);
		const filterScriptOption = compositionFilterScriptOption(version.stdout);
		await runMediaProcess(
			input.ffmpegPath ?? "ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-n",
				...inputs,
				...imageInputs,
				...clipVideoInputs,
				"-filter_complex_threads",
				"1",
				filterScriptOption,
				graphPath,
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
				String(plan.durationFrames),
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
				output,
			],
			{ signal: input.signal, timeoutMs: input.timeoutMs },
		);
		const facts = await probeEditingMedia({
			sourcePath: output,
			ffprobePath: input.ffprobePath,
			signal: input.signal,
			timeoutMs: input.timeoutMs,
		});
		if (
			facts.frameCount !== plan.durationFrames ||
			facts.width !== canvas.width ||
			facts.height !== canvas.height ||
			!facts.hasAudio
		)
			throw new MediaOperationError("RENDER_VALIDATION_FAILED");
		const digest = await digestStream(createReadStream(output));
		if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
		await chmod(output, 0o600);
		await link(output, input.destinationPath);
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
		if (resources) await rm(resources, { recursive: true, force: true });
	}
}
