import { computePooled, type VmafFrame } from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";
import type { VmafJobDetail } from "../vmaf-shared";

// Data layer — the compare client fans out one apiFetch per job id.
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

// The compare client reads the job ids from ?jobs=… via useSearchParams.
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
	useSearchParams: () => searchParams,
}));

// Fixed-size ResponsiveContainer so the overlay charts mount under jsdom
// (jsdom reports 0×0) — same workaround as the other qc chart tests.
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: ReactNode }) =>
			isValidElement(children)
				? cloneElement(
						children as ReactElement<{ width?: number; height?: number }>,
						{ width: 800, height: 320 },
					)
				: children,
	};
});

import { CompareClient } from "./compare-client";
import { CompareLadderChart } from "./compare-ladder-chart";

function frames(scores: number[]): VmafFrame[] {
	return scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
}

/** A finished VMAF job with one rendition result over the given scores. */
function job(
	id: string,
	opts: {
		label: string;
		height: number;
		bitrate: number;
		scores: number[];
		resultId?: string;
		encodingName?: string | null;
	},
): VmafJobDetail {
	const f = frames(opts.scores);
	const pooled = computePooled(f);
	return {
		id,
		encodingJobId: opts.encodingName === null ? null : `enc-${id}`,
		encodingName: opts.encodingName === undefined ? null : opts.encodingName,
		mode: "VOD",
		model: "vmaf_v0.6.1",
		// Current generation by default; the mixed-generation cases override it.
		scoringVersion: 2,
		// Full precision by default (VMAF_SUBSAMPLE is unset in every real run so
		// far); the mixed-subsampling cases override it.
		subsample: null,
		status: "FINISHED",
		error: null,
		totalUnits: 1,
		doneUnits: 1,
		cores: 8,
		threads: 8,
		concurrency: 1,
		createdAt: "2026-06-20T00:00:00.000Z",
		updatedAt: "2026-06-20T00:00:00.000Z",
		reference: { width: 1920, height: 1080, fps: 24 },
		results: [
			{
				id: opts.resultId ?? `${id}-r1`,
				renditionRef: {
					label: opts.label,
					height: opts.height,
					bitrate: opts.bitrate,
				},
				pooled,
				frames: f,
				frameCount: f.length,
			},
		],
	};
}

const JOB_A = job("aaaaaaaa-0000-4000-8000-000000000001", {
	label: "360p",
	height: 360,
	bitrate: 800_000,
	scores: [88, 84, 60, 86, 89],
	encodingName: "clip-low",
});
const JOB_B = job("bbbbbbbb-0000-4000-8000-000000000002", {
	label: "1080p",
	height: 1080,
	bitrate: 4_500_000,
	scores: [97, 96, 80, 98, 97],
	encodingName: "clip-high",
});

/** Resolve apiFetch from a map of id → job (reject on a missing id = 404). */
function serve(jobs: VmafJobDetail[]) {
	const byUrl = new Map(jobs.map((j) => [`/api/vmaf-jobs/${j.id}`, j]));
	apiFetch.mockImplementation(async (url: string) => {
		const hit = byUrl.get(url);
		if (!hit) {
			throw new Error(`not found: ${url}`);
		}
		return hit;
	});
}

afterEach(() => {
	vi.clearAllMocks();
	searchParams = new URLSearchParams();
});

