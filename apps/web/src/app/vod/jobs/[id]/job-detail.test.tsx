import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSceneAnalysis } from "@bitovp/core";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import {
	renderLocalized as renderL,
	renderWithQuery as wrap,
} from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

// Control the data layer so the detail renders against a fixed job payload and
// the re-run-as-new POST is observable. ApiError carries a status + message,
// mirroring lib/api so the 500 path renders the route message. The class lives
// INSIDE the (hoisted) factory; tests import it back from the mocked module.
const apiFetch = vi.fn();
vi.mock("@/lib/api", () => {
	class ApiError extends Error {
		constructor(
			readonly status: number,
			message: string,
			readonly details?: unknown,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return {
		apiFetch: (...args: unknown[]) => apiFetch(...args),
		ApiError,
	};
});

// Delete redirects to the list via router.push; mock the app router so the
// component can mount under jsdom (no real router context) and the push is
// observable.
const routerPush = vi.fn();
/**
 * hls.js and Shaka Player, mocked — neither was, and that was a coverage hole rather
 * than an oversight that happened to work.
 *
 * Without these, jsdom's `Hls.isSupported` is false so HLS silently took the
 * NATIVE path (a `<video src>`, which jsdom tolerates), and Shaka Player's
 * `MediaPlayer.create` threw inside `PlaybackSurface` and unmounted the
 * subtree. So every playback test in this file exercised native HLS only, and the
 * rail's DASH path had never been rendered once — which is how a defect in the
 * DASH-then-Enlarge flow could sit here unnoticed.
 */
/**
 * Every URL a player was actually pointed at, in order. Recorded because
 * asserting on the rendered HTML is not the same claim: the manifest LIST prints
 * every url, so `innerHTML` contains `stream.mpd` whether or not the dialog is
 * playing it — an assertion that passes for the wrong reason.
 */
const playerSources: string[] = [];
vi.mock("hls.js", () => {
	class Hls {
		static Events = { ERROR: "hlsError" };
		static isSupported() {
			return true;
		}
		on() {}
		loadSource(url: string) {
			playerSources.push(url);
		}
		attachMedia() {}
		startLoad() {}
		destroy() {}
	}
	return { default: Hls };
});
vi.mock("shaka-player", () => ({
	default: {
		polyfill: { installAll() {} },
		Player: class {
			static isBrowserSupported() {
				return true;
			}
			addEventListener() {}
			removeEventListener() {}
			async attach() {}
			configure() {}
			async load(url: string) {
				playerSources.push(url);
			}
			async destroy() {}
		},
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush }),
}));

import type { ManifestPlaybackLink } from "@bitovp/core";
import { ApiError } from "@/lib/api";
import { JobDetail } from "./job-detail";
import { OverviewStrip } from "./overview-strip";

const JOB_ID = "00000000-0000-4000-8000-000000000001";

/** A small but representative step log: input → encoding → codec → stream
 *  (cross-links codec + nothing else) → muxing, plus one crashed-mid-step
 *  muxing (RUNNING, no response) and the encoding AWAIT. */
const STEP_LOG = [
	{
		step: "input:main",
		kind: "CREATE_INPUT_S3",
		status: "DONE",
		payload: { name: "S3 in", bucketName: "in-bucket" },
		refs: {},
		resourceId: "in-1",
		request: { name: "S3 in", bucketName: "in-bucket", refs: {} },
		response: { id: "in-1" },
	},
	{
		step: "encoding",
		kind: "CREATE_ENCODING",
		status: "DONE",
		payload: {},
		refs: {},
		resourceId: "enc-1",
		request: { name: "job", cloudRegion: "AWS_US_EAST_1", refs: {} },
		response: { id: "enc-1" },
	},
	{
		step: "codec:v",
		kind: "CREATE_CODEC_H264",
		status: "DONE",
		payload: {},
		refs: {},
		resourceId: "cfg-1",
		request: { name: "h264", height: 360, refs: {} },
		response: { id: "cfg-1" },
	},
	{
		step: "stream:v",
		kind: "CREATE_STREAM",
		status: "DONE",
		payload: {},
		refs: { encodingId: "enc-1", codecConfigId: "cfg-1" },
		resourceId: "st-1",
		request: { name: "v", mode: "STANDARD", refs: {} },
		response: { id: "st-1" },
	},
	{
		step: "muxing:crashed",
		kind: "CREATE_MUXING_FMP4",
		status: "RUNNING",
		payload: {},
		refs: { encodingId: "enc-1", streamId: "st-1" },
		// No response → "response unavailable".
	},
	{
		step: "await:encoding",
		kind: "AWAIT_ENCODING",
		status: "DONE",
		payload: {},
		refs: { encodingId: "enc-1" },
		request: { refs: {} },
		response: { status: "FINISHED", progress: 100 },
	},
];

function jobRow(over: Record<string, unknown> = {}) {
	return {
		id: JOB_ID,
		name: "Sample job",
		labels: [],
		status: "FINISHED",
		region: "us-east-1",
		doneSteps: 5,
		totalSteps: 6,
		error: null,
		bitmovinEncodingId: "enc-1",
		cancelRequested: false,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:02:30.000Z",
		plan: {},
		stepLog: STEP_LOG,
		...over,
	};
}

/** Routes apiFetch by URL: the job GET, the credentials/vmaf GETs, the re-run
 *  POST and the cancel POST (each overridable via `reRun`/`cancel`). */
function mockApi(opts: {
	row?: Record<string, unknown>;
	/** Still routed, so a component that re-adds the query is caught by the
	 *  "never fetches /api/credentials" assertion instead of throwing. */
	credentials?: unknown[];
	reRun?: () => Promise<unknown>;
	cancel?: () => Promise<unknown>;
	vmaf?: unknown[];
	retryVmaf?: () => Promise<unknown>;
	analysis?: unknown;
}) {
	apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
		if (input.startsWith("/api/vmaf-jobs/") && input.endsWith("/retry"))
			return opts.retryVmaf?.();
		if (input.includes("/re-run-as-new")) {
			if (!opts.reRun) {
				throw new ApiError(500, "no re-run configured");
			}
			return opts.reRun();
		}
		if (input.includes("/cancel")) {
			if (!opts.cancel) {
				throw new ApiError(500, "no cancel configured");
			}
			return opts.cancel();
		}
		if (input === `/api/encoding-jobs/${JOB_ID}/analysis`)
			return opts.analysis ?? { enabled: false, source: null };
		if (input.startsWith(`/api/encoding-jobs/${JOB_ID}`)) {
			return jobRow(opts.row);
		}
		if (input.startsWith("/api/credentials")) {
			return opts.credentials ?? [];
		}
		if (input.startsWith("/api/vmaf-jobs")) {
			return { items: opts.vmaf ?? [] };
		}
		void init;
		return {};
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	playerSources.length = 0;
	// jsdom exposes navigator.clipboard as a getter-only prop; define our own
	// resolving writeText so the copy handlers (which catch rejection) don't
	// silently no-op in assertions that need the copied text.
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
	});
});

