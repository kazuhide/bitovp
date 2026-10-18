import type {
	PerTitleResultStream,
	PerTitleResultsSnapshot,
} from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as renderL } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

import { PerTitleResultsPanel } from "./per-title-results-panel";

/**
 * The panel's four states, and the difference between them, is the whole point:
 * "no rows" means four different things here and only one of them is "the encoder
 * produced nothing". Rendering any of the other three as an empty table would tell
 * an operator a falsehood about their own encode.
 */

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";

const result = (
	streamId: string,
	over: Partial<PerTitleResultStream> = {},
): PerTitleResultStream => ({
	streamId,
	mode: "PER_TITLE_RESULT",
	params: { bitrate: 4_200_000, profile: "HIGH" },
	appliedSettings: { width: 1920, height: 1080 },
	muxings: [
		{
			muxingId: "m-1",
			muxingType: "FMP4",
			avgBitrate: 4_200_000,
			maxBitrate: 4_500_000,
			segmentsMuxed: 120,
			outputs: [
				{ outputId: "out-1", outputPath: "video/1080p_4200000_a1b2c3/" },
			],
			drm: [],
		},
	],
	...over,
});

const snapshot = (
	streams: PerTitleResultStream[],
	scan: Partial<PerTitleResultsSnapshot["scan"]> = {},
): PerTitleResultsSnapshot => ({
	capturedAt: "2026-08-11T00:00:00.000Z",
	streams,
	scan: {
		streamsListed: streams.length + 1,
		templatesListed: 1,
		templatesDeclared: 1,
		resultsCaptured: streams.length,
		muxingsListed: streams.length,
		complete: true,
		codecConfigErrors: 0,
		unattributed: streams.filter((s) => !s.templateRendition).length,
		...scan,
	},
});

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("per-title results panel — states", () => {
	it("says the results were never captured, and offers to fetch them", () => {
		renderL(
			<PerTitleResultsPanel
				view={{ origin: "absent" }}
				templateOrder={["v1080"]}
				canCapture={true}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/not captured/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: /capture now/i })).toBeTruthy();
	});

	it("offers no capture button while the job is still running", () => {
		// The results do not exist until the encoding finishes, and the route
		// refuses with a 409 — offering the button would be offering a failure.
		renderL(
			<PerTitleResultsPanel
				view={{ origin: "absent" }}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.queryByRole("button", { name: /capture now/i })).toBeNull();
	});

	it("shows a FAILED capture as a failure, never as an empty table", () => {
		renderL(
			<PerTitleResultsPanel
				view={{ origin: "failed", error: "502 Bad Gateway" }}
				templateOrder={["v1080"]}
				canCapture={true}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/502 Bad Gateway/)).toBeTruthy();
		// And no table at all, so nothing can be read as "the ladder was empty".
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.getByRole("button", { name: /capture now/i })).toBeTruthy();
	});

	it("distinguishes a successful capture of an EMPTY ladder", () => {
		// The one case where "no rows" really does mean the algorithm produced
		// nothing — and it says exactly that.
		renderL(
			<PerTitleResultsPanel
				view={{ origin: "step", snapshot: snapshot([]) }}
				templateOrder={["v1080"]}
				canCapture={true}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/produced nothing/i)).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("says where the snapshot came from", () => {
		const { unmount } = renderL(
			<PerTitleResultsPanel
				view={{ origin: "step", snapshot: snapshot([result("s-1")]) }}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/end of the run/i)).toBeTruthy();
		unmount();
		renderL(
			<PerTitleResultsPanel
				view={{ origin: "snapshot", snapshot: snapshot([result("s-1")]) }}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/backfilled/i)).toBeTruthy();
	});
});

