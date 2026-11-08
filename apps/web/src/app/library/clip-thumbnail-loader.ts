import { apiFetch } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import type {
	EditingThumbnailFrameView,
	EditingThumbnailReference,
} from "@/lib/library-editing";
import { EXPECTED_ORGANIZATION_QUERY } from "@/lib/passive-request";
import { paintCompositionFrame } from "./edits/[id]/composition-preview";
import { withThumbnailDecoder } from "./thumbnail-decoder-slots";

type Loader = (
	reference: EditingThumbnailReference,
	locale: Locale,
	signal: AbortSignal,
) => Promise<string | null>;

/** Captures own at most one video each; slots are released only after its cleanup. */
export function createClipThumbnailQueue(load: Loader) {
	const cache = new Map<string, string>();
	const waiting: (() => void)[] = [];
	let active = 0;
	const pump = () => {
		while (active < 2 && waiting.length) waiting.shift()?.();
	};
	return (
		reference: EditingThumbnailReference,
		locale: Locale,
		signal: AbortSignal,
	): Promise<string | null> => {
		if (signal.aborted) return Promise.resolve(null);
		const key = JSON.stringify([
			reference.url,
			reference.cacheKey,
			reference.draftRevision,
			locale,
		]);
		const cached = cache.get(key);
		if (cached) return Promise.resolve(cached);
		return new Promise((resolve) => {
			const cancel = () => {
				const index = waiting.indexOf(run);
				if (index >= 0) {
					waiting.splice(index, 1);
					resolve(null);
				}
				signal.removeEventListener("abort", cancel);
			};
			const run = () => {
				signal.removeEventListener("abort", cancel);
				if (signal.aborted) {
					resolve(null);
					return;
				}
				active++;
				void load(reference, locale, signal)
					.catch(() => null)
					.then((frame) => {
						if (frame && !signal.aborted) {
							cache.set(key, frame);
							if (cache.size > 64)
								cache.delete(cache.keys().next().value ?? "");
						}
						resolve(signal.aborted ? null : frame);
					})
					.finally(() => {
						active--;
						pump();
					});
			};
			waiting.push(run);
			signal.addEventListener("abort", cancel, { once: true });
			pump();
		});
	};
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Thumbnail capture canceled"));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		void promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

function boundAssetUrl(value: string, path: string, organizationId: string) {
	const url = new URL(value, window.location.origin);
	return (
		value.startsWith("/") &&
		!value.startsWith("//") &&
		url.origin === window.location.origin &&
		url.pathname === path &&
		!url.hash &&
		url.searchParams.get(EXPECTED_ORGANIZATION_QUERY) === organizationId &&
		[...url.searchParams.keys()].every(
			(key) => key === EXPECTED_ORGANIZATION_QUERY,
		) &&
		url.searchParams.getAll(EXPECTED_ORGANIZATION_QUERY).length === 1
	);
}

export const captureClipThumbnail: Loader = (reference, locale, signal) =>
	withThumbnailDecoder(signal, async () => {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		const timeout = setTimeout(cancel, 15_000);
		let video: HTMLVideoElement | undefined;
		let ownedFont: FontFace | undefined;
		const images: HTMLImageElement[] = [];
		const removeListeners: (() => void)[] = [];
		try {
			const organizationId = new URL(
				reference.url,
				window.location.origin,
			).searchParams.get(EXPECTED_ORGANIZATION_QUERY);
			if (!organizationId) return null;
			const data = await abortable(
				apiFetch<EditingThumbnailFrameView>(reference.url, {
					signal: controller.signal,
				}),
				controller.signal,
			);
			controller.signal.throwIfAborted();
			const { frame, video: source } = data;
			const layer = frame?.layers[0];
			if (
				data.cacheKey !== reference.cacheKey ||
				data.draftRevision !== reference.draftRevision ||
				!frame ||
				frame.layers.length !== 1 ||
				!source ||
				!layer ||
				source.clipId !== layer.clipId ||
				source.mediaVersionId !== layer.mediaVersionId ||
				!Number.isFinite(layer.sourceSeconds) ||
				layer.sourceSeconds < 0 ||
				![frame.canvas.width, frame.canvas.height].every(
					(value) => Number.isInteger(value) && value >= 2 && value <= 192,
				) ||
				!boundAssetUrl(
					source.url,
					`/api/library/media-versions/${source.mediaVersionId}/media`,
					organizationId,
				) ||
				!Array.isArray(data.images) ||
				data.images.length > 16 ||
				data.images.some(
					(image) =>
						!boundAssetUrl(
							image.url,
							`/api/library/image-assets/${image.id}/media`,
							organizationId,
						),
				)
			)
				return null;
			video = document.createElement("video");
			const element = video;
			element.crossOrigin = "anonymous";
			element.muted = true;
			element.playsInline = true;
			element.preload = "metadata";
			element.style.cssText =
				"position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none";
			element.setAttribute("aria-hidden", "true");
			await abortable(
				new Promise<void>((resolve, reject) => {
					const ready = () => {
						if (
							!element.seeking &&
							element.readyState >= 2 &&
							Math.abs(element.currentTime - layer.sourceSeconds) <= 1 / 30
						)
							resolve();
					};
					const seek = () => {
						element.currentTime = layer.sourceSeconds;
						ready();
					};
					const fail = () => reject(new Error("Thumbnail media unavailable"));
					for (const [event, listener] of [
						["loadedmetadata", seek],
						["loadeddata", ready],
						["seeked", ready],
						["error", fail],
						["encrypted", fail],
					] as const) {
						element.addEventListener(event, listener);
						removeListeners.push(() =>
							element.removeEventListener(event, listener),
						);
					}
					document.body.appendChild(element);
					element.src = source.url;
				}),
				controller.signal,
			);
			const imageMap = new Map<string, HTMLImageElement>();
			for (const asset of data.images) {
				const image = document.createElement("img");
				images.push(image);
				image.crossOrigin = "anonymous";
				await abortable(
					new Promise<void>((resolve, reject) => {
						image.onload = () => resolve();
						image.onerror = () =>
							reject(new Error("Thumbnail image unavailable"));
						image.src = asset.url;
					}),
					controller.signal,
				);
				imageMap.set(asset.id, image);
			}
			if (
				typeof FontFace !== "undefined" &&
				(frame.captions.length ||
					frame.overlays.some((overlay) => overlay.kind === "TEXT"))
			) {
				const response = await abortable(
					fetch("/api/library/editing-font", { signal: controller.signal }),
					controller.signal,
				);
				if (!response.ok) return null;
				const bytes = await abortable(
					response.arrayBuffer(),
					controller.signal,
				);
				ownedFont = new FontFace("BitOVPEditing", bytes);
				await abortable(ownedFont.load(), controller.signal);
				controller.signal.throwIfAborted();
				document.fonts.add(ownedFont);
			}
			controller.signal.throwIfAborted();
			const canvas = document.createElement("canvas");
			canvas.width = frame.canvas.width;
			canvas.height = frame.canvas.height;
			canvas.lang = locale;
			const context = canvas.getContext("2d");
			if (!context) return null;
			paintCompositionFrame(
				context,
				frame,
				new Map([[source.clipId, element]]),
				imageMap,
				document.createElement("canvas"),
				document.createElement("canvas"),
			);
			return canvas.toDataURL("image/jpeg", 0.7);
		} catch {
			return null;
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", cancel);
			controller.abort();
			for (const remove of removeListeners) remove();
			if (video) {
				video.pause();
				video.removeAttribute("src");
				video.load();
				video.remove();
			}
			for (const image of images) {
				image.onload = null;
				image.onerror = null;
				image.removeAttribute("src");
			}
			if (ownedFont) document.fonts.delete(ownedFont);
		}
	});

export const requestClipThumbnail =
	createClipThumbnailQueue(captureClipThumbnail);
