import { z } from "zod";
import type { MoqVideoStatistics } from "./video-statistics";

const COLLECTOR_URL =
	"https://cdn.bitmovin.com/analytics/web/2.62.0/bitmovin-analytics.js";
const COLLECTOR_INTEGRITY =
	"sha384-rNAsoK6wARspgAMceeWNj855XDZp422RW2Vj5N/JCN8p46/JmXM5Rx8LCWLhpmi3";
const configuration = z.object({
	licenseKey: z.string().trim().min(1).max(200),
	videoId: z.string(),
	runId: z.uuid(),
	encodingId: z.uuid(),
});

type CollectorAdapter = {
	getCurrentImpressionId(): string | undefined;
	setCustomDataOnce(values: Record<string, string>): void;
};
type CollectorConstructor = new (
	config: Record<string, unknown>,
	video: HTMLVideoElement,
) => CollectorAdapter;
type CollectorWindow = Window & {
	bitmovin?: { analytics?: { HTMLVideoElementAdapter?: CollectorConstructor } };
};

export type MoqAnalyticsConfiguration = z.infer<typeof configuration>;
export type MoqAnalyticsBridge = {
	attach(video: HTMLVideoElement): void;
	sample(value: Pick<MoqVideoStatistics, "latencySeconds">, at?: Date): void;
	getImpressionId(): string | null;
	dispose(): Promise<void>;
};

/**
 * Public HTML5 collector + customData API. This records the existing barcode
 * measurement; it does not populate native Analytics LATENCY or measure again.
 * A separate same-origin browsing context owns the collector's unload lifetime.
 */
export async function createMoqAnalyticsBridge(
	input: MoqAnalyticsConfiguration,
): Promise<MoqAnalyticsBridge> {
	const parsed = configuration.safeParse(input);
	if (
		!parsed.success ||
		parsed.data.videoId !==
			`bitovp-moq:${parsed.data.encodingId}:${parsed.data.runId}`
	)
		throw new Error("MoQ Analytics unavailable");
	const config = parsed.data;
	const frame = document.createElement("iframe");
	frame.hidden = true;
	frame.title = "MoQ Analytics collector";
	frame.tabIndex = -1;
	frame.setAttribute("aria-hidden", "true");
	frame.dataset.bitovpMoqAnalytics = "true";
	document.body.append(frame);
	const realm = frame.contentWindow as CollectorWindow | null;
	const frameDocument = frame.contentDocument;
	if (!realm || !frameDocument) {
		frame.remove();
		throw new Error("MoQ Analytics unavailable");
	}
	const script = frameDocument.createElement("script");
	script.src = COLLECTOR_URL;
	script.integrity = COLLECTOR_INTEGRITY;
	script.crossOrigin = "anonymous";
	script.referrerPolicy = "no-referrer";
	script.async = true;
	let Adapter: CollectorConstructor;
	try {
		Adapter = await new Promise<CollectorConstructor>((resolve, reject) => {
			const timeout = window.setTimeout(() => finish(), 15_000);
			function finish(value?: CollectorConstructor) {
				window.clearTimeout(timeout);
				script.onload = null;
				script.onerror = null;
				if (value) resolve(value);
				else reject(new Error("MoQ Analytics unavailable"));
			}
			script.onload = () => {
				const value = realm.bitmovin?.analytics?.HTMLVideoElementAdapter;
				finish(typeof value === "function" ? value : undefined);
			};
			script.onerror = () => finish();
			frameDocument.head.append(script);
		});
	} catch {
		frame.remove();
		throw new Error("MoQ Analytics unavailable");
	}
	let adapter: CollectorAdapter | undefined;
	let closed = false;
	let disposal: Promise<void> | undefined;
	return {
		attach(video) {
			if (closed || adapter) return;
			// MoQ renders into a local media resource. Never give bearer URLs to
			// the collector, which derives stream URLs from the video element.
			if (
				[video.currentSrc, video.src].some(
					(url) => url && !url.startsWith("blob:"),
				)
			)
				return;
			try {
				adapter = new Adapter(
					{
						key: config.licenseKey,
						videoId: config.videoId,
						title: "MoQ Live preview",
						isLive: true,
						customData2: "moq-source-barcode",
						customData4: config.runId,
						customData5: config.encodingId,
						config: { cookiesEnabled: false, origin: window.location.hostname },
					},
					video,
				);
			} catch {
				/* Optional analytics never stops playback. */
			}
		},
		sample(value, at = new Date()) {
			const seconds = value.latencySeconds;
			if (
				closed ||
				!adapter ||
				typeof seconds !== "number" ||
				!Number.isFinite(seconds) ||
				seconds < 0 ||
				seconds > 600 ||
				!Number.isSafeInteger(Math.round(seconds * 1000)) ||
				!Number.isFinite(at.getTime())
			)
				return;
			try {
				adapter.setCustomDataOnce({
					customData1: String(Math.round(seconds * 1000)),
					customData2: "moq-source-barcode",
					customData3: at.toISOString(),
					customData4: config.runId,
					customData5: config.encodingId,
				});
			} catch {
				/* The saved player observation remains available separately. */
			}
		},
		getImpressionId() {
			if (closed || !adapter) return null;
			try {
				const id = z.uuid().safeParse(adapter.getCurrentImpressionId());
				return id.success ? id.data : null;
			} catch {
				return null;
			}
		},
		dispose() {
			if (disposal) return disposal;
			closed = true;
			adapter = undefined;
			// A real same-origin frame navigation runs the collector's unload
			// path. Do not call internal adapter release methods or fake events.
			disposal = new Promise<void>((resolve) => {
				const timeout = window.setTimeout(finish, 1000);
				function finish() {
					window.clearTimeout(timeout);
					frame.removeEventListener("load", finish);
					frame.remove();
					resolve();
				}
				frame.addEventListener("load", finish, { once: true });
				frame.src = "about:blank";
			});
			return disposal;
		},
	};
}