describe("per-title results panel — the numbers", () => {
	it("shows what each rung actually cost", () => {
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { templateRendition: "v1080" })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		// Observed values — the point of capturing at all.
		expect(screen.getByText("1920×1080")).toBeTruthy();
		expect(screen.getByText("4.2 Mbps")).toBeTruthy();
		expect(screen.getByText("4.5 Mbps")).toBeTruthy();
		expect(screen.getByText("120")).toBeTruthy();
		expect(screen.getByText("FMP4")).toBeTruthy();
	});

	it("opens the encoder-chosen settings on click — the count is a door, not the payload", async () => {
		// "34 observed" told an operator nothing (owner directive, 2026-08-12):
		// the settings the per-title algorithm actually chose are the point.
		// The summary is a real button; the values appear on CLICK (touch-safe,
		// selectable), not hover.
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { templateRendition: "v1080" })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		// Closed: the summary shows, the values do not.
		expect(screen.queryByText("4200000")).toBeNull();
		// By the VISIBLE summary — that IS the accessible name now (review of
		// PR #169, C1: an aria-label on the trigger MASKED the visible text, so
		// a screen reader lost the number and voice control could not target
		// it; the label names the opened panel instead).
		await userEvent.click(screen.getByRole("button", { name: /2 settings/ }));
		// Open: every observed key→value from the fixture is readable.
		expect(await screen.findByText("bitrate")).toBeTruthy();
		expect(screen.getByText("4200000")).toBeTruthy();
		expect(screen.getByText("profile")).toBeTruthy();
		expect(screen.getByText("HIGH")).toBeTruthy();
	});

	it("reports EVERY muxing leg, not just the first", () => {
		// 33 per-title renditions in the corpus carry two legs (FMP4 + TS). The first
		// version read every statistic off `muxings[0]` while joining every
		// `muxingType`, so the row advertised "FMP4, TS" and gave FMP4's numbers under
		// both names — the TS leg was unreachable from the UI (review finding). The old
		// fixture had one muxing, so no assertion could see which leg was reported.
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([
						result("s-1", {
							templateRendition: "v1080",
							muxings: [
								{
									muxingId: "m-fmp4",
									muxingType: "FMP4",
									avgBitrate: 4_200_000,
									maxBitrate: 4_500_000,
									segmentsMuxed: 120,
									outputs: [{ outputPath: "video/fmp4/" }],
									drm: [],
								},
								{
									muxingId: "m-ts",
									muxingType: "TS",
									avgBitrate: 3_100_000,
									maxBitrate: 3_300_000,
									segmentsMuxed: 240,
									outputs: [{ outputPath: "video/ts/" }],
									drm: [],
								},
							],
						}),
					]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		// Both legs named, and each one's OWN figures reachable.
		expect(screen.getByText("FMP4")).toBeTruthy();
		expect(screen.getByText("TS")).toBeTruthy();
		expect(screen.getByText("4.2 Mbps")).toBeTruthy();
		expect(screen.getByText("120")).toBeTruthy();
		expect(screen.getByText("3.1 Mbps")).toBeTruthy();
		expect(screen.getByText("240")).toBeTruthy();
		// And each leg's RESOLVED PATH — the fact the plan can never state (C4
		// placeholders) and the reason capture-before-purge exists. Captured since
		// ; this pins that they actually RENDER .
		expect(screen.getByText("video/fmp4/")).toBeTruthy();
		expect(screen.getByText("video/ts/")).toBeTruthy();
	});

	it("renders a DRM'd leg's encrypted path under its DRM type", () => {
		// The chain the owner spelled out: stream → muxing → drm → output →
		// outputPath. A fully-DRM'd muxing has `outputs: []` and writes through the
		// DRM resource, so hiding DRM outputs would hide where the rung landed.
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([
						result("s-1", {
							templateRendition: "v1080",
							muxings: [
								{
									muxingId: "m-drm",
									muxingType: "FMP4",
									avgBitrate: 4_200_000,
									maxBitrate: 4_500_000,
									segmentsMuxed: 120,
									outputs: [],
									drm: [
										{
											drmId: "d-1",
											drmType: "CENC",
											outputs: [
												{ outputPath: "video/enc/1080p_a1b2/" },
												// Duplicate agreeing on the path — the capture
												// tolerates these; the UI must not print it twice.
												{ outputPath: "video/enc/1080p_a1b2/" },
											],
										},
									],
								},
							],
						}),
					]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText("CENC")).toBeTruthy();
		expect(screen.getAllByText("video/enc/1080p_a1b2/")).toHaveLength(1);
	});

	it("the resolved path is COPYABLE and not truncated", async () => {
		// The run-resolved {height}p_{bitrate}_{uuid} key must be traceable in full
		// and one click from the clipboard — it is the fact the plan can never state.
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { templateRendition: "v1080" })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		const path = "video/1080p_4200000_a1b2c3/";
		const button = screen.getByText(path).closest("button");
		expect(button).not.toBeNull();
		// Wrapped, never clipped: the old truncate class must be gone.
		expect(button?.className).toContain("break-all");
		expect(button?.className).not.toContain("truncate");
		await userEvent.click(button as HTMLElement);
		expect(writeText).toHaveBeenCalledWith(path);
	});

	it("explains the path lines through the catalogue — ja renders ja", () => {
		// The lines themselves are data (enum + path, no prose), but their title
		// tooltips are words and words go through the catalogue .
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { templateRendition: "v1080" })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
			"ja",
		);
		expect(
			screen.getByTitle(
				"このレンディションが実際に出力されたパスです。エンコード完了後に確定します。",
			),
		).toBeTruthy();
	});

	it("renders NO path line for a leg without captured outputs, rather than a dash", () => {
		// Snapshots captured before  have no outputs at all; an em dash
		// would claim we looked and found none. A REAL leg with empty outputs+drm —
		// `muxings: []` never mounts LegPaths at all, so it cannot pin this claim
		// (stack review, M2: deleting the early return passed that variant).
		const { container } = renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([
						result("s-1", {
							muxings: [
								{
									muxingId: "m-old",
									muxingType: "FMP4",
									avgBitrate: 4_200_000,
									maxBitrate: 4_500_000,
									segmentsMuxed: 120,
									outputs: [],
									drm: [],
								},
							],
						}),
					]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.queryByText(/video\//)).toBeNull();
		// And no EMPTY path container either — nothing, not an empty box. The
		// selector is the OUTER container's classes: the inner font-mono lines
		// vanish with empty arrays regardless, so only the wrapper can distinguish
		// "early return" from "empty box" (first attempt asserted the inner class
		// and the mutation survived).
		expect(
			container.querySelectorAll('[class*="mt-0.5"][class*="space-y-0.5"]'),
		).toHaveLength(0);
	});

	// Keep the rendered explanation aligned with all four attributeResult
	// witnesses, including non-QC fixed settings and template-specific paths.
	const WHY_EN =
		"Results are matched first by a unique QC-mirror filename. Without that filename, fixed results require matching encoder-returned fixed settings; flexible results use a unique template-specific output path, or fall back to a sole flexible template of the same codec when no path evidence applies. Ambiguous or mismatched evidence remains “Unattributed”; it is never guessed.";
	const WHY_JA =
		"まずQC用ファイル名の一意な一致で結果を関連付けます。ファイル名がない場合、固定設定の結果はエンコーダが返した固定設定の一致、自動選択の結果はテンプレート固有の出力パスの一意な一致を使います。パスの根拠がない自動選択の結果に限り、同じコーデックの自動選択テンプレートが1つなら関連付けます。根拠が曖昧・不一致なら推測せず「帰属先不明」に残します。";

	/** One attributed rung and two the capture could not bind. */
	const mixedAttribution = () =>
		snapshot([
			result("s-1", { templateRendition: "v1080" }),
			result("s-2"),
			result("s-3"),
		]);

	it("groups attributed results and explains all four attribution witnesses", () => {
		renderL(
			<PerTitleResultsPanel
				view={{ origin: "step", snapshot: mixedAttribution() }}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/From template v1080/)).toBeTruthy();
		// Counted, not hidden — and named for what it IS (no template could be
		// bound), not "Template unknown": the template is not unknown to Bitmovin
		// alone, it is what our own filename rule declined to guess (HIGH-11).
		expect(screen.getByText("Unattributed (2)")).toBeTruthy();
		expect(screen.queryByText(/Template unknown/)).toBeNull();
		// Explain non-QC witnesses without promising a looser fallback after
		// ambiguous or mismatched evidence.
		expect(screen.getByText(WHY_EN)).toBeTruthy();
	});

	it("ja: labels 帰属先不明 and explains all four attribution witnesses", () => {
		renderL(
			<PerTitleResultsPanel
				view={{ origin: "step", snapshot: mixedAttribution() }}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
			"ja",
		);
		expect(screen.getByText("帰属先不明(2 件)")).toBeTruthy();
		expect(screen.queryByText(/テンプレート不明/)).toBeNull();
		expect(screen.getByText(WHY_JA)).toBeTruthy();
	});

	it("does not explain unattributed rows when there are none", () => {
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { templateRendition: "v1080" })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.queryByText(WHY_EN)).toBeNull();
	});

	it("names every copy button for its rendition, leg and path — unique per row, never a bare 'Copy'", () => {
		// The audit heard N identical "Copy" buttons (UX-04's
		// copy-name requirement): a screen-reader user listing controls could not
		// tell which rung or leg any of them copied. Two rungs, three legs, one of
		// them DRM'd — so the names must carry rendition + format (+ DRM) + path.
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([
						result("s-1", {
							templateRendition: "v1080",
							muxings: [
								{
									muxingId: "m-fmp4",
									muxingType: "FMP4",
									outputs: [{ outputPath: "video/1080p/fmp4/" }],
									drm: [],
								},
								{
									muxingId: "m-ts",
									muxingType: "TS",
									outputs: [{ outputPath: "video/1080p/ts/" }],
									drm: [],
								},
							],
						}),
						result("s-2", {
							templateRendition: "v720",
							appliedSettings: { width: 1280, height: 720 },
							muxings: [
								{
									muxingId: "m-drm",
									muxingType: "FMP4",
									outputs: [],
									drm: [
										{
											drmId: "d-1",
											drmType: "CENC",
											outputs: [{ outputPath: "video/720p/enc/" }],
										},
									],
								},
							],
						}),
					]),
				}}
				templateOrder={["v1080", "v720"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		const names = screen
			.getAllByRole("button", { name: /output path/ })
			.map((button) => button.getAttribute("aria-label"));
		// Exact, in DOM order: target (rendition, leg, DRM) and purpose, then the
		// path — which is what makes two same-resolution rungs distinguishable.
		expect(names).toEqual([
			"Copy the output path of rendition 1920×1080 (FMP4): video/1080p/fmp4/",
			"Copy the output path of rendition 1920×1080 (TS): video/1080p/ts/",
			"Copy the CENC-encrypted output path of rendition 1280×720 (FMP4): video/720p/enc/",
		]);
		expect(new Set(names).size).toBe(names.length);
		// The old identical name is gone: no button on the panel is just "Copy".
		expect(screen.queryByRole("button", { name: /^Copy$/ })).toBeNull();
	});

	it("ja: the copy-button name carries the rendition and leg in Japanese", () => {
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { templateRendition: "v1080" })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
			"ja",
		);
		expect(
			screen.getByRole("button", {
				name: "レンディション 1920×1080・FMP4 の出力パスをコピー: video/1080p_4200000_a1b2c3/",
			}),
		).toBeTruthy();
	});

	it("ja: announces a resolved-path copy through the shared polite live region", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { templateRendition: "v1080" })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
			"ja",
		);
		await user.click(
			screen.getByRole("button", {
				name: "レンディション 1920×1080・FMP4 の出力パスをコピー: video/1080p_4200000_a1b2c3/",
			}),
		);

		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("コピーしました"),
		);
		expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
		expect(writeText).toHaveBeenCalledWith("video/1080p_4200000_a1b2c3/");
	});

	it("names the rung by its stream id when the encoder reported no applied size", () => {
		// The cell shows "—"; a name saying "rendition —" would name nothing, so the
		// fallback is the id the row is identified by (its first column).
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-9", { appliedSettings: undefined })]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(
			screen.getByRole("button", {
				name: "Copy the output path of rendition s-9 (FMP4): video/1080p_4200000_a1b2c3/",
			}),
		).toBeTruthy();
	});

	it("warns when the scan stopped early, so a short ladder is not read as complete", () => {
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1")], { complete: false }),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/stopped before the end/i)).toBeTruthy();
	});

	it("warns when a codec config could not be read, so empty params are not read as unset", () => {
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([result("s-1", { params: {} })], {
						codecConfigErrors: 1,
					}),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		expect(screen.getByText(/could not be read/i)).toBeTruthy();
		expect(screen.getByText(/not read/i)).toBeTruthy();
	});

	it("renders a rung with no muxing statistics without inventing any", () => {
		renderL(
			<PerTitleResultsPanel
				view={{
					origin: "step",
					snapshot: snapshot([
						result("s-1", { muxings: [], appliedSettings: undefined }),
					]),
				}}
				templateOrder={["v1080"]}
				canCapture={false}
				jobId={JOB_ID}
			/>,
		);
		// Em dashes, not zeros: "0 kbps" would be a measurement we never made.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
	});
});

