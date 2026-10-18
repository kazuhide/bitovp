import type { ManifestPlaybackLink } from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const loaded: string[] = [];
/** Captured so the first-segment grace can be driven, not assumed. */
let fatal: (() => void) | null = null;
vi.mock("hls.js", () => {
	class Hls {
		static Events = { ERROR: "hlsError" };
		static isSupported() {
			return true;
		}
		on(event: string, cb: (e: unknown, data: unknown) => void) {
			if (event === "hlsError") {
				fatal = () =>
					cb("hlsError", {
						fatal: true,
						type: "networkError",
						details: "manifestLoadError",
						response: { code: 404 },
					});
			}
		}
		loadSource(url: string) {
			loaded.push(url);
		}
		attachMedia() {}
		startLoad() {}
		stopLoad() {}
		destroy() {}
	}
	return { default: Hls };
});

const shakaSources: string[] = [];
vi.mock("shaka-player", () => ({
	default: {
		polyfill: { installAll() {} },
		Player: class {
			static isBrowserSupported() {
				return true;
			}
			async attach() {}
			configure() {}
			addEventListener() {}
			removeEventListener() {}
			async load(url: string) {
				shakaSources.push(url);
			}
			async destroy() {}
		},
	},
}));

import { PlayerPreview, playableLinks } from "./player-preview";

const JOB = "00000000-0000-4000-8000-0000000000aa";

function link(over: Partial<ManifestPlaybackLink> = {}): ManifestPlaybackLink {
	return {
		key: "hls",
		kind: "HLS",
		label: "HLS manifest",
		url: "https://out.s3.eu-west-1.amazonaws.com/o/stream.m3u8",
		path: "o/stream.m3u8",
		via: "derived",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	loaded.length = 0;
	shakaSources.length = 0;
});

describe("playableLinks", () => {
	const cases: {
		name: string;
		links: ManifestPlaybackLink[];
		status: string;
		live?: boolean;
		expected: string[];
	}[] = [
		{
			name: "a finished job with a derived URL",
			links: [link()],
			status: "FINISHED",
			expected: ["hls"],
		},
		{
			// rev433 (owner 2026-09-07): a VOD job's just-in-time manifest is not
			// there yet either when the page opens right after creation — the
			// rail tried it and answered "networkError"
			name: "a running VOD job — nothing to play until it has finished, just-in-time or not",
			links: [link()],
			status: "RUNNING",
			expected: [],
		},
		{
			name: "a running LIVE channel — its manifests exist exactly while it runs",
			links: [link()],
			status: "RUNNING",
			live: true,
			expected: ["hls"],
		},
		{
			name: "a stopped LIVE channel — nothing writes segments any more",
			links: [link()],
			status: "",
			live: true,
			expected: [],
		},
		{
			name: "queued, failed and canceled jobs have no manifests to play",
			links: [link()],
			status: "QUEUED",
			expected: [],
		},
		{
			name: "a URL with a reason is copyable, not playable",
			links: [link({ reason: { code: "INSECURE_ENDPOINT" } })],
			status: "FINISHED",
			expected: [],
		},
		{
			name: "a refusal carries no URL to play",
			links: [link({ url: null, via: "none", reason: { code: "NOT_PUBLIC" } })],
			status: "FINISHED",
			expected: [],
		},
		{
			name: "SMOOTH has no in-browser player",
			links: [link({ key: "smooth", kind: "SMOOTH" })],
			status: "FINISHED",
			expected: [],
		},
		{
			name: "keeps the playable ones out of a mixed list, in order",
			links: [
				link({ key: "smooth", kind: "SMOOTH" }),
				link({ key: "dash", kind: "DASH" }),
				link({ key: "private", url: null, reason: { code: "NOT_PUBLIC" } }),
				link({ key: "hls" }),
			],
			status: "FINISHED",
			expected: ["dash", "hls"],
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(
				playableLinks({
					links: testCase.links,
					status: testCase.status,
					live: testCase.live,
				}).map((l) => l.key),
			).toEqual(testCase.expected);
		});
	}
});

