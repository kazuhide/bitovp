"use client";
import {
	COMPOSITION_CAPTION_LINE_HEIGHT,
	type CompositionFrame,
	type CompositionPlan,
	type CompositionTextStyle,
	compositionCaptionRows,
	evaluateCompositionFrame,
	type NormalizedCropRect,
} from "@bitovp/core";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCompositionCopy } from "./composition-copy";
import {
	CompositionSourceFrameBridge,
	type CompositionSourceFrameReader,
} from "./composition-source-frame";
import { describeDirectCropFromPlan } from "./direct-crop-model";
import { useSourceCropCopy } from "./source-crop-copy";
import { SourceCropEditor } from "./source-crop-editor";

export type CompositionCropControls = {
	clipId: string;
	contextKey: string;
	disabled: boolean;
	active: boolean;
	onStart: () => boolean;
	onPreview: (rect: NormalizedCropRect) => void;
	onCommit: (rect: NormalizedCropRect) => void;
	onCancel: () => void;
};

type Media = { id: string; url: string | null };
type ImageAsset = { id: string; url: string };
const textSegmenter =
	typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;
const closingPunctuation = /^[\p{Pe}\p{Pf}、。，．,.!?！？:;：；…‥％%]/u;
function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number) {
	const lines: { text: string; offset: number }[] = [];
	if (!text) return lines;
	const space = (value: string) =>
		/^\s+$/u.test(value) && !/[\u00a0\u202f\ufeff]/u.test(value);
	let offset = 0;
	for (const paragraph of text.split("\n")) {
		let position = 0;
		const segments = textSegmenter
			? [...textSegmenter.segment(paragraph)]
			: Array.from(paragraph, (segment) => {
					const index = position;
					position += segment.length;
					return { segment, index };
				});
		const index = (at: number) => segments[at]?.index ?? paragraph.length;
		if (!segments.length) lines.push({ text: "", offset });
		let start = 0;
		while (start < segments.length) {
			let end = start,
				spaceBreak = start;
			while (end < segments.length) {
				// One over-wide grapheme is kept intact and clipped by the text rect.
				if (
					end > start &&
					ctx.measureText(paragraph.slice(index(start), index(end + 1))).width >
						width
				)
					break;
				if (space(segments[end]?.segment ?? "")) spaceBreak = end + 1;
				end++;
			}
			if (end < segments.length) {
				if (spaceBreak > start && !space(segments[end]?.segment ?? ""))
					end = spaceBreak;
				let before = end,
					after = end;
				while (
					before > start + 1 &&
					closingPunctuation.test(segments[before]?.segment ?? "")
				)
					before--;
				while (
					after < segments.length &&
					closingPunctuation.test(segments[after]?.segment ?? "")
				)
					after++;
				// Avoid a closing-mark orphan only when its preceding grapheme and
				// the complete closing run can share a line without exceeding width.
				if (
					before < end &&
					!closingPunctuation.test(segments[before]?.segment ?? "") &&
					ctx.measureText(paragraph.slice(index(before), index(after))).width <=
						width
				)
					end = before;
			}
			let visibleEnd = end;
			while (
				visibleEnd > start &&
				space(segments[visibleEnd - 1]?.segment ?? "")
			)
				visibleEnd--;
			lines.push({
				text: paragraph.slice(index(start), index(visibleEnd)),
				offset: offset + index(start),
			});
			start = end;
			// Soft-wrap whitespace becomes a line separator; offsets stay on the
			// original UTF-16 string so measured word highlighting does not shift.
			while (start < segments.length && space(segments[start]?.segment ?? ""))
				start++;
		}
		offset += paragraph.length + 1;
	}
	return lines;
}
function paintText(
	ctx: CanvasRenderingContext2D,
	text: string,
	rect: { x: number; y: number; w: number; h: number },
	style: CompositionTextStyle,
	height: number,
	words: { startChar: number; endChar: number }[] = [],
	caption = false,
) {
	const size = Math.max(1, Math.round(style.fontSize * height));
	ctx.font = `${size}px BitOVPEditing, sans-serif`;
	ctx.textBaseline = "top";
	ctx.save();
	ctx.beginPath();
	ctx.rect(rect.x, rect.y, rect.w, rect.h);
	ctx.clip();
	const lines = caption
		? compositionCaptionRows({ text, width: rect.w, fontSizePx: size })
		: wrapText(ctx, text, rect.w);
	lines.forEach((row, index) => {
		if (!row.text.length) return;
		const width = ctx.measureText(row.text).width,
			x =
				style.align === "LEFT"
					? rect.x
					: style.align === "RIGHT"
						? rect.x + rect.w - width
						: rect.x + (rect.w - width) / 2,
			y =
				rect.y +
				index * size * (caption ? COMPOSITION_CAPTION_LINE_HEIGHT : 1.15);
		ctx.fillStyle = style.backgroundColor;
		ctx.fillRect(
			x - size * 0.08,
			y,
			width + size * 0.16,
			size * (caption ? COMPOSITION_CAPTION_LINE_HEIGHT : 1.15),
		);
		const boundaries = [
			...new Set([
				0,
				row.text.length,
				...words.flatMap((word) => [
					Math.max(0, Math.min(row.text.length, word.startChar - row.offset)),
					Math.max(0, Math.min(row.text.length, word.endChar - row.offset)),
				]),
			]),
		].sort((a, b) => a - b);
		for (let index = 0; index < boundaries.length - 1; index++) {
			const from = boundaries[index] ?? 0,
				to = boundaries[index + 1] ?? from;
			if (to <= from) continue;
			const active = words.some(
				(word) =>
					word.startChar <= row.offset + from &&
					word.endChar >= row.offset + to,
			);
			ctx.fillStyle = active ? style.emphasisColor : style.color;
			ctx.fillText(
				row.text.slice(from, to),
				x + ctx.measureText(row.text.slice(0, from)).width,
				y,
			);
		}
	});
	ctx.restore();
}

