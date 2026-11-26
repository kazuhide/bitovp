import { afterEach, describe, expect, it, vi } from "vitest";
import { createMoqAnalyticsBridge } from "./analytics";

const runId = "b0fb2928-b14d-46b3-ae6d-1b16f4718c94";
const encodingId = "56233f56-aa9f-41d3-b162-51ccdd9006fb";
const impressionId = "e95fbd1b-d81b-4691-9de5-a113f2442970";
const config = {
	licenseKey: "own-test-license",
	runId,
	encodingId,
	videoId: `bitovp-moq:${encodingId}:${runId}`,
};

async function load() {
	const calls: { config: unknown; video: HTMLVideoElement }[] = [];
	const send = vi.fn();
	const pending = createMoqAnalyticsBridge(config);
	const frame = document.querySelector<HTMLIFrameElement>(
		"iframe[data-bitovp-moq-analytics]",
	);
	if (!frame?.contentWindow || !frame.contentDocument)
		throw new Error("missing collector frame");
	class Adapter {
		constructor(value: unknown, video: HTMLVideoElement) {
			calls.push({ config: value, video });
		}
		getCurrentImpressionId() {
			return impressionId;
		}
		setCustomDataOnce = send;
	}
	Object.assign(frame.contentWindow, {
		bitmovin: { analytics: { HTMLVideoElementAdapter: Adapter } },
	});
	const script = frame.contentDocument.querySelector("script");
	if (!script) throw new Error("missing fixed asset");
	script.dispatchEvent(new Event("load"));
	return { bridge: await pending, calls, send, frame, script };
}

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
});

describe("MoQ Analytics public custom-data bridge", () => {
	it("loads the pinned public collector in its own same-origin frame and attaches only the real video", async () => {
		const { bridge, calls, frame, script } = await load();
		expect(frame.hidden).toBe(true);
		expect(script.src).toBe(
			"https://cdn.bitmovin.com/analytics/web/2.62.0/bitmovin-analytics.js",
		);
		expect(script.integrity).toBe(
			"sha384-rNAsoK6wARspgAMceeWNj855XDZp422RW2Vj5N/JCN8p46/JmXM5Rx8LCWLhpmi3",
		);
		expect(script.crossOrigin).toBe("anonymous");
		expect(bridge.getImpressionId()).toBeNull();
		const video = document.createElement("video");
		bridge.attach(video);
		bridge.attach(video);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.video).toBe(video);
		expect(calls[0]?.config).toMatchObject({
			key: config.licenseKey,
			videoId: config.videoId,
			isLive: true,
			config: { cookiesEnabled: false, origin: window.location.hostname },
		});
		expect(bridge.getImpressionId()).toBe(impressionId);
	});

	it("sends only finite nonnegative barcode latency as milliseconds with fixed provenance, never target-buffer or native latency fields", async () => {
		const { bridge, send } = await load();
		const at = new Date("2026-11-18T01:00:00.000Z");
		bridge.sample({ latencySeconds: 1.234 });
		expect(send).not.toHaveBeenCalled();
		bridge.attach(document.createElement("video"));
		for (const latencySeconds of [
			null,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			601,
			-1,
		])
			bridge.sample({ latencySeconds }, at);
		expect(send).not.toHaveBeenCalled();
		bridge.sample({ latencySeconds: 1.234 }, at);
		expect(send).toHaveBeenCalledExactlyOnceWith({
			customData1: "1234",
			customData2: "moq-source-barcode",
			customData3: at.toISOString(),
			customData4: runId,
			customData5: encodingId,
		});
		bridge.sample({ latencySeconds: 0 }, new Date(at.getTime() + 1000));
		expect(send.mock.calls[1]?.[0].customData1).toBe("0");
	});

	it("rejects mismatched run metadata and never gives source URLs to the collector", async () => {
		await expect(
			createMoqAnalyticsBridge({ ...config, videoId: "other-run" }),
		).rejects.toThrow("MoQ Analytics unavailable");
		const { bridge, calls } = await load();
		const video = document.createElement("video");
		Object.defineProperty(video, "currentSrc", {
			value: "https://relay.invalid/subscribe-secret",
		});
		bridge.attach(video);
		expect(calls).toHaveLength(0);
		expect(bridge.getImpressionId()).toBeNull();
	});

	it("navigates and removes only its owned frame at disposal and sends nothing afterwards", async () => {
		const { bridge, send, frame } = await load();
		const unrelated = document.createElement("iframe");
		document.body.append(unrelated);
		bridge.attach(document.createElement("video"));
		const disposal = bridge.dispose();
		frame.dispatchEvent(new Event("load"));
		await disposal;
		bridge.sample({ latencySeconds: 1 });
		expect(send).not.toHaveBeenCalled();
		expect(frame.isConnected).toBe(false);
		expect(unrelated.isConnected).toBe(true);
		expect(bridge.getImpressionId()).toBeNull();
		await bridge.dispose();
	});

	it("cleans up the pending collector immediately when playback ends", async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const pending = createMoqAnalyticsBridge(config, abort.signal);
		const outcome = pending.catch((error: unknown) => error);
		const frame = document.querySelector("iframe[data-bitovp-moq-analytics]");
		expect(frame).toBeInTheDocument();
		abort.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(frame).not.toBeInTheDocument();
		expect(await outcome).toEqual(new Error("MoQ Analytics unavailable"));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("fails closed on a collector load failure with a fixed error and no frame leak", async () => {
		const pending = createMoqAnalyticsBridge(config);
		const frame = document.querySelector<HTMLIFrameElement>(
			"iframe[data-bitovp-moq-analytics]",
		);
		frame?.contentDocument
			?.querySelector("script")
			?.dispatchEvent(new Event("error"));
		await expect(pending).rejects.toThrow("MoQ Analytics unavailable");
		expect(frame?.isConnected).toBe(false);
	});
});
