import { always } from "@antithesishq/bombadil";
import {
	actions,
	extract,
	registerCustomAction,
} from "@antithesishq/bombadil/browser";

type Session = {
	id: string;
	archivePath: string;
	originMs: number;
	seeks: number[];
};
type Operation =
	| { kind: "seek"; seconds: number; previous: number }
	| { kind: "session"; id: string; previous: string; cursor: number | null };
type Model = {
	runId: string;
	sessions: Session[];
	lastOperation?: Operation;
};
type MoqWindow = Window & { __bitovpMoqArchiveModel?: Model };

const state = extract(({ document, window }) => {
	const model = (window as typeof window & MoqWindow).__bitovpMoqArchiveModel;
	if (!model) return null;
	const history = document.querySelector("[data-moq-history]");
	const selected = history?.querySelector<HTMLSelectElement>("select")?.value;
	const session = model.sessions.find(({ id }) => id === selected);
	const videos = history?.querySelectorAll<HTMLVideoElement>("video[controls]");
	const video = videos?.[0];
	const viewer = history?.querySelector("[data-moq-viewer-metrics]");
	const encoder = history?.querySelector("[data-moq-encoder-history]");
	const latency = viewer?.querySelector('[data-moq-chart="latencyMs"]');
	const mark = latency
		?.querySelector("[data-moq-playhead]")
		?.getAttribute("data-moq-playhead");
	const cursor = mark == null ? null : Number(mark);
	const source = video?.currentSrc || video?.src;
	const archiveUrl = source ? new URL(source, window.location.href) : null;
	const seconds = video?.currentTime ?? null;
	const violations: string[] = [];
	if (
		document.documentElement.scrollWidth >
		document.documentElement.clientWidth + 1
	)
		violations.push("document-overflow");
	if (
		history?.getAttribute("data-moq-history") !== model.runId ||
		!session ||
		videos?.length !== 1 ||
		video?.getAttribute("data-moq-archive") !== selected ||
		archiveUrl?.origin !== window.location.origin ||
		archiveUrl.pathname !== session.archivePath
	)
		violations.push("archive-scope");
	if (
		!latency ||
		!encoder?.querySelector('[data-moq-chart="inputBitrate"]') ||
		!encoder.querySelector('[data-moq-chart="inputFps"]') ||
		viewer?.contains(encoder) ||
		encoder.querySelector("[data-moq-playhead]")
	)
		violations.push("metric-scope");
	if (video?.error) violations.push("archive-media-error");

	const last = model.lastOperation;
	if (last?.kind === "seek") {
		if (
			seconds === null ||
			Math.abs(seconds - last.seconds) > 0.15 ||
			Math.abs(seconds - last.previous) < 0.2 ||
			video?.seeking ||
			cursor === null ||
			!Number.isFinite(cursor) ||
			!session ||
			Math.abs(cursor - (session.originMs + seconds * 1_000)) > 2
		)
			violations.push("seek-playhead");
	} else if (last?.kind === "session") {
		if (
			selected !== last.id ||
			seconds === null ||
			seconds > 0.1 ||
			video?.seeking ||
			(history?.getAttribute("data-moq-history") === model.runId &&
				last.cursor !== null &&
				cursor === last.cursor)
		)
			violations.push("stale-session");
	}
	return {
		selected,
		archive: video?.getAttribute("data-moq-archive"),
		archivePath: archiveUrl?.pathname,
		seconds,
		cursor,
		operation: last,
		offer: {
			seeks:
				session?.seeks.filter(
					(seek) => seconds !== null && Math.abs(seek - seconds) > 0.4,
				) ?? [],
			sessions: model.sessions
				.map(({ id }) => id)
				.filter((id) => id !== selected),
		},
		violations,
	};
});

export const moqArchiveMatchesSession = always(
	() =>
		state.current !== null &&
		state.current !== undefined &&
		state.current.violations.length === 0,
);

const operate = registerCustomAction(
	"operateMoqArchive",
	async (document, window, kind: string, target: string | number) => {
		const model = (window as typeof window & MoqWindow).__bitovpMoqArchiveModel;
		const history = document.querySelector("[data-moq-history]");
		const select = history?.querySelector<HTMLSelectElement>("select");
		const video = history?.querySelector<HTMLVideoElement>("video[controls]");
		if (!model || !select || !video)
			throw new Error("Missing prepared MoQ archive controls");
		const selected = model.sessions.find(({ id }) => id === select.value);
		if (!selected) throw new Error("Archive initially has no selected session");
		const delay = (ms: number) =>
			new Promise<void>((done) => window.setTimeout(done, ms));
		let settled: () => boolean;
		if (
			kind === "seek" &&
			typeof target === "number" &&
			selected.seeks.includes(target)
		) {
			model.lastOperation = {
				kind,
				seconds: target,
				previous: video.currentTime,
			};
			video.currentTime = target;
			settled = () => !video.seeking && video.readyState >= 2;
		} else if (
			kind === "session" &&
			typeof target === "string" &&
			model.sessions.some(({ id }) => id === target)
		) {
			const marker = history
				?.querySelector('[data-moq-chart="latencyMs"] [data-moq-playhead]')
				?.getAttribute("data-moq-playhead");
			model.lastOperation = {
				kind,
				id: target,
				previous: select.value,
				cursor: marker == null ? null : Number(marker),
			};
			select.value = target;
			select.dispatchEvent(new window.Event("change", { bubbles: true }));
			settled = () =>
				history
					?.querySelector("video[controls]")
					?.getAttribute("data-moq-archive") === target;
		} else {
			throw new Error("Invalid MoQ archive operation");
		}
		for (let attempt = 0; attempt < 40 && !settled(); attempt++)
			await delay(20);
		// The playback clock samples the browser's own currentTime every 100 ms.
		await delay(140);
	},
);

export const moqArchiveActions = actions(() => {
	const current = state.current;
	if (!current || current.violations.length) return [];
	const seek = current.offer.seeks.map((seconds) => operate("seek", seconds));
	const change = current.offer.sessions.map((id) => operate("session", id));
	if (!current.operation || current.operation.kind === "session") return seek;
	return [...change, ...seek];
});