/** Crossfades add premultiplied clip pixels within each track before source-over track composition. */
export function paintCompositionFrame(
	ctx: CanvasRenderingContext2D,
	state: CompositionFrame,
	videos: Map<string, HTMLVideoElement>,
	images: Map<string, HTMLImageElement>,
	scratch: HTMLCanvasElement,
	clipScratch: HTMLCanvasElement,
) {
	const { width, height } = state.canvas;
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = "source-over";
	ctx.fillStyle = "black";
	ctx.fillRect(0, 0, width, height);
	scratch.width = width;
	scratch.height = height;
	clipScratch.width = width;
	clipScratch.height = height;
	const track = scratch.getContext("2d");
	const clipContext = clipScratch.getContext("2d");
	if (!track || !clipContext) return;
	const orders = [
		...new Set(state.layers.map((layer) => layer.trackOrder)),
	].sort((a, b) => a - b);
	for (const order of orders) {
		track.clearRect(0, 0, width, height);
		track.globalCompositeOperation = "lighter";
		for (const layer of state.layers.filter(
			(item) => item.trackOrder === order,
		)) {
			const video = videos.get(layer.clipId);
			if (!video || video.readyState < 2) continue;
			const s = layer.sourceRect,
				d = layer.drawRect;
			clipContext.clearRect(0, 0, width, height);
			clipContext.fillStyle = "black";
			const layout = layer.layoutRect;
			clipContext.fillRect(layout.x, layout.y, layout.w, layout.h);
			if (layer.backdrop) {
				const backdrop = layer.backdrop,
					b = backdrop.sourceRect,
					draw = backdrop.drawRect,
					clip = backdrop.clipRect;
				clipContext.save();
				clipContext.beginPath();
				clipContext.rect(clip.x, clip.y, clip.w, clip.h);
				clipContext.clip();
				clipContext.filter = `blur(${backdrop.blurPx}px)`;
				clipContext.drawImage(
					video,
					b.x,
					b.y,
					b.w,
					b.h,
					draw.x,
					draw.y,
					draw.w,
					draw.h,
				);
				clipContext.filter = "none";
				clipContext.fillStyle = `rgba(0,0,0,${backdrop.shadeOpacity})`;
				clipContext.fillRect(clip.x, clip.y, clip.w, clip.h);
				clipContext.restore();
			}
			clipContext.drawImage(video, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
			track.globalAlpha = layer.opacity;
			track.drawImage(clipScratch, 0, 0);
		}
		ctx.drawImage(scratch, 0, 0);
	}
	for (const overlay of state.overlays) {
		ctx.save();
		ctx.globalAlpha = overlay.opacity;
		if (overlay.kind === "IMAGE") {
			const image = images.get(overlay.assetId),
				r = overlay.pixelRect;
			if (image?.complete && image.naturalWidth > 0)
				ctx.drawImage(image, r.x, r.y, r.w, r.h);
		} else if (overlay.resolvedStyle)
			paintText(
				ctx,
				overlay.text,
				overlay.pixelRect,
				overlay.resolvedStyle,
				height,
			);
		ctx.restore();
	}
	for (const caption of state.captions)
		paintText(
			ctx,
			caption.text,
			caption.rect,
			caption.style,
			height,
			caption.activeWords,
			true,
		);
}

export function CompositionPreview({
	plan,
	media,
	imageAssets,
	frame,
	onFrame,
	onSourceFrameReader,
	onSourceFrameAvailabilityChange,
	sourceCrop,
}: {
	plan: CompositionPlan;
	media: Media[];
	imageAssets: ImageAsset[];
	frame: number;
	onFrame: (frame: number) => void;
	onSourceFrameReader?: (reader: CompositionSourceFrameReader | null) => void;
	onSourceFrameAvailabilityChange?: () => void;
	sourceCrop?: CompositionCropControls;
}) {
	const c = useCompositionCopy(),
		comparisonCopy = useSourceCropCopy(),
		canvas = useRef<HTMLCanvasElement>(null),
		sourceCanvas = useRef<HTMLCanvasElement>(null),
		scratch = useRef<HTMLCanvasElement | null>(null),
		clipScratch = useRef<HTMLCanvasElement | null>(null);
	const videos = useRef(new Map<string, HTMLVideoElement>()),
		images = useRef(new Map<string, HTMLImageElement>()),
		audio = useRef(new Map<string, HTMLAudioElement>());
	const sound = useRef<{
		context: AudioContext;
		gains: Map<HTMLAudioElement, GainNode>;
	} | null>(null);
	const [playing, setPlaying] = useState(false),
		[failed, setFailed] = useState(false),
		[fontFailed, setFontFailed] = useState(false),
		[loading, setLoading] = useState(true);
	const [captionTracks, setCaptionTracks] = useState<Record<string, string>>(
		{},
	);
	const sourceClipId = sourceCrop?.clipId;
	const sourceDescription = useMemo(
		() =>
			sourceClipId
				? describeDirectCropFromPlan(plan, sourceClipId, frame)
				: null,
		[plan, sourceClipId, frame],
	);
	const heldCropFrame = useRef<{
		contextKey: string;
		clipId: string;
		mediaVersionId: string;
		sourceFrame: number;
		sourceUrl: string;
	} | null>(null);
	const [cropReady, setCropReady] = useState({ contextKey: "", ready: false });
	useEffect(() => {
		const time = (value: number) =>
			new Date((Math.max(0, value) * 1000) / 30).toISOString().slice(11, 23);
		const urls: Record<string, string> = {};
		for (const item of plan.audio) {
			const start = item.automation.timelineStartFrame,
				end = start + item.automation.durationFrames;
			const cues = (plan.document.captions ?? []).flatMap((caption) => {
				const from = Math.max(start, caption.fromFrame),
					to = Math.min(end, caption.toFrame);
				if (to <= from) return [];
				const text = caption.text
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;");
				return [
					`${time(item.sourceFromFrame + from - start)} --> ${time(item.sourceFromFrame + to - start)}\n${text}\n`,
				];
			});
			urls[item.id] = URL.createObjectURL(
				new Blob([`WEBVTT\n\n${cues.join("\n")}`], { type: "text/vtt" }),
			);
		}
		setCaptionTracks(urls);
		return () => {
			for (const url of Object.values(urls)) URL.revokeObjectURL(url);
		};
	}, [plan]);
	const latest = useRef({
		plan,
		frame,
		onFrame,
		playing,
		media,
		onSourceFrameReader,
		onSourceFrameAvailabilityChange,
		sourceCrop,
	});
	latest.current = {
		plan,
		frame,
		onFrame,
		playing,
		media,
		onSourceFrameReader,
		onSourceFrameAvailabilityChange,
		sourceCrop,
	};
	const sourceFrameBridge = useRef<CompositionSourceFrameBridge | null>(null);
	sourceFrameBridge.current ??= new CompositionSourceFrameBridge(
		() => latest.current,
		() => document.createElement("canvas"),
	);
	const invalidateCropFrame = useCallback((clipId: string) => {
		const controls = latest.current.sourceCrop;
		if (!controls || controls.clipId !== clipId) return;
		heldCropFrame.current = null;
		setCropReady({ contextKey: "", ready: false });
		controls.onCancel();
	}, []);
	const sourceFrameReader = useCallback<CompositionSourceFrameReader>(
		(clipId) => sourceFrameBridge.current?.read(clipId) ?? null,
		[],
	);
	useEffect(() => {
		onSourceFrameReader?.(sourceFrameReader);
		return () => onSourceFrameReader?.(null);
	}, [onSourceFrameReader, sourceFrameReader]);
	useEffect(() => () => sourceFrameBridge.current?.clear(), []);
	const gainFor = useCallback((element: HTMLAudioElement) => {
		const value = sound.current;
		if (!value) return undefined;
		let gain = value.gains.get(element);
		if (!gain) {
			gain = value.context.createGain();
			value.context.createMediaElementSource(element).connect(gain);
			gain.connect(value.context.destination);
			value.gains.set(element, gain);
		}
		return gain;
	}, []);
	useEffect(() => {
		const active = new Set(
			plan.audio.map((item) => audio.current.get(item.id)),
		);
		for (const [element, gain] of sound.current?.gains ?? [])
			if (!active.has(element)) {
				element.pause();
				gain.disconnect();
				sound.current?.gains.delete(element);
			}
	}, [plan]);
	useEffect(() => {
		let active = true;
		let ownedFont: FontFace | undefined;
		const controller = new AbortController();
		if (typeof FontFace !== "undefined") {
			// FontFace URL requests bypass the document's organization-bound fetch.
			fetch("/api/library/editing-font", { signal: controller.signal })
				.then(async (response) => {
					if (!response.ok) throw new Error("EDITING_FONT_UNAVAILABLE");
					return new FontFace(
						"BitOVPEditing",
						await response.arrayBuffer(),
					).load();
				})
				.then((font) => {
					if (active) {
						document.fonts.add(font);
						ownedFont = font;
					}
				})
				.catch(() => {
					if (active) setFontFailed(true);
				});
		}
		return () => {
			active = false;
			controller.abort();
			if (ownedFont) document.fonts.delete(ownedFont);
			void sound.current?.context.close();
			sound.current = null;
		};
	}, []);
	useEffect(() => {
		let active = true;
		const attempts = new WeakMap<
			HTMLMediaElement,
			{ interrupted: boolean; source: string }
		>();
		const interrupt = (element: HTMLMediaElement) => {
			const pending = attempts.get(element);
			if (pending) pending.interrupted = true;
		};
		const pauseMedia = (element: HTMLMediaElement) => {
			interrupt(element);
			element.pause();
		};
		const seekMedia = (element: HTMLMediaElement, time: number) => {
			interrupt(element);
			element.currentTime = time;
		};
		const playMedia = (element: HTMLMediaElement) => {
			if (attempts.has(element)) return;
			const attempt = { interrupted: false, source: element.src };
			attempts.set(element, attempt);
			const finish = () => {
				if (attempts.get(element) === attempt) attempts.delete(element);
			};
			const rejected = (failure: unknown) => {
				finish();
				if (!active || !element.isConnected || element.src !== attempt.source)
					return;
				if (
					attempt.interrupted &&
					failure &&
					typeof failure === "object" &&
					"name" in failure &&
					failure.name === "AbortError" &&
					!element.error
				)
					return;
				setFailed(true);
				setPlaying(false);
			};
			try {
				void element.play().then(finish, rejected);
			} catch (failure) {
				rejected(failure);
			}
		};
		// RAF timestamps may precede effect setup; start the clock in its first callback.
		let handle = 0,
			previous: number | undefined,
			previousReady = false,
			fraction = 0;
		scratch.current ??= document.createElement("canvas");
		clipScratch.current ??= document.createElement("canvas");
		const tick = (now: number) => {
			const current = latest.current,
				state = evaluateCompositionFrame(current.plan, current.frame, {
					width: current.plan.document.canvas.width / 3,
					height: current.plan.document.canvas.height / 3,
				});
			let ready = true;
			const activeMedia = new Map<
				HTMLMediaElement,
				{ sourceSeconds: number; gain?: GainNode; volume?: number }
			>();
			for (const [id, video] of videos.current) {
				const layer = state.layers.find((item) => item.clipId === id);
				if (!layer) {
					pauseMedia(video);
					continue;
				}
				activeMedia.set(video, { sourceSeconds: layer.sourceSeconds });
			}
			for (const [id, element] of audio.current) {
				const item = state.audio.find((entry) => entry.id === id),
					gain = gainFor(element);
				if (!item || !playing) {
					pauseMedia(element);
					if (gain) gain.gain.value = 0;
					continue;
				}
				activeMedia.set(element, {
					sourceSeconds: item.sourceSeconds,
					gain: gain ?? undefined,
					volume: item.gain,
				});
			}
			// Seek all active sources to this held frame before starting any of them.
			// A pending play must be allowed to settle, rather than paused every RAF.
			const playPending = [...activeMedia.keys()].some((item) =>
				attempts.has(item),
			);
			for (const [element, item] of activeMedia) {
				if (element.error) {
					ready = false;
					pauseMedia(element);
					setFailed(true);
					setPlaying(false);
					continue;
				}
				if (
					!playPending &&
					Math.abs(element.currentTime - item.sourceSeconds) >
						(playing ? 0.09 : 0.012) &&
					!element.seeking
				) {
					pauseMedia(element);
					seekMedia(element, item.sourceSeconds);
				}
				if (element.seeking || element.readyState < 2) ready = false;
			}
			// HAVE_CURRENT_DATA can paint a paused frame; playback needs future data.
			const mediaReady = ready;
			if (
				playing &&
				[...activeMedia.keys()].some((item) => item.readyState < 3)
			)
				ready = false;
			for (const element of activeMedia.keys()) {
				if (!playing || !ready) pauseMedia(element);
				else if (playPending) {
					if (!attempts.has(element)) pauseMedia(element);
				} else if (element.paused) playMedia(element);
			}
			if (playing && [...activeMedia.keys()].some((item) => attempts.has(item)))
				ready = false;
			for (const { gain, volume } of activeMedia.values()) {
				if (gain) gain.gain.value = ready ? (volume ?? 0) : 0;
			}
			if (
				current.onSourceFrameReader ||
				current.onSourceFrameAvailabilityChange ||
				current.sourceCrop
			) {
				const changed = sourceFrameBridge.current?.update({
					plan: current.plan,
					state,
					videos: videos.current,
					media: current.media,
					playing: current.playing,
					baseUrl: document.baseURI,
					seek: seekMedia,
				});
				if (changed) current.onSourceFrameAvailabilityChange?.();
			} else sourceFrameBridge.current?.clear();
			if (current.sourceCrop) {
				const controls = current.sourceCrop;
				const description = describeDirectCropFromPlan(
					current.plan,
					controls.clipId,
					current.frame,
				);
				const video = description && videos.current.get(description.clipId);
				const target = sourceCanvas.current;
				if (target)
					target.style.opacity = mediaReady && description && video ? "1" : "0";
				if (mediaReady && description && video && target) {
					const width = Math.max(1, Math.round(description.sourceWidth / 3));
					const height = Math.max(1, Math.round(description.sourceHeight / 3));
					if (target.width !== width) target.width = width;
					if (target.height !== height) target.height = height;
					target.getContext("2d")?.drawImage(video, 0, 0, width, height);
				}
				let checked = false;
				if (
					ready &&
					!current.playing &&
					!controls.disabled &&
					description?.editable &&
					video?.paused &&
					!video.seeking &&
					!video.error &&
					video.videoWidth === description.sourceWidth &&
					video.videoHeight === description.sourceHeight
				) {
					const held = heldCropFrame.current;
					checked = Boolean(
						controls.active &&
							held?.contextKey === controls.contextKey &&
							held.clipId === description.clipId &&
							held.mediaVersionId === description.mediaVersionId &&
							held.sourceFrame === description.sourceFrame &&
							held.sourceUrl === video.currentSrc &&
							Math.abs(
								video.currentTime -
									(state.layers.find(
										(layer) => layer.clipId === description.clipId,
									)?.sourceSeconds ?? Number.NaN),
							) <= 0.012,
					);
					if (!checked) {
						const snapshot = sourceFrameBridge.current?.read(
							description.clipId,
						);
						checked = Boolean(
							snapshot &&
								snapshot.mediaVersionId === description.mediaVersionId &&
								snapshot.sourceFrame === description.sourceFrame,
						);
						if (checked)
							heldCropFrame.current = {
								contextKey: controls.contextKey,
								clipId: description.clipId,
								mediaVersionId: description.mediaVersionId,
								sourceFrame: description.sourceFrame,
								sourceUrl: video.currentSrc,
							};
					}
				}
				if (!checked) heldCropFrame.current = null;
				setCropReady((previous) =>
					previous.contextKey === controls.contextKey &&
					previous.ready === checked
						? previous
						: { contextKey: controls.contextKey, ready: checked },
				);
			}
			setLoading(!ready);
			const ctx = canvas.current?.getContext("2d");
			if (ready && ctx && scratch.current && clipScratch.current)
				paintCompositionFrame(
					ctx,
					state,
					videos.current,
					images.current,
					scratch.current,
					clipScratch.current,
				);
			if (playing && ready) {
				const elapsed =
					previous === undefined || !previousReady
						? 0
						: Math.max(0, Math.min(now - previous, 100));
				fraction += (elapsed * 30) / 1000;
				const next = Math.floor(fraction);
				if (next > 0) {
					fraction -= next;
					if (current.frame + next >= current.plan.durationFrames) {
						setPlaying(false);
						current.onFrame(current.plan.durationFrames - 1);
					} else current.onFrame(current.frame + next);
				}
			} else fraction = 0;
			previousReady = playing && ready;
			previous = Math.max(previous ?? now, now);
			handle = requestAnimationFrame(tick);
		};
		handle = requestAnimationFrame(tick);
		return () => {
			active = false;
			cancelAnimationFrame(handle);
			for (const video of videos.current.values()) pauseMedia(video);
			for (const element of audio.current.values()) pauseMedia(element);
		};
	}, [playing, gainFor]);
	async function toggle() {
		if (playing) {
			setPlaying(false);
			return;
		}
		try {
			if (!sound.current)
				sound.current = { context: new AudioContext(), gains: new Map() };
			const { context } = sound.current;
			for (const element of audio.current.values()) gainFor(element);
			await context.resume();
			if (frame >= plan.durationFrames - 1) onFrame(0);
			setPlaying(true);
		} catch {
			setFailed(true);
		}
	}
	const urlFor = (id: string) =>
		media.find((source) => source.id === id)?.url ?? undefined;
	return (
		<section
			className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4"
			aria-label={c.preview}
		>
			<div
				className={
					sourceCrop
						? `grid min-w-0 items-start gap-4 ${plan.document.canvas.height > plan.document.canvas.width ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)]" : "sm:grid-cols-2"}`
						: ""
				}
			>
				{sourceCrop && (
					<SourceCropEditor
						canvasRef={sourceCanvas}
						sourceSize={
							sourceDescription
								? {
										width: sourceDescription.sourceWidth,
										height: sourceDescription.sourceHeight,
									}
								: null
						}
						rect={sourceDescription?.rect ?? null}
						ready={
							cropReady.contextKey === sourceCrop.contextKey &&
							cropReady.ready &&
							!loading &&
							!failed
						}
						playing={playing}
						disabled={sourceCrop.disabled || !sourceDescription?.editable}
						contextKey={sourceCrop.contextKey}
						onStart={() => {
							const snapshot = sourceFrameBridge.current?.read(
								sourceCrop.clipId,
							);
							if (
								playing ||
								loading ||
								failed ||
								!sourceDescription?.editable ||
								!snapshot ||
								snapshot.mediaVersionId !== sourceDescription.mediaVersionId ||
								snapshot.sourceFrame !== sourceDescription.sourceFrame
							)
								return false;
							return sourceCrop.onStart();
						}}
						onPreview={sourceCrop.onPreview}
						onCommit={sourceCrop.onCommit}
						onCancel={sourceCrop.onCancel}
					/>
				)}
				<div className="min-w-0 space-y-2">
					{sourceCrop && (
						<h3 className="text-sm text-zinc-300">
							{comparisonCopy.resultTitle}
						</h3>
					)}
					<figure
						aria-label={comparisonCopy.resultTitle}
						className="relative mx-auto w-full overflow-hidden rounded-lg bg-black"
						style={{
							aspectRatio: `${plan.document.canvas.width}/${plan.document.canvas.height}`,
							maxWidth: `${(440 * plan.document.canvas.width) / plan.document.canvas.height}px`,
						}}
					>
						<canvas
							ref={canvas}
							width={plan.document.canvas.width / 3}
							height={plan.document.canvas.height / 3}
							className="block h-full w-full"
							style={{
								aspectRatio: `${plan.document.canvas.width}/${plan.document.canvas.height}`,
							}}
							aria-label={c.preview}
						/>
						{loading && (
							<span
								role="status"
								className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 p-2 text-xs"
							>
								{c.loading}
							</span>
						)}
					</figure>
				</div>
			</div>
			<div className="flex items-center gap-3">
				<Button
					onClick={() => void toggle()}
					disabled={failed || sourceCrop?.active}
				>
					{playing ? c.pause : c.play}
				</Button>
				<output className="font-mono text-xs tabular-nums">
					{(frame / 30).toFixed(2)} / {(plan.durationFrames / 30).toFixed(2)}s
				</output>
				<input
					type="range"
					min={0}
					max={plan.durationFrames - 1}
					step={1}
					value={frame}
					aria-label={c.position}
					disabled={sourceCrop?.active}
					onChange={(event) => {
						setPlaying(false);
						onFrame(Number(event.target.value));
					}}
					className="min-w-0 flex-1 accent-emerald-500"
				/>
			</div>
			{(failed || fontFailed) && (
				<p role="alert" className="text-amber-300 text-sm">
					{failed ? c.previewError : c.fontError}
				</p>
			)}
			<div className="hidden" aria-hidden="true">
				{plan.clips.map((clip) => (
					<video
						key={clip.clip.id}
						ref={(node) => {
							if (node) videos.current.set(clip.clip.id, node);
							else videos.current.delete(clip.clip.id);
						}}
						muted
						playsInline
						preload="auto"
						src={urlFor(clip.mediaVersionId)}
						onSeeking={() => invalidateCropFrame(clip.clip.id)}
						onLoadStart={() => invalidateCropFrame(clip.clip.id)}
						onEmptied={() => invalidateCropFrame(clip.clip.id)}
						onPlay={() => invalidateCropFrame(clip.clip.id)}
						onError={() => {
							const current = latest.current;
							if (
								!evaluateCompositionFrame(
									current.plan,
									current.frame,
								).layers.some((layer) => layer.clipId === clip.clip.id)
							)
								return;
							invalidateCropFrame(clip.clip.id);
							setFailed(true);
							setPlaying(false);
						}}
					/>
				))}
				{plan.audio.map((item) => (
					<audio
						key={item.id}
						ref={(node) => {
							if (node) audio.current.set(item.id, node);
							else audio.current.delete(item.id);
						}}
						preload="auto"
						src={urlFor(item.mediaVersionId)}
					>
						<track kind="captions" src={captionTracks[item.id]} />
					</audio>
				))}
				{imageAssets.map((asset) => (
					<Image
						key={asset.id}
						ref={(node) => {
							if (node) images.current.set(asset.id, node);
							else images.current.delete(asset.id);
						}}
						src={asset.url}
						width={2048}
						height={2048}
						loading="eager"
						unoptimized
						alt=""
						onError={() => setFailed(true)}
					/>
				))}
			</div>
		</section>
	);
}