describe("JobDetail — VMAF-only recovery", () => {
	const failed = {
		id: "failed-local",
		model: "vmaf_v0.6.1",
		mode: "VOD",
		status: "ERROR",
		localRetryAvailable: true,
	};
	it("shows a report-read error and recovers with GET retry without starting work", async () => {
		mockApi({});
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("Missing API mock");
		let unavailable = true;
		apiFetch.mockImplementation((input, init) =>
			String(input).startsWith("/api/vmaf-jobs?")
				? unavailable
					? Promise.reject(new ApiError(503, "Unavailable"))
					: Promise.resolve({ items: [] })
				: original(input, init),
		);
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		expect(
			await screen.findByText("Could not load VMAF reports."),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Measure VMAF again" }),
		).toBeDisabled();
		unavailable = false;
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Measure VMAF again" }),
			).toBeEnabled(),
		);
		expect(
			screen.queryByText("Could not load VMAF reports."),
		).not.toBeInTheDocument();
		expect(
			apiFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
		).toHaveLength(0);
	});
	it("retries the failed measurement without creating an encoding", async () => {
		mockApi({
			row: { status: "QC_FAILED" },
			vmaf: [failed],
			retryVmaf: async () => ({ id: "replacement", status: "PENDING" }),
		});
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "Retry VMAF only" }),
		);
		expect(
			await screen.findByText(
				"VMAF retry queued. The encoding will not run again.",
			),
		).toBeVisible();
		expect(
			apiFetch.mock.calls
				.filter(([, init]) => init?.method === "POST")
				.map(([url]) => url),
		).toEqual(["/api/vmaf-jobs/failed-local/retry"]);
	});
	it("prevents overlapping calculation requests while a report is active", async () => {
		mockApi({
			vmaf: [
				failed,
				{
					...failed,
					id: "running",
					status: "RUNNING",
					localRetryAvailable: false,
				},
			],
		});
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		expect(
			await screen.findByRole("button", { name: "Retry VMAF only" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Measure VMAF again" }),
		).toBeDisabled();
	});
	it("does not offer local retry for a cloud or historical report", async () => {
		mockApi({ vmaf: [{ ...failed, localRetryAvailable: false }] });
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		await screen.findByRole("link", { name: "vmaf_v0.6.1 · VOD" });
		expect(
			screen.queryByRole("button", { name: "Retry VMAF only" }),
		).toBeNull();
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("JobDetail — re-run as new", () => {
	it("offers re-registration for a reset finished job without AI Scene Analysis", async () => {
		mockApi({
			analysis: { enabled: false, captureSuppressed: true, source: null },
		});
		wrap(<JobDetail id={JOB_ID} />);
		await userEvent.click(await screen.findByText("Content Library"));
		expect(
			screen.getByRole("button", { name: "Register in library again" }),
		).toBeVisible();
		expect(screen.queryByText("AI Scene Analysis")).not.toBeInTheDocument();
	});
	it("copies settings into the wizard without resuming or creating a job", async () => {
		mockApi({ row: { status: "ERROR" } });
		wrap(<JobDetail id={JOB_ID} />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Copy settings and edit" }),
		);
		expect(routerPush).toHaveBeenCalledWith(`/vod/new?from=${JOB_ID}`);
		expect(screen.queryByRole("button", { name: "Retry (resume)" })).toBeNull();
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(false);
	});
	it("POSTs to the route and renders success with a link to the new job", async () => {
		const newId = "00000000-0000-4000-8000-0000000000ff";
		mockApi({ reRun: async () => ({ id: newId, sourceId: JOB_ID }) });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Re-run as new job (retry)" }),
		);

		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/re-run-as-new"),
			);
			expect(call).toBeTruthy();
			expect((call?.[1] as RequestInit)?.method).toBe("POST");
		});

		const link = await screen.findByRole("link", { name: /Open .* →/ });
		expect(link).toHaveAttribute("href", `/vod/jobs/${newId}`);
		expect(screen.getByText(/New job queued/)).toBeInTheDocument();
	});

	it("renders the 500 enqueue-failure inline and states the source is unchanged", async () => {
		mockApi({
			reRun: async () => {
				throw new ApiError(500, "Failed to enqueue the new job");
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Re-run as new job (retry)" }),
		);

		const alert = await screen.findByText(/Could not start a new run/);
		expect(alert).toHaveTextContent("Failed to enqueue the new job");
		expect(alert).toHaveTextContent("This job is unchanged");
		// No success link on the failure path.
		expect(
			screen.queryByRole("link", { name: /Open .* →/ }),
		).not.toBeInTheDocument();
	});

	it("hides the re-run button for a DRAFT job", async () => {
		mockApi({ row: { status: "DRAFT" } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(
			screen.queryByRole("button", { name: "Re-run as new job (retry)" }),
		).not.toBeInTheDocument();
	});
});

describe("JobDetail — cancel", () => {
	it.each([
		"QUEUED",
		"RUNNING",
		"AWAITING_QC",
	])("does not offer a new paid retry while %s", async (status) => {
		mockApi({ row: { status } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(
			screen.queryByRole("button", { name: "Re-run as new job (retry)" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Copy settings and edit" }),
		).toBeVisible();
		if (status !== "AWAITING_QC")
			expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
	});
	it("shows Cancel for a RUNNING job and POSTs to the cancel route", async () => {
		mockApi({
			row: { status: "RUNNING" },
			cancel: async () => ({ id: JOB_ID, cancelRequested: true }),
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/cancel"),
			);
			expect(call).toBeTruthy();
			expect(String(call?.[0])).toContain(
				`/api/encoding-jobs/${JOB_ID}/cancel`,
			);
			expect((call?.[1] as RequestInit)?.method).toBe("POST");
		});
	});

	it("shows Cancel for a QUEUED job", async () => {
		mockApi({ row: { status: "QUEUED" } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
	});

	it("hides Cancel for a terminal (FINISHED) job", async () => {
		mockApi({ row: { status: "FINISHED" } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(
			screen.queryByRole("button", { name: "Cancel" }),
		).not.toBeInTheDocument();
	});

	it("renders the derived Canceling… state (flag set, status not terminal) instead of the button", async () => {
		mockApi({ row: { status: "RUNNING", cancelRequested: true } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		// The derived indicator (a badge, not a button) shows…
		expect(screen.getByText("Canceling…")).toBeInTheDocument();
		// …and the Cancel button is gone (already canceling).
		expect(
			screen.queryByRole("button", { name: "Cancel" }),
		).not.toBeInTheDocument();
	});

	it("renders a 409 as 'already finished or canceled'", async () => {
		mockApi({
			row: { status: "RUNNING" },
			cancel: async () => {
				throw new ApiError(409, "Job is not cancelable");
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(
			await screen.findByText(/already finished or canceled/i),
		).toBeInTheDocument();
	});

	it("shows Re-run-as-new for a CANCELED job", async () => {
		mockApi({ row: { status: "CANCELED" } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(
			screen.getByRole("button", { name: "Re-run as new job (retry)" }),
		).toBeInTheDocument();
		// No Cancel button on a terminal job.
		expect(
			screen.queryByRole("button", { name: "Cancel" }),
		).not.toBeInTheDocument();
	});
});

describe("JobDetail — Resources tab", () => {
	async function openResources() {
		const user = userEvent.setup();
		await user.click(screen.getByRole("tab", { name: "Resources" }));
		return user;
	}

	it("renders the cross-linked resource tree grouped by type", async () => {
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		await openResources();

		// Group headers present (in canonical order).
		expect(await screen.findByText("Inputs")).toBeInTheDocument();
		expect(screen.getByText("Encoding")).toBeInTheDocument();
		expect(screen.getByText("Codec configs")).toBeInTheDocument();
		expect(screen.getByText("Streams")).toBeInTheDocument();
		expect(screen.getByText("Muxings")).toBeInTheDocument();

		// A copyable resource id (the encoding id) is rendered as a button.
		expect(
			screen.getByRole("button", { name: /Copy resource id: enc-1/ }),
		).toBeInTheDocument();
	});

	it("cross-links a stream's codec ref to the codec step as an in-page anchor", async () => {
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		await openResources();

		// The stream node carries a codecConfigId ref → an anchor to codec:v.
		const codecRef = await screen.findByTitle(/cfg-1 \(created by codec:v\)/);
		expect(codecRef).toHaveAttribute("href", "#resource-codec_-v");
	});

	it("shows 'response unavailable' for a step that ran without a response", async () => {
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		await openResources();

		expect(await screen.findByText(/response unavailable/)).toBeInTheDocument();
	});

	it("copies a secret-free cURL for a create step (and marks AWAIT unavailable)", async () => {
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		const user = await openResources();

		// The input:main row has a "Copy as cURL" button; click the first one.
		// (userEvent installs its own clipboard stub on setup, so read the
		// copied text back through navigator.clipboard.readText rather than a
		// pre-installed writeText spy.)
		const buttons = await screen.findAllByRole("button", {
			name: "Copy as cURL",
		});
		expect(buttons.length).toBeGreaterThan(0);
		await user.click(buttons[0] as HTMLElement);

		let copied = "";
		await waitFor(async () => {
			copied = await navigator.clipboard.readText();
			expect(copied).toContain("curl -X POST");
		});
		expect(copied).toContain("api.bitmovin.com/v1/encoding/inputs/s3");
		// Placeholder auth only — never an inline key.
		expect(copied).toContain("$BITMOVIN_API_KEY");
		expect(copied).not.toMatch(/X-Api-Key: (?!\$)/);

		// The AWAIT_ENCODING step has no write endpoint → "cURL unavailable".
		expect(screen.getByText("cURL unavailable")).toBeInTheDocument();
	});

	/**
	 * The visible label was already translated; its TOOLTIP was not. `curlForStep`
	 * lives in `packages/core`, which is UI-free, so it returns a `code` and the
	 * component maps it to copy — and the mapping had nothing asserting it.
	 */
	it("localizes the cURL-unavailable tooltip, which comes from a core reason CODE", async () => {
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />, "ja");
		await screen.findByText("Sample job");
		const user = userEvent.setup();
		await user.click(await screen.findByRole("tab", { name: "リソース" }));
		// AWAIT_ENCODING → NO_ENDPOINT, whose copy interpolates the step kind.
		const unavailable = await screen.findByText("cURL は利用できません");
		expect(unavailable).toHaveAttribute(
			"title",
			"AWAIT_ENCODING に対応する Bitmovin の単一エンドポイントがありません",
		);
	});
});

describe("JobDetail — encoding actions (advanced)", () => {
	it.each([
		"ja",
		"en",
	] as const)("%s: omits advanced encoding operations even with an encoding", async (locale) => {
		mockApi({ row: { status: "FINISHED" } });
		wrap(<JobDetail id={JOB_ID} />, locale);
		await screen.findByText("Sample job");
		expect(
			screen.queryByText(
				locale === "ja"
					? "エンコード操作(上級)"
					: "Encoding actions (advanced)",
			),
		).not.toBeInTheDocument();
		// Nothing reads a transfer-retries endpoint any more — the API was
		// removed in 1.271.1 (COVERAGE C25). Kept as a regression guard.
		expect(
			apiFetch.mock.calls.filter((c) =>
				String(c[0]).includes("/transfer-retries"),
			),
		).toHaveLength(0);
	});

	it("omits the group entirely for a DRAFT job (no encoding to act on)", async () => {
		mockApi({ row: { status: "DRAFT" } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(
			screen.queryByText("Encoding actions (advanced)"),
		).not.toBeInTheDocument();
	});
});

describe("JobDetail — delete", () => {
	it("disables delete for an active (RUNNING) job", async () => {
		mockApi({ row: { status: "RUNNING" } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(
			screen.getByRole("button", { name: /Delete job \(disabled\)/ }),
		).toBeDisabled();
	});

	it("confirms then DELETEs a terminal job and redirects to the list", async () => {
		mockApi({ row: { status: "FINISHED" } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Delete job" }));
		// Only the explicit confirm click issues the DELETE.
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/encoding-jobs/${JOB_ID}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/vod/jobs"));
	});
});

/**
 * The manifest list is the playback entry point, so what it offers has to match
 * what a browser can actually load: the URL the ROUTE derived, a reason when it
 * could not, and a Play button only when neither applies.
 *
 * The derivation itself moved to the server in , so
 * these cases feed `playbackLinks` straight in — plan+credential → link is
 * covered where it now runs (`packages/core/src/playback` and
 * `lib/server/playback-links.test.ts`).
 */
describe("JobDetail — manifest playback links", () => {
	const AWS_URL =
		"https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/stream.m3u8";

	function link(
		over: Partial<ManifestPlaybackLink> = {},
	): ManifestPlaybackLink {
		return {
			key: "hls",
			kind: "HLS",
			label: "HLS manifest",
			url: AWS_URL,
			path: "output/stream.m3u8",
			via: "derived",
			...over,
		};
	}

	it("shows the URL the route derived and offers Play", async () => {
		mockApi({ row: { playbackLinks: [link()] } });
		wrap(<JobDetail id={JOB_ID} />);

		expect(await screen.findByText(AWS_URL)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
	});

	it("never fetches /api/credentials — that is the point of the move", async () => {
		mockApi({ row: { playbackLinks: [link()] } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(AWS_URL);

		// Deriving in the browser meant serialising every credential's config
		// (region, host, namespace) into the page to build one URL.
		const urls = apiFetch.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.startsWith("/api/credentials"))).toBe(false);
	});

	it("explains a private destination instead of offering playback", async () => {
		mockApi({
			row: {
				playbackLinks: [
					link({ url: null, via: "none", reason: { code: "NOT_PUBLIC" } }),
				],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);

		expect(
			await screen.findByText(/The output ACL is private/),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
	});

	it("refuses to play an http origin but still shows the URL", async () => {
		/**
		 * The mixed-content case. Before the reason existed, any non-null URL got
		 * a Play button — so a GENERIC_S3 output with ssl:false offered a button
		 * that a https page can only fail to load.
		 */
		const url = "http://minio.internal:9000/out/output/stream.m3u8";
		mockApi({
			row: {
				playbackLinks: [link({ url, reason: { code: "INSECURE_ENDPOINT" } })],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);

		expect(await screen.findByText(url)).toBeInTheDocument();
		expect(screen.getByText(/served over http, not https/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
	});

	it("names a missing credential rather than showing a bare path", async () => {
		mockApi({
			row: {
				playbackLinks: [
					link({ url: null, via: "none", reason: { code: "NO_CREDENTIAL" } }),
				],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);

		expect(
			await screen.findByText(/credential this output writes through/),
		).toBeInTheDocument();
		expect(screen.getByText("output/stream.m3u8")).toBeInTheDocument();
	});

	it("renders without a manifest section when the field is absent", async () => {
		// The field is optional, so a response cached from before it existed (or a
		// DRAFT whose plan does not parse) must not blank the page.
		mockApi({ row: {} });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(screen.queryByText("Manifests")).toBeNull();
	});

	it("localises the reason — it is catalogue copy, not core prose", async () => {
		mockApi({
			row: {
				playbackLinks: [
					link({ url: null, via: "none", reason: { code: "NOT_PUBLIC" } }),
				],
			},
		});
		wrap(<JobDetail id={JOB_ID} />, "ja");

		expect(await screen.findByText(/出力のACLが非公開/)).toBeInTheDocument();
		expect(screen.queryByText(/The output ACL is private/)).toBeNull();
	});
});

/**
 * The inline preview: playback is offered on arrival, not behind a click
 * (owner's request, 2026-08-11). What matters here is the ACTIVATION rule and
 * that only one player ever runs — the panel itself is tested in
 * `player-preview.test.tsx`.
 */
describe("JobDetail — inline playback preview", () => {
	const AWS_URL =
		"https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/stream.m3u8";

	function link(
		over: Partial<ManifestPlaybackLink> = {},
	): ManifestPlaybackLink {
		return {
			key: "hls",
			kind: "HLS",
			label: "HLS manifest",
			url: AWS_URL,
			path: "output/stream.m3u8",
			via: "derived",
			...over,
		};
	}

	/** A plan whose only interesting property here is its generation timing. */
	function planWith(timing: "JUST_IN_TIME" | "POST_ENCODING") {
		const credentialId = "00000000-0000-4000-8000-000000000002";
		return {
			planVersion: 1,
			name: "j",
			bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1" },
			generation: { timing },
			inputs: [
				{ key: "main", kind: "S3", name: "in", bucket: "b", credentialId },
			],
			outputs: [
				{ key: "origin", kind: "S3", name: "out", bucket: "o", credentialId },
			],
			ingest: [
				{
					key: "video",
					inputKey: "main",
					inputPath: "a.mp4",
					position: 0,
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					segmentLength: 4,
					destination: { outputKey: "origin", path: "out/v/" },
				},
			],
			manifests: [],
		};
	}

	it("shows the preview on a finished job without any click", async () => {
		mockApi({
			row: { plan: planWith("POST_ENCODING"), playbackLinks: [link()] },
		});
		wrap(<JobDetail id={JOB_ID} />);
		expect(await screen.findByText("Playback preview")).toBeInTheDocument();
	});

	it("automatically decorates the only player while analysis stays below job facts", async () => {
		const document = normalizeSceneAnalysis({
			metadata: { version: "1.9.0" },
			duration: 10,
			scenes: [
				{
					id: "61cd7f2b-4057-4d21-9475-0bc5bfd78413",
					startInSeconds: 1,
					endInSeconds: 9,
					title: "Scene one",
				},
			],
		});
		mockApi({
			row: {
				plan: {
					...planWith("POST_ENCODING"),
					aiSceneAnalysis: {
						assetDescription: {
							filename: "analysis.json",
							destination: { outputKey: "origin", path: "out/" },
						},
						outputLanguageCodes: ["en"],
					},
				},
				playbackLinks: [link()],
			},
			analysis: {
				enabled: true,
				source: {
					id: "source",
					jobId: JOB_ID,
					originalJobId: JOB_ID,
					state: "READY",
					error: null,
					locales: ["en"],
					analyses: [
						{ id: "analysis", locale: "en", document, createdAt: "2026-09-15" },
					],
					contents: [],
					snapshot: {
						schemaVersion: 1,
						kind: "VOD_JOB",
						name: "source",
						planHash: "hash",
						identity: "UNVERIFIED",
						inputs: [],
						playbackLinks: [link()],
						qcVerdict: null,
						qcOverriddenAt: null,
					},
				},
			},
		});
		const user = userEvent.setup();
		const view = wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Show scene overlay");
		const panel = screen.getByText("AI Scene Analysis").closest("details");
		expect(panel).not.toHaveAttribute("open");
		expect(
			screen
				.getByRole("heading", { name: "Overview" })
				.compareDocumentPosition(panel as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		await user.click(screen.getByText("AI Scene Analysis"));
		expect(view.container.querySelectorAll("video")).toHaveLength(1);
		expect(
			screen.queryByRole("button", { name: "Import analysis" }),
		).toBeNull();
		await user.click(screen.getByText(/1.00–9.00s/));
		const video = view.container.querySelector("video");
		if (!video) throw new Error("Missing shared video");
		Object.defineProperty(video, "readyState", {
			configurable: true,
			value: 1,
		});
		fireEvent.loadedMetadata(video);
		await user.click(screen.getByRole("button", { name: "Seek to 1s" }));
		await waitFor(() =>
			expect(view.container.querySelector("video")?.currentTime).toBe(1),
		);
	});

	it("rev433: does NOT show it mid-encoding even for just-in-time manifests — it says the preview comes with FINISHED", async () => {
		// Owner decision 2026-09-07: right after creation the just-in-time
		// manifest is not there yet either, and the rail answered with a
		// networkError; the rail now says what it is waiting for instead.
		mockApi({
			row: {
				status: "RUNNING",
				plan: planWith("JUST_IN_TIME"),
				playbackLinks: [link()],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		expect(
			await screen.findByText(
				/Playback preview appears here once the encoding has finished/,
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Playback preview")).toBeNull();
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
	});

	it("rev433: while pending, the manifest list (URLs and refusal reasons) still renders — a config defect will not resolve itself at FINISHED", async () => {
		mockApi({
			row: {
				status: "RUNNING",
				plan: planWith("JUST_IN_TIME"),
				playbackLinks: [link({ reason: { code: "INSECURE_ENDPOINT" } })],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(
			/Playback preview appears here once the encoding has finished/,
		);
		expect(screen.getByText(/served over http, not https/)).toBeInTheDocument();
	});

	it("does NOT show it mid-encoding for post-encoding manifests (C1)", async () => {
		// The manifest is written after the run, so a player would 404 for the
		// whole encoding — and the Play affordance must be withheld too.
		mockApi({
			row: {
				status: "RUNNING",
				plan: planWith("POST_ENCODING"),
				playbackLinks: [link()],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(screen.queryByText("Playback preview")).toBeNull();
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
	});

	it("does not preview a link the panel already explained away", async () => {
		mockApi({
			row: {
				plan: planWith("POST_ENCODING"),
				playbackLinks: [link({ reason: { code: "INSECURE_ENDPOINT" } })],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(/served over http, not https/);
		expect(screen.queryByText("Playback preview")).toBeNull();
	});

	it("unmounts the inline player while the enlarged dialog is open", async () => {
		/**
		 * Two players on one page would both buffer segments and only one can be
		 * watched. The preview goes away for as long as the dialog is up.
		 */
		const user = userEvent.setup();
		mockApi({
			row: { plan: planWith("POST_ENCODING"), playbackLinks: [link()] },
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Playback preview");

		await user.click(screen.getByRole("button", { name: "Play" }));
		await waitFor(() =>
			expect(screen.queryByText("Playback preview")).toBeNull(),
		);
	});
});

/**
 * The two-column layout .
 *
 * The properties pinned here are the ones the design makes explicit choices
 * about, and each would be invisible in review if it broke: the rail lives
 * OUTSIDE the tab switch (so playback survives a tab change), the one-player
 * invariant carries over into the new structure, and the timeline is collapsed
 * rather than deleted.
 */
describe("JobDetail — two-column layout", () => {
	const AWS_URL =
		"https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/stream.m3u8";
	function link(
		over: Partial<ManifestPlaybackLink> = {},
	): ManifestPlaybackLink {
		return {
			key: "hls",
			kind: "HLS",
			label: "HLS manifest",
			url: AWS_URL,
			path: "output/stream.m3u8",
			via: "derived",
			...over,
		};
	}

	it("keeps the playback rail on the Resources tab too", async () => {
		// Playback is orthogonal to which tab is open — an operator reading the
		// resource tree should not lose the player. This is the assertion that fails
		// if the rail is ever moved back inside the overview branch.
		mockApi({ row: { playbackLinks: [link()] } });
		wrap(<JobDetail id={JOB_ID} />);
		expect(await screen.findByText(AWS_URL)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("tab", { name: "Resources" }));
		// The manifest list (and so the rail) is still there…
		expect(screen.getByText(AWS_URL)).toBeInTheDocument();
		// …while the tab content actually changed.
		expect(screen.queryByText("Step timeline")).toBeNull();
	});

	it("mounts one player at a time: the rail's preview yields to the dialog", async () => {
		mockApi({ row: { playbackLinks: [link()] } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(AWS_URL);
		// The rail's inline preview is mounted.
		expect(screen.getByText("Playback preview")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Play" }));
		// Two players buffering the same segments is the failure this prevents.
		expect(screen.queryByText("Playback preview")).toBeNull();
	});

	it("enlarges the manifest the rail is actually showing", async () => {
		/**
		 * The bug this pins: `PlayerPreview` held its own `selected` index while the
		 * rail's Enlarge button used `playable[0]`, so switching the preview to DASH
		 * and clicking Enlarge opened HLS — a different stream than the one on screen,
		 * with nothing to say so. The PR's own comment claimed they were the same
		 * link, which was true only until the operator switched (review question C).
		 */
		mockApi({
			row: {
				playbackLinks: [
					link(),
					link({
						key: "dash",
						kind: "DASH",
						label: "DASH manifest",
						url: AWS_URL.replace("stream.m3u8", "stream.mpd"),
						path: "output/stream.mpd",
					}),
				],
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(AWS_URL);

		// Switch the rail's preview to DASH…
		await userEvent.click(
			screen.getByRole("button", { name: "DASH · DASH manifest" }),
		);
		// …then enlarge. The dialog must carry DASH, not the first link.
		await userEvent.click(screen.getByRole("button", { name: "Enlarge" }));
		// The URL the DIALOG's player was pointed at — not what the page prints. The
		// rail's preview unmounts on open (one player at a time), so the last source
		// any player received is the dialog's.
		expect(playerSources.at(-1)).toContain("stream.mpd");
	});

	it("offers an explicit way into the enlarged view", async () => {
		// Shrinking the inline player only costs nothing if the big view is
		// reachable as such, rather than by clicking something labelled "Play".
		mockApi({ row: { playbackLinks: [link()] } });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(AWS_URL);
		expect(screen.getByRole("button", { name: "Enlarge" })).toBeInTheDocument();
	});

	it("keeps the step timeline in the heading outline", async () => {
		// Collapsing it to a bare <summary> dropped it out of the outline entirely —
		// it was an <h2> on main — so the document went h1 → h3 → h2 and the section
		// was unreachable by heading navigation (review finding).
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />);
		const label = await screen.findByText("Step timeline");
		expect(label.closest("h1,h2,h3,[role=heading]")).not.toBeNull();
	});

	it("keeps the timeline open across a tab round-trip", async () => {
		// The <details> lives inside the overview branch, which unmounts on switching
		// to Resources; uncontrolled, it came back closed. Ironic, since the rail was
		// hoisted OUT of that branch for exactly this reason (review finding).
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />);
		const summary = await screen.findByText("Step timeline");
		await userEvent.click(summary);
		expect(summary.closest("details")?.open).toBe(true);

		await userEvent.click(screen.getByRole("tab", { name: "Resources" }));
		await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
		expect(screen.getByText("Step timeline").closest("details")?.open).toBe(
			true,
		);
	});

	it("renders no rail at all for a job with no manifests", async () => {
		// Both children self-suppress on empty, which left an <aside aria-label>
		// wrapping nothing: an empty complementary region announced to screen
		// readers, and a grid cell spending gap-8 on it (review finding).
		mockApi({ row: { playbackLinks: [] } });
		const { container } = wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Sample job");
		expect(container.querySelector("aside")).toBeNull();
	});

	it("collapses the step timeline instead of dropping it", async () => {
		mockApi({});
		wrap(<JobDetail id={JOB_ID} />);
		const summary = await screen.findByText("Step timeline");
		const details = summary.closest("details");
		expect(details).not.toBeNull();
		// Closed by default — the header and Resources tab carry the same facts —
		// but present, because it is the diagnostic view when a step failed.
		expect(details?.open).toBe(false);
	});

	it("renders the rail before the detail in DOM order", async () => {
		/**
		 * Below `lg` the grid collapses to one column and the rail must come first:
		 * on a phone the question is "is it playing?".
		 *
		 * Asserted as DOM order, not as a class, and that distinction found a real
		 * defect: the first implementation put the detail first and lifted the rail
		 * with `order-first`, which DISPLAYS correctly while a keyboard or screen
		 * reader still traverses the whole left column to reach the player. The rail
		 * is now first in the document and placed into column 2 explicitly on `lg`,
		 * so the visual and reading orders agree. jsdom applies no media queries, so
		 * this pins the order the CSS starts from — which is exactly the half that
		 * was wrong.
		 */
		mockApi({ row: { playbackLinks: [link()] } });
		const { container } = wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(AWS_URL);
		const rail = container.querySelector("aside");
		const timeline = screen.getByText("Step timeline");
		expect(rail).not.toBeNull();
		// compareDocumentPosition: 4 = rail precedes timeline in document order.
		expect(
			rail &&
				rail.compareDocumentPosition(timeline) &
					Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("places the rail in the right-hand column on wide screens", async () => {
		/**
		 * A CLASS assertion, and honestly labelled as one: jsdom evaluates no media
		 * queries, loads no stylesheet and performs no layout, so the desktop
		 * arrangement cannot be observed
		 * here — a reviewer confirmed all three
		 * independently (`display` resolves to "block", every rect is 0×0 even with
		 * inline `display:grid`, and `matchMedia` is undefined).
		 *
		 * What it catches, corrected: my first comment said swapping
		 * `lg:col-start-2` for `order-last` renders the layout "mirrored". It does
		 * not — grid auto-placement uses ORDER-MODIFIED document order, so the detail
		 * would still take the `1fr` column. What that swap actually breaks is the
		 * MOBILE stack, since an unprefixed `order-last` pushes the player below the
		 * detail. The mutation that truly mirrors the desktop layout is DELETING the
		 * `col-start` classes. The assertion catches both; the comment named the
		 * wrong hazard, which matters because it is the only thing telling the next
		 * engineer what this test is for.
		 *
		 * The real check for this lives in the browser (E2E), which is where a
		 * two-column grid can actually be measured. This exists so the class cannot
		 * be deleted silently in the meantime.
		 */
		mockApi({ row: { playbackLinks: [link()] } });
		const { container } = wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(AWS_URL);
		const railColumn = container.querySelector("aside")?.parentElement;
		expect(railColumn?.className).toContain("lg:col-start-2");
		const grid = railColumn?.parentElement;
		expect(grid?.className).toContain("lg:grid-cols-[minmax(0,1fr)_380px]");
		// And the detail column explicitly takes column 1, so the two cannot both
		// land in the same cell if one class is edited.
		expect(
			[...(grid?.children ?? [])].some((c) =>
				c.className.includes("lg:col-start-1"),
			),
		).toBe(true);
	});
});

/**
 * The detail panels .
 *
 * These render from the persisted plan, so the fixture carries a real one rather
 * than `{}` — the point of the panels is that they answer "what was encoded"
 * from local data alone, and a test with an empty plan would assert nothing.
 */
describe("JobDetail — rendition / input / storage panels", () => {
	const PLAN = {
		planVersion: 1,
		name: "ladder",
		bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1", encoderVersion: "STABLE" },
		generation: { timing: "POST_ENCODING", encodingMode: "THREE_PASS" },
		inputs: [
			{
				key: "in",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-0000000000c1",
				bucket: "src-bucket",
				name: "S3 Input",
			},
		],
		outputs: [
			{
				key: "out",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-0000000000c2",
				bucket: "dst-bucket",
				name: "S3 Output",
			},
		],
		ingest: [
			{
				key: "src",
				inputKey: "in",
				inputPath: "mezzanine.mov",
				selectionMode: "AUTO",
			},
		],
		renditions: [
			{
				key: "v1080",
				ingestKey: "src",
				codec: "H264",
				height: 1080,
				bitrate: 4_800_000,
				profile: "HIGH",
			},
			{
				key: "v540",
				ingestKey: "src",
				codec: "H264",
				height: 540,
				bitrate: 800_000,
				profile: "MAIN",
			},
			{
				key: "a1",
				ingestKey: "src",
				codec: "AAC",
				bitrate: 128_000,
				rate: 48_000,
			},
		],
		// One thumbnail, so the aux panel MOUNTS from this rendered caller —
		// deleting <AuxOutputsPanel/> from job-detail survived the full suite
		// (review-179 I1/M4: the panel and its tests were green with the slot
		// empty).
		thumbnails: [
			{
				key: "thumb1",
				streamKey: "v1080",
				height: 180,
				positions: [10],
				destination: { outputKey: "out", path: "out/thumbs" },
			},
		],
		muxings: [
			{
				key: "m1080",
				kind: "FMP4",
				streamKey: "v1080",
				destination: {
					outputKey: "out",
					path: "out/1080p",
					acl: "PUBLIC_READ",
				},
			},
			{
				key: "m540",
				kind: "FMP4",
				streamKey: "v540",
				destination: { outputKey: "out", path: "out/540p" },
			},
			// No destination of its own ON PURPOSE, and now with the DRM that makes
			// that legal. The previous fixture had neither — so the assertion "writes
			// via the DRM resource's outputs" was checked against a plan where the
			// sentence was factually false, and the entire DRM display path was
			// unexercised (review finding: 0 of 66 fixtures have this shape).
			{
				key: "ma",
				kind: "FMP4",
				streamKey: "a1",
				segmentLength: 4,
				segmentNaming: "audio_%number%.m4s",
				initSegmentName: "audio_init.mp4",
			},
		],
		drm: [
			// Two of them on ONE muxing: a muxing can be encrypted more than once and
			// each DRM writes its own output, which is exactly the shape whose write
			// paths were unreachable before core grew `drm[].destination`.
			{
				key: "cenc-a",
				kind: "CENC",
				muxingKey: "ma",
				credentialId: "00000000-0000-4000-8000-0000000000d1",
				kid: "00000000000000000000000000000001",
				widevine: { pssh: "cHNzaA==" },
				destination: { outputKey: "out", path: "out/audio-cenc" },
			},
			{
				key: "fp-a",
				kind: "FAIRPLAY",
				muxingKey: "ma",
				credentialId: "00000000-0000-4000-8000-0000000000d1",
				iv: "000000000000000000000000000000ff",
				uri: "skd://key",
				destination: { outputKey: "out", path: "out/audio-fairplay" },
			},
		],
	};

	function planRow(over: Record<string, unknown> = {}) {
		return { plan: PLAN, ...over };
	}

	/**
	 * The same plan with its top rung turned into a per-title template. The
	 * per-title results panel's gate is `planHasPerTitle` — the PLAN, not a status
	 * or a step log — so this is the whole difference.
	 */
	function perTitleRow(over: Record<string, unknown> = {}) {
		const renditions = (PLAN.renditions as Array<Record<string, unknown>>).map(
			(rendition, index) =>
				index === 0 ? { ...rendition, mode: "PER_TITLE_TEMPLATE" } : rendition,
		);
		return {
			plan: {
				...PLAN,
				renditions,
				perTitle: { h264Configuration: { autoRepresentations: {} } },
			},
			...over,
		};
	}

	it("a runtime chip cross-links to its producer on the Resources tab (ledger #71)", async () => {
		// The chip carries the RESOLVED anchor (stream:v1080's node), clicking
		// it switches tabs — the anchor target does not exist while Overview
		// is mounted, which is why a bare href was never enough.
		// The codec step comes FIRST as a DECOY (review-181 I3: with one entry,
		// "find by resourceId" was indistinguishable from "first producing
		// step" — the survived mutation returned every id the same anchor) and
		// doubles as I4's pin: the codecConfigId chip's wiring is asserted too.
		mockApi({
			row: planRow({
				stepLog: [
					{
						step: "codec:v1080",
						kind: "CREATE_CODEC_H264",
						status: "DONE",
						payload: {},
						refs: {},
						resourceId: "cfg-1080",
						request: { name: "h264", refs: {} },
						response: { id: "cfg-1080" },
					},
					{
						step: "stream:v1080",
						kind: "CREATE_STREAM",
						status: "DONE",
						payload: {},
						refs: {},
						resourceId: "st-1080",
						request: { name: "v", refs: {} },
						response: { id: "st-1080" },
					},
				],
			}),
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		const user = userEvent.setup();
		// Expand the v1080 row (the row summary cell names the rendition key).
		const row = screen.getByText("v1080").closest("tr");
		if (!row) {
			throw new Error("v1080 row not rendered");
		}
		await user.click(within(row).getByRole("button", { expanded: false }));
		const link = await screen.findByRole("link", { name: "st-1080" });
		expect(link).toHaveAttribute("href", "#resource-stream_-v1080");
		expect(screen.getByRole("link", { name: "cfg-1080" })).toHaveAttribute(
			"href",
			"#resource-codec_-v1080",
		);
		await user.click(link);
		expect(screen.getByRole("tab", { name: "Resources" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		// The producer node is mounted under that exact id.
		expect(document.getElementById("resource-stream_-v1080")).not.toBeNull();
		// F2 (review-181): the focus move was UNPINNED — deleting focus survived
		// 2120 tests, the same class as the codec chip. waitFor, because focus
		// lands inside the rAF (an immediate read still sees <body>).
		await waitFor(() =>
			expect(document.activeElement).toBe(
				document.getElementById("resource-stream_-v1080"),
			),
		);
	});

	it.each([
		{ encodingMode: "TWO_PASS" },
		{ presetConfiguration: "VOD_STANDARD" },
	])("shows codec-local mode provenance for %j", async (settings) => {
		mockApi({
			row: {
				plan: {
					...PLAN,
					generation: { timing: "POST_ENCODING" },
					renditions: PLAN.renditions.map((rendition) =>
						rendition.codec === "H264"
							? { ...rendition, ...settings }
							: rendition,
					),
				},
			},
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		expect(
			screen.getByText("Encoding mode").nextElementSibling,
		).toHaveTextContent("Configured per rendition");
	});

	it("mounts the aux-outputs panel from the RENDERED page (review-179 I1)", async () => {
		// Deleting <AuxOutputsPanel/> from job-detail survived the full suite:
		// the panel's own tests render the COMPONENT, not the page. PLAN
		// carries one thumbnail, so the panel must appear here — and its
		// heading disappearing means the slot went empty, not a copy change.
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		expect(
			screen.getByRole("heading", { name: "Thumbnails, sprites & keyframes" }),
		).toBeInTheDocument();
		expect(screen.getByText("thumb1")).toBeInTheDocument();
	});

	it("shows no per-title results section for a fixed ladder", async () => {
		// A heading with nothing under it on every non-per-title job would read as a
		// broken feature rather than an inapplicable one.
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		expect(
			screen.queryByRole("heading", { name: /Per-Title results/i }),
		).toBeNull();
	});

	it("shows the per-title results section, uncaptured, for a per-title plan", async () => {
		mockApi({ row: perTitleRow() });
		wrap(<JobDetail id={JOB_ID} />);
		expect(
			await screen.findByRole("heading", { name: /Per-Title results/i }),
		).toBeInTheDocument();
		// Nothing captured on this row, so it says so instead of showing a table.
		expect(screen.getByText(/not captured/i)).toBeInTheDocument();
	});

	it("renders the captured RESULT rungs from the step log", async () => {
		mockApi({
			row: perTitleRow({
				status: "FINISHED",
				stepLog: [
					{
						step: "per-title-results",
						kind: "CAPTURE_PER_TITLE_RESULTS",
						payload: {},
						refs: {},
						status: "DONE",
						response: {
							captured: true,
							snapshot: {
								capturedAt: "2026-08-11T00:00:00.000Z",
								streams: [
									{
										streamId: "s-result-1",
										mode: "PER_TITLE_RESULT",
										templateRendition: "v1080",
										params: { bitrate: 4200000 },
										appliedSettings: { width: 1920, height: 1080 },
										muxings: [
											{
												muxingId: "m",
												muxingType: "FMP4",
												avgBitrate: 4200000,
												segmentsMuxed: 120,
											},
										],
									},
								],
								scan: {
									streamsListed: 2,
									templatesListed: 1,
									templatesDeclared: 1,
									resultsCaptured: 1,
									muxingsListed: 1,
									complete: true,
									codecConfigErrors: 0,
									unattributed: 0,
								},
							},
						},
					},
				],
			}),
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByRole("heading", { name: /Per-Title results/i });
		// The observed values — what the rung actually cost, which the plan cannot say.
		expect(screen.getByText("1920×1080")).toBeInTheDocument();
		expect(screen.getByText("120")).toBeInTheDocument();
		expect(screen.getByText(/From template v1080/)).toBeInTheDocument();
	});

	it("lists the ladder, bitrate-descending, with codec and muxing badges", async () => {
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		expect(await screen.findByText("Renditions")).toBeInTheDocument();

		// Order matters: the top rung is what an operator reads first.
		const keys = screen
			.getAllByText(/^v(1080|540)$/)
			.map((el) => el.textContent);
		expect(keys).toEqual(["v1080", "v540"]);
		// Audio is its own table, so the AAC row is not mixed into the video one.
		expect(screen.getByText("Audio")).toBeInTheDocument();
		expect(screen.getByText("4.8 Mbps")).toBeInTheDocument();
		expect(screen.getByText("128 kbps")).toBeInTheDocument();
	});

	it("expands a row into its muxing detail and classified parameters", async () => {
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");

		const expanders = screen.getAllByRole("button", {
			name: /Show details for /,
		});
		await userEvent.click(expanders[0] as HTMLElement);
		// The destination, copyable, and the schema-default badge on a field the
		// plan did not set (level defaults to null on H264).
		expect(screen.getByText(/out:out\/1080p/)).toBeInTheDocument();
		expect(screen.getByText("Plan parameters")).toBeInTheDocument();
		expect(screen.getAllByText("default").length).toBeGreaterThan(0);
	});

	it("names each DRM system and the output IT writes", async () => {
		// The previous version of this test asserted the "via the DRM outputs" line
		// against a plan with no DRM at all, so the whole DRM display path was
		// unexercised — deleting it left the suite green (review finding).
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		const expanders = screen.getAllByRole("button", {
			name: /Show details for /,
		});
		await userEvent.click(expanders[expanders.length - 1] as HTMLElement);
		expect(screen.getByText("CENC")).toBeInTheDocument();
		expect(screen.getByText("FAIRPLAY")).toBeInTheDocument();
		// Both encrypted paths, not just the systems: a muxing encrypted twice
		// writes twice, and an operator hunting the FairPlay output needs to see it.
		expect(screen.getByText("out:out/audio-cenc")).toBeInTheDocument();
		expect(screen.getByText("out:out/audio-fairplay")).toBeInTheDocument();
		// And what the wizard set for segment naming, shown back.
		expect(screen.getByText("audio_%number%.m4s")).toBeInTheDocument();
		expect(screen.getByText("audio_init.mp4")).toBeInTheDocument();
	});

	it("says a DRM'd muxing writes through the DRM outputs, not a blank path", async () => {
		// A DRM'd muxing carries no destination of its own — the DRM resource owns
		// the encrypted output. Rendering an empty path would read as "nowhere".
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		const expanders = screen.getAllByRole("button", {
			name: /Show details for /,
		});
		// The audio muxing (`ma`) has no destination in this plan.
		await userEvent.click(expanders[expanders.length - 1] as HTMLElement);
		expect(
			screen.getByText(/writes via the DRM resource's outputs/),
		).toBeInTheDocument();
	});

	it("shows the overview strip's facts — region, encoder, mode, duration", async () => {
		// §5 clause 1 had ZERO coverage: `OverviewStrip` could `return null` and all
		// 48 tests stayed green (review finding, confirmed with a throwing canary so
		// it was not merely unmounted).
		mockApi({
			row: planRow({
				status: "FINISHED",
				bitmovinEncodingId: "bm-enc-1",
				// Region and labels are ROW columns, not plan fields — the strip reads
				// them from the row exactly as the header does.
				region: "AWS_AP_NORTHEAST_1",
				labels: ["nightly", "qc"],
				stepLog: [
					{
						step: "await:encoding",
						kind: "AWAIT_ENCODING",
						payload: {},
						refs: {},
						status: "DONE",
						startedAt: "2026-08-11T00:00:00.000Z",
						finishedAt: "2026-08-11T00:04:12.000Z",
					},
				],
			}),
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		expect(screen.getByText("AWS_AP_NORTHEAST_1")).toBeInTheDocument();
		expect(screen.getByText("STABLE")).toBeInTheDocument();
		expect(screen.getByText("THREE_PASS")).toBeInTheDocument();
		// The encode's own wall clock, joined from the AWAIT step's timestamps rather
		// than the row's updatedAt (which moves on every progress write).
		expect(screen.getByText("4m 12s")).toBeInTheDocument();
		// And exactly ONCE now: the id used to render in the strip AND in a bare line
		// above it.
		expect(screen.getAllByText(/bm-enc-1/)).toHaveLength(1);
	});

	it("renders a non-finite duration as an em dash, not 'NaNm NaNs'", () => {
		// DIRECT render: the only in-repo caller already filters non-finite values,
		// so no job-detail fixture can reach this gate — removing it passed all 57
		// tests (stack review M1). The gate is defence-in-depth for the EXPORTED
		// component's other callers, and this test is what makes it real: it fails
		// with the Number.isFinite check deleted (mutation-verified).
		renderL(
			<OverviewStrip
				region="us-east-1"
				labels={[]}
				createdAt="2026-08-12T00:00:00.000Z"
				durationSeconds={Number.NaN}
				bitmovinEncodingId={null}
			/>,
		);
		expect(screen.queryByText(/NaN/)).toBeNull();
	});

	it("renders a corrupted createdAt as an em dash, not 'Invalid Date'", async () => {
		// `row.createdAt` flows into the strip unguarded by the caller, and the strip
		// used a bare `new Date(...).toLocaleString` — the same truthy-Invalid-Date
		// class the live-encodings list hit. Now it goes through `formatDateTime`.
		mockApi({ row: planRow({ createdAt: "not-a-timestamp" }) });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Renditions");
		// The strip itself mounted (its region fact is visible) — so the negative
		// assertion below cannot pass vacuously on an unrendered strip.
		expect(screen.getByText("us-east-1")).toBeInTheDocument();
		expect(screen.queryByText(/Invalid Date/)).toBeNull();
	});

	it("capture success re-renders the results through the query, not a reload", async () => {
		// The FULL happy path, untestable while the button did
		// `window.location.reload` : POST → invalidate → the SAME
		// query refetches → the table renders through the same selector the
		// step-log path uses. The row grows its snapshot between the two fetches,
		// exactly as the backfill route behaves.
		const captured = {
			capturedAt: "2026-08-11T00:00:00.000Z",
			streams: [
				{
					streamId: "s-1",
					mode: "PER_TITLE_RESULT",
					templateRendition: "v-pt",
					params: {},
					appliedSettings: { width: 1920, height: 1080 },
					muxings: [],
				},
			],
			scan: {
				streamsListed: 1,
				templatesListed: 1,
				resultsCaptured: 1,
				muxingsListed: 0,
				complete: true,
				codecConfigErrors: 0,
				unattributed: 0,
			},
		};
		let jobReads = 0;
		mockApi({});
		apiFetch.mockImplementation(async (input: string) => {
			if (input.startsWith(`/api/encoding-jobs/${JOB_ID}`)) {
				jobReads += 1;
				// First read: finished, nothing captured. After the POST invalidates:
				// the same row with the backfilled snapshot column.
				// Through jobRow: perTitleRow only carries the plan, and the panel
				// gate needs the row's status/stepLog defaults too.
				return jobRow(
					perTitleRow(
						jobReads === 1
							? { status: "FINISHED" }
							: {
									status: "FINISHED",
									snapshots: { perTitleResults: captured },
								},
					),
				);
			}
			if (input.startsWith("/api/vmaf-jobs")) {
				// The route's real shape — a bare [] crashes the component (measured:
				// the whole JobDetail unmounted and this test's button never existed).
				return { items: [] };
			}
			return {};
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200 }),
		);
		wrap(<JobDetail id={JOB_ID} />);
		await userEvent.click(
			await screen.findByRole("button", { name: /capture now/i }),
		);
		// The table appears WITHOUT any navigation: jsdom has no reload, so this
		// passing at all is the proof the success path no longer needs one.
		expect(await screen.findByText("1920×1080")).toBeInTheDocument();
		expect(jobReads).toBeGreaterThanOrEqual(2);
	});

	it("preserves templated paths without a noninteractive playable badge", async () => {
		mockApi({
			row: planRow({
				plan: {
					...PLAN,
					// A matching playback URL must not add a noninteractive badge.
					manifests: [
						{
							key: "hls",
							kind: "HLS",
							destination: { outputKey: "out", path: "out" },
						},
					],
					muxings: (PLAN.muxings as Array<Record<string, unknown>>).map(
						(muxing) =>
							muxing.key === "m1080"
								? {
										...muxing,
										destination: {
											outputKey: "out",
											path: "out/{height}/{bitrate}/{uuid}",
										},
									}
								: muxing,
					),
				},
				playbackLinks: [
					{
						key: "hls",
						kind: "HLS",
						label: "HLS manifest",
						url: "https://example.invalid/out/stream.m3u8",
						path: "out/stream.m3u8",
						via: "derived",
					},
				],
			}),
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Storage I/O");
		expect(screen.getByText("templated")).toBeInTheDocument();
		expect(screen.queryByText("playable")).not.toBeInTheDocument();
	});

	it("shows the encoder-startup figure from the burned Bitmovin stamps (ledger #166)", async () => {
		// The run-timeline rule hides the queue wait from the chart; this
		// fact is where VOD keeps it readable as a number: 9m 32s = 572s of
		// queuedAt→runningAt.
		mockApi({
			row: planRow({
				encodingTimes: {
					queuedAt: "2026-08-24T00:00:00.000Z",
					runningAt: "2026-08-24T00:09:32.000Z",
				},
			}),
		});
		wrap(<JobDetail id={JOB_ID} />);
		expect(await screen.findByText("Encoder startup")).toBeInTheDocument();
		expect(screen.getByText("9m 32s")).toBeInTheDocument();
	});

	it("renders a MULTI-HOP chain in data-flow order, not plan order", async () => {
		// The whole point of the `ChainSegment[]` reversal — and it was untestable
		// against the base fixture, whose chains are single-segment, where reverse is
		// a no-op. Deleting `.reverse` left the entire suite green (review finding).
		// A trimming stream gives two hops: ingest → trim → rendition.
		mockApi({
			row: planRow({
				plan: {
					...PLAN,
					trimmingStreams: [
						{
							key: "trim",
							kind: "TIME_BASED",
							sourceKey: "src",
							offset: 10,
							duration: 30,
						},
					],
					renditions: (PLAN.renditions as Array<Record<string, unknown>>).map(
						(rendition) =>
							rendition.key === "v1080"
								? { ...rendition, ingestKey: "trim" }
								: rendition,
					),
				},
			}),
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Input files");
		// Source first, consumer last. Plan order is the reverse of this, so an
		// unreversed render reads "clip → ingest", i.e. backwards. ("clip" is
		// jobDetail.chainTrim's wording — 's input-clipping
		// vocabulary.)
		expect(
			screen.getByText(/ingest AUTO pos 0 → clip TIME_BASED/),
		).toBeInTheDocument();
	});

	it("names the source file and which renditions consume it", async () => {
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		expect(await screen.findByText("Input files")).toBeInTheDocument();
		expect(screen.getByText("src-bucket/mezzanine.mov")).toBeInTheDocument();
		// The consumer chain, in DATA-FLOW order: from the file (this card's
		// subject) into the renditions it feeds, one glyph meaning "feeds".
		expect(screen.getByText(/ingest AUTO pos 0/)).toBeInTheDocument();
		expect(screen.getByText(/→ v1080, v540, a1/)).toBeInTheDocument();
	});

	it("shows credential labels, and says so when one was deleted", async () => {
		mockApi({
			row: planRow({
				credentialRefs: {
					"00000000-0000-4000-8000-0000000000c1": {
						label: "source-account",
						provider: "AWS_S3",
					},
					// The output credential is deliberately absent — deleted after the
					// job ran (FK SetNull), which must read as such rather than blank.
				},
			}),
		});
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Storage I/O");
		// Twice, deliberately: the input-files panel labels the credential per FILE
		// and the storage panel per ENDPOINT. They answer different questions and an
		// operator reading either one alone should not have to cross-reference.
		expect(screen.getAllByText("source-account (AWS_S3)")).toHaveLength(2);
		expect(screen.getAllByText("deleted credential").length).toBeGreaterThan(0);
	});

	it("lists every write path with its ACL", async () => {
		mockApi({ row: planRow() });
		wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText("Storage I/O");
		expect(screen.getByText("Read from")).toBeInTheDocument();
		expect(screen.getByText("Written to")).toBeInTheDocument();
		expect(screen.getByText("out/1080p")).toBeInTheDocument();
		expect(screen.getByText("PUBLIC_READ")).toBeInTheDocument();
	});

	it("renders the header and manifests when the plan does not parse", async () => {
		// A legacy or hand-edited row must not blank the page: the panels are the
		// part that needs a valid plan, and everything else still has data.
		mockApi({ row: { plan: { not: "a plan" } } });
		wrap(<JobDetail id={JOB_ID} />);
		expect(await screen.findByText("Sample job")).toBeInTheDocument();
		expect(screen.queryByText("Renditions")).toBeNull();
	});
});

describe("JobDetail — bypassing the rail", () => {
	const AWS_URL =
		"https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/stream.m3u8";

	it("offers a skip link into the detail column", async () => {
		/**
		 * The rail is first in the document so mobile gets the player first, which
		 * means desktop keyboard and screen-reader users would otherwise traverse the
		 * player and the whole manifest list before the job's content.
		 *
		 * `lg:order-last` was suggested and does not fix this: CSS `order` reorders
		 * the visual box, never the accessibility tree. A skip link is the mechanism
		 * for "bypass this block", and it needs a real target — asserting the href
		 * alone would pass on a link pointing at nothing.
		 */
		mockApi({
			row: {
				playbackLinks: [
					{
						key: "hls",
						kind: "HLS",
						label: "HLS manifest",
						url: AWS_URL,
						path: "output/stream.m3u8",
						via: "derived",
					},
				],
			},
		});
		const { container } = wrap(<JobDetail id={JOB_ID} />);
		await screen.findByText(AWS_URL);
		const skip = screen.getByRole("link", { name: "Skip to job detail" });
		expect(skip).toHaveAttribute("href", "#job-detail-content");
		// The target must exist, and must be the detail column rather than the rail.
		const target = container.querySelector("#job-detail-content");
		expect(target).not.toBeNull();
		expect(target?.querySelector("aside")).toBeNull();
	});
});

describe("JobDetail — the QC/VMAF flag (ledger #131)", () => {
	it.each([
		"FINISHED",
		"QC_FAILED",
	])("refreshes AWAITING_QC through %s without a reload", async (terminal) => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let status = "AWAITING_QC";
		mockApi({});
		const defaultFetch = apiFetch.getMockImplementation();
		apiFetch.mockImplementation((url: string, init?: RequestInit) =>
			url === `/api/encoding-jobs/${JOB_ID}`
				? Promise.resolve(jobRow({ status }))
				: defaultFetch?.(url, init),
		);
		const view = wrap(<JobDetail id={JOB_ID} />);
		try {
			await screen.findByText("AWAITING_QC");
			status = terminal;
			await act(() => vi.advanceTimersByTimeAsync(5_100));
			expect(screen.getByText(terminal)).toBeInTheDocument();
			expect(screen.queryByText("AWAITING_QC")).toBeNull();
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});

	it("shows the newly requested VMAF report immediately after acceptance", async () => {
		let created = false;
		mockApi({});
		const defaultFetch = apiFetch.getMockImplementation();
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url.startsWith("/api/vmaf-jobs")) {
				if (init?.method === "POST") {
					created = true;
					return Promise.resolve({ id: "measurement-new" });
				}
				return Promise.resolve({
					items: created
						? [
								{
									id: "measurement-new",
									model: "new-model",
									mode: "VOD",
									status: "PENDING",
								},
							]
						: [],
				});
			}
			return defaultFetch?.(url, init);
		});
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "Measure VMAF again" }),
		);
		expect(
			await screen.findByRole("link", { name: "new-model · VOD" }),
		).toHaveAttribute("href", "/qc/measurement-new");
	});

	it("refreshes an active VMAF report and stops polling after it finishes", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let status = "PENDING";
		let reads = 0;
		mockApi({});
		const defaultFetch = apiFetch.getMockImplementation();
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url.startsWith("/api/vmaf-jobs")) {
				reads++;
				return Promise.resolve({
					items: [
						{
							id: "measurement-active",
							model: "active-model",
							mode: "VOD",
							status,
						},
					],
				});
			}
			return defaultFetch?.(url, init);
		});
		const view = wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		try {
			const report = await screen.findByRole("link", {
				name: "active-model · VOD",
			});
			const row = report.closest("li") as HTMLElement;
			expect(within(row).getByText("PENDING")).toBeInTheDocument();
			status = "FINISHED";
			await act(() => vi.advanceTimersByTimeAsync(5_100));
			expect(within(row).getByText("FINISHED")).toBeInTheDocument();
			const finishedReads = reads;
			await act(() => vi.advanceTimersByTimeAsync(15_100));
			expect(reads).toBe(finishedReads);
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});
	/**
	 * The plan comes from the GOLDEN vmaf fixture — a hand-built one failed the
	 * schema parse, and `detail` (and therefore the panel) only exists when the
	 * plan parses, so a hand-built plan would have made this pin unfalsifiable
	 * rather than green.
	 */
	const GOLDEN_VMAF_PLAN = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../../packages/core/src/plan/__fixtures__/vmaf-only-h264.plan.json",
			),
			"utf8",
		),
	) as Record<string, unknown>;
	const GATED_PLAN_ROW = {
		status: "QC_FAILED",
		qcVerdict: { pass: false, ruleResults: [] },
		plan: {
			...GOLDEN_VMAF_PLAN,
			qc: {
				vmaf: true,
				model: "vmaf_v0.6.1",
				gate: {
					rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 90 }],
					onFail: "BLOCK_MANIFESTS",
				},
			},
		},
	};

	it.each([
		"older active report",
		"replacement terminal report",
	])("refreshes the persisted verdict when the %s completes with the newest status unchanged", async (scenario) => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let completed = false;
		let jobReads = 0;
		let reportReads = 0;
		mockApi({});
		const defaultFetch = apiFetch.getMockImplementation();
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url === `/api/encoding-jobs/${JOB_ID}`) {
				jobReads++;
				return Promise.resolve(
					jobRow({
						...GATED_PLAN_ROW,
						status: "FINISHED",
						qcVerdict: { pass: completed, ruleResults: [] },
						stepLog: [],
						plan: {
							...GATED_PLAN_ROW.plan,
							qc: {
								...GATED_PLAN_ROW.plan.qc,
								gate: { ...GATED_PLAN_ROW.plan.qc.gate, onFail: "MARK_ONLY" },
							},
						},
					}),
				);
			}
			if (url.startsWith("/api/vmaf-jobs")) {
				if (init?.method === "POST") {
					completed = true;
					return Promise.resolve({ id: "new-report" });
				}
				reportReads++;
				const reports =
					scenario === "older active report"
						? [
								{ id: "new-report", status: "FINISHED" },
								{
									id: "old-report",
									status: completed ? "FINISHED" : "RUNNING",
								},
							]
						: [
								{
									id: completed ? "new-report" : "old-report",
									status: "FINISHED",
								},
							];
				return Promise.resolve({
					items: reports.map((report) => ({
						...report,
						model: report.id,
						mode: "VOD",
					})),
				});
			}
			return defaultFetch?.(url, init);
		});
		const view = wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		try {
			await screen.findByText("Fail");
			await act(() => vi.advanceTimersByTimeAsync(100));
			if (scenario === "older active report") {
				completed = true;
				await act(() => vi.advanceTimersByTimeAsync(5_100));
			} else {
				await userEvent
					.setup({ advanceTimers: vi.advanceTimersByTime })
					.click(screen.getByRole("button", { name: "Measure VMAF again" }));
				await act(() => vi.advanceTimersByTimeAsync(100));
			}
			expect(screen.getByText("Pass")).toBeInTheDocument();
			expect(screen.queryByText("Fail")).toBeNull();
			const settledReads = [jobReads, reportReads];
			await act(() => vi.advanceTimersByTimeAsync(15_100));
			expect([jobReads, reportReads]).toEqual(settledReads);
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});

	it("OFF hides the lab surfaces but KEEPS the QC gate panel for a job that carries a gate — the recovery clause", async () => {
		mockApi({ row: GATED_PLAN_ROW });
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: false }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		await screen.findByText("Sample job");

		// The panel is the ONLY way to release a job parked under a
		// BLOCK_MANIFESTS gate; hiding it while the orchestrator still parks
		// jobs is the stranding trap this whole design exists to avoid.
		expect(await screen.findByText(/QC gate/i)).toBeInTheDocument();
		// …while the lab surfaces are gone.
		expect(
			screen.queryByRole("button", { name: /Measure VMAF/i }),
		).not.toBeInTheDocument();
		expect(
			apiFetch.mock.calls.some((c) =>
				String(c[0]).startsWith("/api/vmaf-jobs"),
			),
		).toBe(false);
	});

	it("OFF still renders the QC panel for a job parked at AWAITING_QC — the state the recovery clause is actually about (review-265 131-A5)", async () => {
		// The first cut of this pin used QC_FAILED, the one state where the
		// override already worked; the doc's prose is about AWAITING_QC, and
		// that is where the stranding lived.
		mockApi({ row: { ...GATED_PLAN_ROW, status: "AWAITING_QC" } });
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: false }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		await screen.findByText("Sample job");
		expect(await screen.findByText(/QC gate/i)).toBeInTheDocument();
	});

	it("ON shows the lab surfaces — the OFF case above is not passing for some other reason", async () => {
		mockApi({ row: { ...GATED_PLAN_ROW, status: "FINISHED" } });
		wrap(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<JobDetail id={JOB_ID} />
			</FeatureFlagsProvider>,
		);
		await screen.findByText("Sample job");
		expect(
			await screen.findByRole("button", { name: /Measure VMAF/i }),
		).toBeInTheDocument();
	});
});
