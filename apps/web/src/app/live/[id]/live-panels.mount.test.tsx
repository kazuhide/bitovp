import { liveChannelPlanSchema } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureVmafPanel } from "@/app/live/[id]/capture-vmaf-panel";
import { DvrPanel } from "@/app/live/[id]/dvr-panel";
import { NextActionPanel } from "@/app/live/[id]/next-action-panel";
import { StatusStrip } from "@/app/live/[id]/status-strip";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

/**
 * Battery batch 2d : the channel-detail panels (#103's layers)
 * that had never mounted. The status gates are the substance — a DVR reset
 * that fires on a STOPPED channel or a VMAF capture without a feeder is an
 * API call the product promises not to make.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace: vi.fn() }),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

/** The wizard's own default plan — a real one, not a hand-typed shape.
 * Filled in: exactly what a blank form cannot know (name, output
 * destination, ingest stream key); everything else is the default. */
const PLAN = liveChannelPlanSchema.parse(
	buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "mount-battery",
		redundantRtmp: {
			...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
			ingestPoints: [{ applicationName: "liveA", streamKey: "mountkey" }],
		},
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId: "11111111-1111-4111-8111-111111111111",
			bucket: "mount-bucket",
		},
		start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "mountkey" },
	}),
);

describe("DvrPanel (ledger #149 batch 2d)", () => {
	it.each([
		"ja",
		"en",
	] as const)("keeps timeshift visible but budget calculation on demand in %s", (locale) => {
		const plan = {
			...PLAN,
			liveManifests: PLAN.liveManifests.map((m) => ({ ...m, timeshift: 120 })),
		};
		renderWithQuery(
			<DvrPanel
				channelId="ch-1"
				status="STOPPED"
				plan={plan}
				stepEntries={[]}
			/>,
			locale,
		);
		expect(screen.queryByTestId("dvr-gauge-bar")).toBeNull();
		expect(screen.getAllByText(/timeshift 120s/).length).toBe(
			plan.liveManifests.length,
		);
		fireEvent.click(
			screen.getAllByRole("button", {
				name: /timeshift 120s/,
			})[0] as HTMLElement,
		);
		expect(screen.getByTestId("dvr-gauge-bar")).toBeVisible();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByTestId("dvr-gauge-bar")).toBeNull();
		expect(apiFetch).not.toHaveBeenCalled();
	});
	it("renders one gauge per live manifest from the real default plan", () => {
		renderWithQuery(
			<DvrPanel
				channelId="ch-1"
				status="RUNNING"
				plan={PLAN}
				stepEntries={[]}
			/>,
		);
		for (const manifest of PLAN.liveManifests) {
			expect(
				screen.getByText(new RegExp(`“${manifest.key}”`)),
			).toBeInTheDocument();
		}
		expect(PLAN.liveManifests.length).toBeGreaterThan(0);
	});

	it("timeshift reset is gated to RUNNING, and says so", () => {
		renderWithQuery(
			<DvrPanel
				channelId="ch-1"
				status="STOPPED"
				plan={PLAN}
				stepEntries={[]}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Reset timeshift" }),
		).toBeDisabled();
		expect(
			screen.getByText(/Timeshift can only be reset on a RUNNING channel/),
		).toBeInTheDocument();
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("RUNNING: posts reset-timeshift with only the fields the operator set", async () => {
		apiFetch.mockResolvedValue({});
		renderWithQuery(
			<DvrPanel
				channelId="ch-1"
				status="RUNNING"
				plan={PLAN}
				stepEntries={[
					{
						step: "manifest-hls",
						kind: "CREATE_MANIFEST_HLS",
						status: "DONE",
						resourceId: "man-1",
					} as never,
				]}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Residual period (s)"), {
			target: { value: "600" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "Reset timeshift" }));
		await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
		const [url, init] = apiFetch.mock.calls[0] as [string, { body: string }];
		expect(url).toBe("/api/live-channels/ch-1/actions");
		// offset stayed empty — it must be ABSENT, not 0: an explicit 0 offset
		// and "no offset" are different requests to Bitmovin.
		expect(JSON.parse(init.body)).toEqual({
			action: "reset-timeshift",
			residualPeriodInSeconds: 600,
			manifestIds: ["man-1"],
		});
	});
});

describe("NextActionPanel (ledger #149 batch 2d)", () => {
	it("names the action and stamps its code for the e2e hooks", () => {
		renderWithQuery(
			<NextActionPanel
				action={{ code: "START_ENCODER", tone: "act", section: "sec-actions" }}
			/>,
		);
		expect(screen.getByText("Start the channel")).toBeInTheDocument();
		expect(
			document.querySelector('[data-next-action="START_ENCODER"]'),
		).not.toBeNull();
	});
});