describe("per-title results panel — capturing", () => {
	it("POSTs to the backfill route, then invalidates the job query", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const { client } = renderL(
			<PerTitleResultsPanel
				view={{ origin: "absent" }}
				templateOrder={["v1080"]}
				canCapture={true}
				jobId={JOB_ID}
			/>,
		);
		// Invalidation, not reload : the reload cost tab/expansion/player
		// state and was untestable in jsdom, so the success path had NO test at all.
		const invalidate = vi.spyOn(client, "invalidateQueries");
		await userEvent.click(screen.getByRole("button", { name: /capture now/i }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				`/api/encoding-jobs/${JOB_ID}/capture-per-title-results`,
				{ method: "POST" },
			);
		});
		// The job row owns the snapshot, so its key — and ONLY on success (the error
		// test below still expects zero invalidations).
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["encoding-job", JOB_ID],
			}),
		);
	});

	it("surfaces the route's error verbatim — a purged encoding says so", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: "Encoding not found" }), {
				status: 502,
			}),
		);
		const { client } = renderL(
			<PerTitleResultsPanel
				view={{ origin: "absent" }}
				templateOrder={["v1080"]}
				canCapture={true}
				jobId={JOB_ID}
			/>,
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		await userEvent.click(screen.getByRole("button", { name: /capture now/i }));
		await waitFor(() =>
			expect(screen.getByText(/Encoding not found/)).toBeTruthy(),
		);
		// A failed capture changed nothing on the row — refetching would only wipe
		// the error the operator is reading.
		expect(invalidate).not.toHaveBeenCalled();
	});
});