describe("CompareClient", () => {
	it("overlays one line per (job × rendition) series for the fetched jobs", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([JOB_A, JOB_B]);
		const { container } = wrap(<CompareClient />);

		// Wait for the loaded view (the series legend appears only post-fetch).
		expect(
			await screen.findByRole("checkbox", {
				name: new RegExp(`Toggle series ${JOB_A.encodingName}`),
			}),
		).toBeInTheDocument();
		// Both jobs land → header reports 2 reports · 2 series.
		expect(screen.getByTestId("compare-counts")).toHaveTextContent(
			"2 reports · 2 series",
		);
		// Legend lists both series with a toggle each.
		expect(
			screen.getByRole("checkbox", {
				name: new RegExp(`Toggle series ${JOB_B.encodingName}`),
			}),
		).toBeInTheDocument();

		// Per-frame overlay draws one VMAF line per series (2). The ladder adds
		// one curve per job (2 more) — assert at least the two frame lines exist.
		await waitFor(() => {
			const lines = container.querySelectorAll(".recharts-line-curve");
			expect(lines.length).toBeGreaterThanOrEqual(2);
		});
	});

	it("hides a series' line when its legend checkbox is unticked", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([JOB_A, JOB_B]);
		const { container } = wrap(<CompareClient />);

		// Wait for the loaded view, then snapshot the drawn line count.
		await waitFor(() =>
			expect(screen.getByTestId("compare-counts")).toHaveTextContent(
				"2 reports · 2 series",
			),
		);
		const countLines = () =>
			container.querySelectorAll(".recharts-line-curve").length;
		const before = countLines();

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("checkbox", {
				name: new RegExp(`Toggle series ${JOB_A.encodingName}`),
			}),
		);

		// Removing a series drops its frame line (and its ladder curve) → fewer
		// drawn paths than before.
		await waitFor(() => expect(countLines()).toBeLessThan(before));
		// The "shown" counter in the per-frame heading reflects 1 of 2.
		expect(screen.getByText(/1 of 2 series/)).toBeInTheDocument();
	});

	it("shows the guard when fewer than two ids are supplied", async () => {
		searchParams = new URLSearchParams({ jobs: JOB_A.id });
		serve([JOB_A]);
		wrap(<CompareClient />);

		expect(
			await screen.findByText(/Pick at least two finished VMAF reports/i),
		).toBeInTheDocument();
		// Guard links back to the lab; no fetch is attempted for a single id.
		expect(screen.getByRole("link", { name: "VMAF Lab" })).toHaveAttribute(
			"href",
			"/qc",
		);
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("dedupes repeated ids — two distinct ids required after dedupe", async () => {
		// Same id twice collapses to one → still fails the 2-id guard.
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_A.id}` });
		serve([JOB_A]);
		wrap(<CompareClient />);
		expect(
			await screen.findByText(/Pick at least two finished VMAF reports/i),
		).toBeInTheDocument();
	});

	it("skips a 404 job and notes it while still rendering the rest", async () => {
		const missing = "cccccccc-0000-4000-8000-000000000003";
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${missing}` });
		serve([JOB_A]); // only A resolves; the missing id rejects (404)
		wrap(<CompareClient />);

		// The skipped id is disclosed (alert appears only after the fetch settles).
		expect(await screen.findByText(/Skipped 1 report/)).toBeInTheDocument();
		// The surviving job still renders (1 report · 1 series in the header) and
		// its series toggle is present.
		expect(screen.getByTestId("compare-counts")).toHaveTextContent(
			"1 report · 1 series",
		);
		expect(
			screen.getByRole("checkbox", {
				name: new RegExp(`Toggle series ${JOB_A.encodingName}`),
			}),
		).toBeInTheDocument();
		expect(screen.getAllByText(missing.slice(0, 8)).length).toBeGreaterThan(0);
	});

	it("notes a job that loaded with zero results", async () => {
		const empty: VmafJobDetail = { ...JOB_B, results: [] };
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${empty.id}` });
		serve([JOB_A, empty]);
		wrap(<CompareClient />);

		// Both jobs load (2 reports), but only A contributes a series. The
		// "no renditions" note appears only after both fetches settle.
		expect(
			await screen.findByText(/contributed no renditions/i),
		).toBeInTheDocument();
		expect(screen.getByTestId("compare-counts")).toHaveTextContent(
			"2 reports · 1 series",
		);
	});

	it("disambiguates two distinct jobs that share an encoding name (re-runs) with the short id", async () => {
		// Same encoding name, different ids + renditions — comparing re-runs of the
		// SAME encode. The legend must stay unambiguous, so each series label is
		// suffixed with the job's short id; a unique-named job stays clean.
		const rerunA = job("dddddddd-0000-4000-8000-000000000004", {
			label: "360p",
			height: 360,
			bitrate: 800_000,
			scores: [80, 81, 70, 82, 83],
			encodingName: "same-encode",
		});
		const rerunB = job("eeeeeeee-0000-4000-8000-000000000005", {
			label: "1080p",
			height: 1080,
			bitrate: 4_500_000,
			scores: [95, 96, 90, 97, 95],
			encodingName: "same-encode",
		});
		searchParams = new URLSearchParams({ jobs: `${rerunA.id},${rerunB.id}` });
		serve([rerunA, rerunB]);
		wrap(<CompareClient />);

		// Both series carry the encoding name AND a disambiguator (the short id),
		// so the two re-runs are tellable apart in the legend.
		expect(
			await screen.findByRole("checkbox", {
				name: new RegExp(
					`Toggle series same-encode · ${rerunA.id.slice(0, 8)}`,
				),
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", {
				name: new RegExp(
					`Toggle series same-encode · ${rerunB.id.slice(0, 8)}`,
				),
			}),
		).toBeInTheDocument();
	});
});

describe("CompareClient — mixed scoring generations", () => {
	/**
	 * The 2026-08-11 PTS fix changed what a VMAF number MEANS: the same encode
	 * measured 23.08 before and 84.21 after. Overlaying the two generations draws
	 * a pipeline difference that looks exactly like a quality difference, and it
	 * swamps every real one on the same axes — so the screen has to say so.
	 */
	it("warns when the loaded reports span generations", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, scoringVersion: 1 },
			{ ...JOB_B, scoringVersion: 2 },
		]);
		wrap(<CompareClient />);
		const alert = await screen.findByText(/not comparable/);
		expect(alert).toBeInTheDocument();
		// Names the generations, so the operator knows which reports to re-run.
		expect(alert.textContent).toContain("1, 2");
	});

	it("treats a report with no version as generation 1", async () => {
		// A row written before the column existed was scored by the old pipeline by
		// definition; defaulting it to the current generation would silently mark
		// every historical number as trustworthy.
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		// The wire type is required (a route dropping the field must be a compile
		// error), so the absent case is constructed deliberately — it still occurs
		// at runtime from a payload cached before the field existed.
		const { scoringVersion: _omitted, ...jobAWithout } = JOB_A;
		serve([jobAWithout as typeof JOB_A, { ...JOB_B, scoringVersion: 2 }]);
		wrap(<CompareClient />);
		expect(await screen.findByText(/not comparable/)).toBeInTheDocument();
	});

	it("stays quiet for a uniform set", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, scoringVersion: 2 },
			{ ...JOB_B, scoringVersion: 2 },
		]);
		wrap(<CompareClient />);
		// Wait for the charts, then assert the absence — otherwise this passes
		// merely because nothing has rendered yet.
		await screen.findByText("clip-low · 360p");
		expect(screen.queryByText(/not comparable/)).toBeNull();
	});
});

/**
 * The same guard for the MODEL, which was missing until it was measured.
 *
 * Scoring one identical pair with every bundled model put the same bytes at 83.01
 * on `vmaf_v1.0.16_3d0h` and 92.44 on `vmaf_v1.0.16_3d0h_2160` — 9.6 points from
 * the viewing condition alone, larger than most encode differences this screen
 * exists to show. The chart drew that silently, and did not display the model
 * anywhere, so an operator had no way to notice.
 */
describe("compare — mixed VMAF models", () => {
	it("warns when the loaded reports were scored with different models", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, model: "vmaf_v1.0.16_3d0h" },
			{ ...JOB_B, model: "vmaf_v1.0.16_3d0h_2160" },
		]);
		wrap(<CompareClient />);
		const alert = await screen.findByText(/viewing conditions/);
		// Names both models: the operator has to know which report to re-score.
		expect(alert.textContent).toContain("vmaf_v1.0.16_3d0h,");
		expect(alert.textContent).toContain("vmaf_v1.0.16_3d0h_2160");
	});

	it("is a separate warning from the generation one, and both can show at once", async () => {
		// Two independent reasons the numbers are not comparable. Collapsing them
		// into one message would let a mixed-model set hide behind a re-run
		// instruction that does not fix it.
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, model: "vmaf_v0.6.1", scoringVersion: 1 },
			{ ...JOB_B, model: "vmaf_v0.6.1neg", scoringVersion: 2 },
		]);
		wrap(<CompareClient />);
		expect(await screen.findByText(/not comparable/)).toBeInTheDocument();
		expect(screen.getByText(/viewing conditions/)).toBeInTheDocument();
	});

	it("stays quiet when every report shares a model", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, model: "vmaf_v1.0.16_3d0h" },
			{ ...JOB_B, model: "vmaf_v1.0.16_3d0h" },
		]);
		wrap(<CompareClient />);
		// Charts first, so the absence is an absence rather than an unrendered page.
		await screen.findByText("clip-low · 360p");
		expect(screen.queryByText(/viewing conditions/)).toBeNull();
	});
});

/**
 * The third "not comparable" axis. It gets the same treatment as the other two
 * because the failure is the same shape — a chart that reads as a quality
 * difference — but it is the easiest to miss: the pooled means stay close and only
 * the minima diverge.
 */
describe("compare — mixed frame subsampling", () => {
	it("warns when a subsampled report is charted against a full-precision one", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, subsample: 4 },
			{ ...JOB_B, subsample: null },
		]);
		wrap(<CompareClient />);
		const alert = await screen.findByText(/minima are not comparable/);
		// Names both strides, and full precision must appear as 1 rather than as
		// nothing — "n_subsample 4" alone would not tell the operator what it is
		// being compared against.
		expect(alert.textContent).toContain("1, 4");
	});

	it("stays quiet when both reports are full precision, however that is spelled", async () => {
		// null on one side and absent on the other is the same answer, and it is what
		// every report written before the worker recorded the stride looks like.
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		const { subsample: _absent, ...jobBWithout } = JOB_B;
		serve([{ ...JOB_A, subsample: null }, jobBWithout as typeof JOB_B]);
		wrap(<CompareClient />);
		await screen.findByText("clip-low · 360p");
		expect(screen.queryByText(/minima are not comparable/)).toBeNull();
	});

	it("shows all three warnings at once when all three axes differ", async () => {
		// Three independent reasons, three messages. A single collapsed "not
		// comparable" would let the operator fix one and believe the chart.
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, scoringVersion: 1, model: "vmaf_v0.6.1", subsample: 4 },
			{
				...JOB_B,
				scoringVersion: 2,
				model: "vmaf_v1.0.16_3d0h",
				subsample: null,
			},
		]);
		wrap(<CompareClient />);
		expect(await screen.findByText(/not comparable —/)).toBeInTheDocument();
		expect(screen.getByText(/viewing conditions/)).toBeInTheDocument();
		expect(screen.getByText(/minima are not comparable/)).toBeInTheDocument();
	});
});

/**
 * The warning names the model set; this attributes a model to each report.
 *
 * Without it the legend read `bbb-pte-crf-17` for every series — `encodingName` is
 * always present for a VOD job, so `jobShortLabel`'s short-circuit hid the model
 * entirely, and an operator told "compare reports that share a model" could not see
 * which was which across up to six series (review finding).
 */
describe("compare — attributing a model to each report", () => {
	it("puts the model in every series label when the set is mixed", async () => {
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([
			{ ...JOB_A, model: "vmaf_v0.6.1" },
			{ ...JOB_B, model: "vmaf_v1.0.16_3d0h" },
		]);
		wrap(<CompareClient />);
		// Both models reachable from the series list, not only from the warning.
		// JOB_A is the "clip-low" fixture and JOB_B the "clip-high" one.
		expect(
			await screen.findByText(/clip-low · vmaf_v0\.6\.1 ·/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/clip-high · vmaf_v1\.0\.16_3d0h ·/),
		).toBeInTheDocument();
	});

	it("leaves labels short when every report shares a model", async () => {
		// The uniform case is the common one and must not grow noise.
		searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
		serve([JOB_A, JOB_B]);
		wrap(<CompareClient />);
		await screen.findByText("clip-low · 360p");
		expect(screen.queryByText(/vmaf_v0\.6\.1 ·/)).toBeNull();
	});
});

describe("ladder chart — the omitted renditions are NAMED (ux inventory #11)", () => {
	it("opens the dropped list on click, each name once — not doubled", async () => {
		// The dropped label is `s.label`, which compare-client ALREADY builds as
		// "jobLabel · rendition" — a first draft prefixed jobLabel again and
		// rendered "Job A — Job A · audio" (review of PR #169, I1). This
		// assertion is on the RENDERED string, which is what catches it.
		const series = [
			{
				key: "a:v1080",
				jobId: "job-a",
				jobIndex: 0,
				jobLabel: "Job A",
				label: "Job A · 1080p",
				color: "#fff",
				mean: 90,
				result: {
					renditionRef: { bitrate: 4_000_000 },
					pooled: { mean: 90 },
				} as never,
			},
			{
				key: "a:audio",
				jobId: "job-a",
				jobIndex: 0,
				jobLabel: "Job A",
				label: "Job A · audio",
				color: "#eee",
				mean: 80,
				// No bitrate, no height — dropped from the ladder.
				result: { renditionRef: {} } as never,
			},
		];
		wrap(<CompareLadderChart series={series} />);
		await userEvent.click(
			screen.getByRole("button", { name: /omitted from the ladder/i }),
		);
		const item = await screen.findByText("Job A · audio");
		expect(item).toBeTruthy();
		expect(screen.queryByText(/Job A — Job A/)).toBeNull();
	});
});
it("resets series selection when the URL changes to a different comparison", async () => {
	const third = { ...JOB_B, id: "cccccccc-0000-4000-8000-000000000003" };
	serve([JOB_A, JOB_B, third]);
	searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
	const { rerender } = wrap(<CompareClient />);
	await screen.findByRole("checkbox", { name: /clip-low/ });
	await userEvent.click(screen.getByRole("button", { name: "None" }));
	expect(
		screen
			.getAllByRole("checkbox")
			.every((box) => !(box as HTMLInputElement).checked),
	).toBe(true);
	searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${third.id}` });
	rerender(<CompareClient />);
	await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));
	await waitFor(() =>
		expect(
			screen
				.getAllByRole("checkbox")
				.every((box) => (box as HTMLInputElement).checked),
		).toBe(true),
	);
});
it("lets an operator retry failed comparison reads without discarding loaded reports", async () => {
	searchParams = new URLSearchParams({ jobs: `${JOB_A.id},${JOB_B.id}` });
	serve([JOB_A]);
	wrap(<CompareClient />);
	await screen.findByText(/Skipped 1 report/);
	serve([JOB_A, JOB_B]);
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));
});