describe("StatusStrip (ledger #149 batch 2d)", () => {
	/**
	 *  added two TIME cells (next event, runtime). Every arm below is
	 * about a DIFFERENT cell, so they share one quiet default: nothing armed,
	 * no run up, no cap. `channel-hierarchy.test.tsx` owns the arms where the
	 * time cells themselves carry the assertion.
	 */
	const TIME_CELLS = {
		nextEvent: null,
		runStartedAt: null,
		runEndedAt: null,
		maxRunMinutes: null,
		programmeHref: "#layer-programme",
	} as const;

	it("an UNREAD alert list is amber-unknown, never a green zero — audit 4403130 IMPORTANT-2", () => {
		renderWithQuery(
			<StatusStrip
				openAlerts="unknown"
				playableCount={2}
				feederCount={1}
				{...TIME_CELLS}
				active
				nowMs={Date.parse("2026-08-21T12:00:00.000Z")}
			/>,
		);
		const cell = document.querySelector('[data-status-cell="alerts"]');
		// The old `?? 0` printed "0" in emerald — the strip's own header
		// demands an unknown read as unknown, and 0-in-green is the most
		// reassuring reading there is.
		expect(cell?.textContent).toBe("unknown");
		expect(cell?.textContent).not.toBe("0");
		expect(cell?.className).toContain("text-amber-400");
		expect(cell?.className).not.toContain("text-emerald-400");
	});

	it("a measured zero still reads zero, in the healthy colour", () => {
		// The counterfactual for the arm above: "unknown" must not swallow the
		// real answer.
		renderWithQuery(
			<StatusStrip
				openAlerts={0}
				playableCount={2}
				feederCount={1}
				{...TIME_CELLS}
				active
				nowMs={Date.parse("2026-08-21T12:00:00.000Z")}
			/>,
		);
		const cell = document.querySelector('[data-status-cell="alerts"]');
		expect(cell?.textContent).toBe("0");
		expect(cell?.className).toContain("text-emerald-400");
	});
});

describe("CaptureVmafPanel (ledger #149 batch 2d)", () => {
	it("outside RUNNING it only explains itself — no query-driven UI", () => {
		renderWithQuery(
			<CaptureVmafPanel channelId="ch-1" channelStatus="STOPPED" />,
		);
		expect(
			screen.getByText(
				"VMAF capture is available while the channel is RUNNING.",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Capture VMAF" })).toBeNull();
	});

	it("RUNNING without a feeder session: capture stays disabled with the warning", async () => {
		apiFetch.mockResolvedValue({ items: [] });
		renderWithQuery(
			<CaptureVmafPanel channelId="ch-1" channelStatus="RUNNING" />,
		);
		expect(
			await screen.findByRole("button", { name: "Capture VMAF" }),
		).toBeDisabled();
		expect(await screen.findByRole("alert")).toBeInTheDocument();
	});

	it("RUNNING with a pushing feeder: capture posts the window and routes to QC", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url.startsWith("/api/feeder-sessions")) {
				return { items: [{ id: "fs-1", status: "PUSHING" }] };
			}
			if (url.endsWith("/capture-vmaf")) {
				return { id: "qc-123" };
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		renderWithQuery(
			<CaptureVmafPanel channelId="ch-1" channelStatus="RUNNING" />,
		);
		const button = await screen.findByRole("button", { name: "Capture VMAF" });
		await waitFor(() => expect(button).toBeEnabled());
		fireEvent.click(button);
		await waitFor(() => expect(push).toHaveBeenCalledWith("/qc/qc-123"));
		const capturePost = apiFetch.mock.calls.find(([u]) =>
			String(u).endsWith("/capture-vmaf"),
		) as [string, { body: string }];
		expect(JSON.parse(capturePost[1].body)).toEqual({ windowSeconds: 120 });
	});

	it("a coded first-publish 409 renders natural Japanese and withholds raw route prose", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url.startsWith("/api/feeder-sessions")) {
				return { items: [{ id: "fs-1", status: "PUSHING" }] };
			}
			if (url.endsWith("/capture-vmaf")) {
				throw new ApiError(409, "VMAF capture raw English diagnostic", {
					code: "LIVE_VMAF_FIRST_SEGMENT_PENDING",
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		renderWithQuery(
			<CaptureVmafPanel channelId="ch-1" channelStatus="RUNNING" />,
			"ja",
		);
		const button = await screen.findByRole("button", {
			name: "VMAF をキャプチャ",
		});
		await waitFor(() => expect(button).toBeEnabled());
		fireEvent.click(button);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"対象すべての出力セグメントをまだ確認できません。入力・出力を確認し、少し待って再実行してください。",
		);
		expect(alert).not.toHaveTextContent(/raw English|VMAF capture raw/);
		// And the operator stays put: a push here would carry them to a /qc
		// report for a job that was never created.
		expect(push).not.toHaveBeenCalled();
	});
});