describe("PlayerPreview", () => {
	it("renders nothing when nothing is playable", () => {
		const { container } = renderL(<PlayerPreview jobId={JOB} links={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("loads the stream with no click at all", async () => {
		// The whole point: "is this output playable" is answered on arrival, not
		// hidden behind a button.
		renderL(<PlayerPreview jobId={JOB} links={[link()]} />);
		expect(await screen.findByText("Playback preview")).toBeInTheDocument();
		// Single manifest: no switcher, so the label appears exactly once.
		expect(screen.getAllByText("HLS · HLS manifest")).toHaveLength(1);
		await waitFor(() => expect(loaded).toEqual([link().url]));
	});

	it("offers no switcher for a single manifest", () => {
		renderL(<PlayerPreview jobId={JOB} links={[link()]} />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("switches between manifests, remounting the player on each", async () => {
		const user = userEvent.setup();
		const dash = link({
			key: "dash",
			kind: "DASH",
			label: "DASH manifest",
			url: "https://out.s3.eu-west-1.amazonaws.com/o/stream.mpd",
		});
		renderL(<PlayerPreview jobId={JOB} links={[link(), dash]} />);
		await waitFor(() => expect(loaded).toEqual([link().url]));

		const [first, second] = screen.getAllByRole("button");
		expect(first).toHaveAttribute("aria-pressed", "true");
		expect(second).toHaveAttribute("aria-pressed", "false");

		if (!second) {
			throw new Error("expected a second manifest button");
		}
		await user.click(second);
		expect(second).toHaveAttribute("aria-pressed", "true");
		// DASH goes through Shaka Player — hls.js must not be handed the .mpd, and the
		// player is remounted rather than re-sourced under a live instance.
		await waitFor(() => expect(shakaSources).toEqual([dash.url]));
		expect(loaded).toEqual([link().url]);
		// The panel names the manifest, not its URL — the list below owns that.
		// Twice: once on its switcher button, once as the now-playing label.
		expect(screen.getAllByText("DASH · DASH manifest")).toHaveLength(2);
	});

	it("labels a preview taken while the encoding is still running", () => {
		renderL(<PlayerPreview jobId={JOB} links={[link()]} live />);
		expect(screen.getByText(/Encoding still running/)).toBeInTheDocument();
	});

	it("renders in Japanese", () => {
		renderL(<PlayerPreview jobId={JOB} links={[link()]} live />, "ja");
		expect(screen.getByText("再生プレビュー")).toBeInTheDocument();
		expect(screen.getByText(/エンコード実行中/)).toBeInTheDocument();
	});
});

/**
 * The grace period is WIRED for live and not for VOD.
 *
 * Review found this deletable: removing `waitForFirstSegment: true` at
 * `player-preview.tsx:125` left 78 tests passing, because the only test that touched
 * the prop passed it straight to `PlaybackSurface`. So the boundary was pinned while
 * the wiring that reaches it was not.
 *
 * Asserted behaviourally rather than by inspecting the prop: one fatal
 * `networkError` must be ABSORBED on a live channel — a live manifest 404s until the
 * first segment lands — and must be REPORTED on a VOD job, where a 404 is simply a
 * failure. That distinction is the whole reason the prop exists.
 */
describe("PlayerPreview — the first-segment grace is wired per scope", () => {
	it("allows an initial manifest 404 a bounded grace for a live channel", async () => {
		renderL(<PlayerPreview scope="live" jobId={JOB} links={[link()]} />);
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();
		/**
		 * The POSITIVE state the grace produces, not the absence of the failure.
		 *
		 * This was `await waitFor( => expect(queryByText(/playback failed/i)).toBeNull)`,
		 * which passes on the first tick — a negative assertion inside `waitFor` does not
		 * wait for anything. It caught the deletion mutation only because the failure path
		 * happens to render synchronously after `fatal?.`; the day that path becomes
		 * async (a CORS diagnosis gating the message, say) the assertion would pass before
		 * the failure appeared and the mutation would stop biting, silently (review
		 * suggestion). Asserting the waiting copy — the same string
		 * `playback-surface.test.tsx` uses — is robust to that ordering, and it is the
		 * thing an operator actually sees.
		 */
		expect(
			await screen.findByText(/Waiting for the channel's first segment/),
		).toBeInTheDocument();
		expect(screen.queryByText(/playback failed/i)).toBeNull();
	});

	it("reports the same error immediately for a VOD job", async () => {
		// A VOD failure also triggers the CORS diagnosis, so the fetch has to resolve
		// or the error path throws on `undefined.then` instead of rendering.
		const { apiFetch } = await import("@/lib/api");
		vi.mocked(apiFetch).mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "NOT_FOUND",
		} as never);
		renderL(<PlayerPreview scope="vod" jobId={JOB} links={[link()]} />);
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();
		expect(await screen.findByText(/playback failed/i)).toBeInTheDocument();
	});
});

describe("PlayerPreview — output not yet confirmed (row #326)", () => {
	it("mounts no player while autoPlay is withheld, and lets the operator start it anyway", async () => {
		renderL(
			<PlayerPreview
				jobId={JOB}
				scope="live"
				live
				links={[link()]}
				autoPlay={false}
			/>,
		);
		expect(
			await screen.findByText(/Playback waits until video output is confirmed/),
		).toBeInTheDocument();
		expect(loaded).toEqual([]);
		await userEvent.click(screen.getByRole("button", { name: "Play now" }));
		await waitFor(() => expect(loaded).toEqual([link().url]));
	});
});

describe("PlayerPreview — the gate is a one-way latch (row #326, review-539 R1/O1)", () => {
	it("starts on its own once autoPlay turns true, and a later 'unknown' does not unmount it", async () => {
		const view = renderL(
			<PlayerPreview
				jobId={JOB}
				scope="live"
				live
				links={[link()]}
				autoPlay={false}
			/>,
		);
		expect(
			await screen.findByText(/Playback waits until video output is confirmed/),
		).toBeInTheDocument();
		expect(loaded).toEqual([]);
		view.rerender(
			<PlayerPreview jobId={JOB} scope="live" live links={[link()]} autoPlay />,
		);
		await waitFor(() => expect(loaded).toEqual([link().url]));
		view.rerender(
			<PlayerPreview
				jobId={JOB}
				scope="live"
				live
				links={[link()]}
				autoPlay={false}
			/>,
		);
		expect(
			screen.queryByText(/Playback waits until video output is confirmed/),
		).not.toBeInTheDocument();
		// Still ONE load: the surface was never remounted.
		expect(loaded).toEqual([link().url]);
	});
});
