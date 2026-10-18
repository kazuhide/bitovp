import { computePooled, type VmafFrame } from "@bitovp/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

// Mock the data layer so the views render against fixed payloads.
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

// The report's delete redirects via router.push; mock the app router so the
// component mounts under jsdom and the push is observable.
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush }),
}));

// Fixed-size ResponsiveContainer so the report's charts mount under jsdom
// (jsdom reports 0×0; clone the chart child with explicit dimensions like the
// real container does — see vmaf-charts.test.tsx).
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: ReactNode }) =>
			isValidElement(children)
				? cloneElement(
						children as React.ReactElement<{
							width?: number;
							height?: number;
						}>,
						{ width: 800, height: 320 },
					)
				: children,
	};
});

import { VmafReport } from "./[id]/vmaf-report";
import { VmafLabClient } from "./vmaf-lab-client";
import type { VmafJobDetail, VmafJobListItem } from "./vmaf-shared";

function frames(scores: number[]): VmafFrame[] {
	return scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
}

function detail(over: Partial<VmafJobDetail> = {}): VmafJobDetail {
	const f = frames([90, 84, 62, 88, 91]);
	const pooled = computePooled(f);
	return {
		id: "00000000-0000-4000-8000-0000000000a4",
		encodingJobId: "00000000-0000-4000-8000-0000000000e2",
		encodingName: "bbb-pte-crf-17",
		mode: "VOD",
		model: "vmaf_v0.6.1",
		scoringVersion: 2,
		// Full precision — the default, and every real run so far.
		subsample: null,
		status: "FINISHED",
		error: null,
		totalUnits: 1,
		doneUnits: 1,
		cores: 8,
		threads: 8,
		concurrency: 1,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:00:00.000Z",
		reference: { width: 1920, height: 1080, fps: 24 },
		results: [
			{
				id: "r1",
				renditionRef: { label: "360p", height: 360, bitrate: 800_000 },
				pooled,
				frames: f.map((x) =>
					x.frameNum === pooled.worstFrame.frameNum
						? { ...x, worst: true as const }
						: x,
				),
				frameCount: f.length,
			},
		],
		...over,
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("VmafReport", () => {
	it("confirms stopping only the selected cloud measurement", async () => {
		const job = detail({
			status: "RUNNING",
			execution: { backend: "CLOUD", profileId: "aws-test", budgetUsd: 12 },
		});
		apiFetch.mockImplementation(
			async (_url: string, options?: { method?: string }) =>
				options?.method === "POST"
					? { id: job.id, cancelRequested: true }
					: job,
		);
		wrap(<VmafReport id={job.id} />);
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("button", { name: "Stop cloud measurement" }),
		);
		expect(
			apiFetch.mock.calls.some(([, options]) => options?.method === "POST"),
		).toBe(false);
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByText(/charges may continue until cleanup completes/),
		).toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("button", { name: "Stop cloud measurement" }),
		);
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(`/api/vmaf-jobs/${job.id}/cancel`, {
				method: "POST",
			}),
		);
	});
	it.each([
		{
			status: "RUNNING" as const,
			mode: "VOD" as const,
			execution: { backend: "LOCAL" as const },
		},
		{
			status: "FINISHED" as const,
			mode: "VOD" as const,
			execution: {
				backend: "CLOUD" as const,
				profileId: "aws-test",
				budgetUsd: 12,
			},
		},
		{
			status: "RUNNING" as const,
			mode: "LIVE" as const,
			execution: {
				backend: "CLOUD" as const,
				profileId: "aws-test",
				budgetUsd: 12,
			},
		},
	])("does not offer cloud cancellation for unsupported or terminal jobs", async (job) => {
		apiFetch.mockResolvedValue(detail(job));
		wrap(<VmafReport id="job-1" />);
		await screen.findByText("bbb-pte-crf-17");
		expect(
			screen.queryByRole("button", { name: "Stop cloud measurement" }),
		).not.toBeInTheDocument();
	});

	it("shows cloud execution, reservation and pending cleanup without claiming completion", async () => {
		apiFetch.mockResolvedValue(
			detail({
				execution: { backend: "CLOUD", profileId: "aws-test", budgetUsd: 12 },
				computeTasks: [
					{
						id: "task-123456",
						profileId: "aws-test",
						state: "CLEANUP_PENDING",
						reservedUsd: 2,
						createdAt: "2026-09-24T00:00:00Z",
						cleanedAt: null,
						error: "Cloud task needs operator attention",
					},
				],
			}),
		);
		wrap(<VmafReport id="job-1" />);
		expect(
			await screen.findByText(/Cloud · aws-test · budget USD 12/),
		).toBeInTheDocument();
		await userEvent.click(screen.getByText("Cloud task status"));
		expect(screen.getByText(/Cleanup pending/)).toBeInTheDocument();
		expect(screen.getByText("Operator attention required")).toBeInTheDocument();
	});

	it.each([
		"en",
		"ja",
	] as const)("puts Live scores before collapsed diagnostics in %s", async (locale) => {
		const job = detail({ mode: "LIVE" });
		const result = job.results[0];
		if (!result) throw new Error("Expected fixture rendition");
		result.live = {
			offset: 42,
			confidence: 0.97,
			lowConfidence: false,
			fps: 30,
			sourceFrames: 300,
			distortedFrames: 360,
			coarseOffset: 40,
			drift: { detected: false, maxDriftFrames: 0, perSegmentOffsets: [42] },
			loopMap: [{ outputFrameStart: 0, sourceFrameStart: 42, loopIndex: 0 }],
		};
		apiFetch.mockResolvedValue(job);
		const { container } = wrap(<VmafReport id={job.id} />, locale);
		const score = await screen.findByRole("heading", {
			name: locale === "ja" ? "区間別 VMAF" : "Windowed VMAF",
		});
		expect(container.querySelector("h2")).toBe(score);
		const diagnostics = container.querySelector("details");
		expect(diagnostics).not.toBeNull();
		expect(diagnostics).not.toHaveAttribute("open");
		expect(diagnostics?.querySelector("summary")).toHaveTextContent(
			locale === "ja" ? "同期診断" : "Alignment diagnostics",
		);
		expect(screen.getByText("0.970")).not.toBeVisible();
		await userEvent.click(diagnostics?.querySelector("summary") as HTMLElement);
		expect(screen.getByText("0.970")).toBeVisible();
		expect(
			screen.getByText(
				locale === "ja" ? "ループオフセット表" : "Loop-offset map",
			),
		).toBeVisible();
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		"LIVE",
		"VOD",
	] as const)("does not offer empty diagnostics for %s without Live metadata", async (mode) => {
		const job = detail({ mode });
		apiFetch.mockResolvedValue(job);
		const { container } = wrap(<VmafReport id={job.id} />);
		await screen.findByText(
			mode === "LIVE" ? "Windowed VMAF" : "Pooled summary",
		);
		expect(container.querySelector("details")).toBeNull();
	});

	it.each([
		"lowConfidence",
		"pooledWithoutAlignment",
		"warning",
		"drift",
	] as const)("keeps %s caution outside the closed diagnostics", async (kind) => {
		const job = detail({ mode: "LIVE" });
		const result = job.results[0];
		if (!result) throw new Error("Expected fixture rendition");
		result.live = {
			offset: 42,
			confidence: 0.97,
			lowConfidence: kind === "lowConfidence",
			fps: 30,
			sourceFrames: 300,
			distortedFrames: 360,
			coarseOffset: 40,
			drift: {
				detected: kind === "drift",
				maxDriftFrames: 3,
				perSegmentOffsets: [42, 45],
			},
			loopMap: [],
			pooledWithoutAlignment: kind === "pooledWithoutAlignment",
			warning: kind === "warning" ? "Output period differs." : undefined,
		};
		apiFetch.mockResolvedValue(job);
		const { container } = wrap(<VmafReport id={job.id} />);
		await screen.findByText("Windowed VMAF");
		const caution = screen.getByText(
			kind === "warning"
				? "Output period differs."
				: kind === "drift"
					? /Drift detected/
					: /Alignment unverified/,
		);
		expect(caution).toBeVisible();
		expect(caution.closest("details")).toBeNull();
		expect(
			caution.compareDocumentPosition(
				container.querySelector("table") as Node,
			) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders pooled table, charts and export buttons for a finished report", async () => {
		apiFetch.mockResolvedValue(detail());
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);

		expect(await screen.findByText("Pooled summary")).toBeInTheDocument();
		expect(screen.getByText("Quality ladder")).toBeInTheDocument();
		// export buttons (anchors) target the export route in both formats.
		const json = screen.getByText("JSON").closest("a");
		const csv = screen.getByText("CSV").closest("a");
		expect(json?.getAttribute("href")).toMatch(/\/export\?format=json/);
		expect(csv?.getAttribute("href")).toMatch(/\/export\?format=csv/);
		// link back to the encoding job.
		expect(
			screen.getByText("00000000-0000-4000-8000-0000000000e2"),
		).toBeInTheDocument();
	});

	it("marks a pre-fix report as understated", async () => {
		/**
		 * An operator reading ONE report needs the generation as much as one
		 * comparing two: a generation-1 number came from the pipeline that scored
		 * frame N against frame N±1 (23.08 where the same encode now measures
		 * 84.21), and without this the report looks current.
		 */
		apiFetch.mockResolvedValue(detail({ scoringVersion: 1 }));
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(await screen.findByText(/scoring gen 1/)).toBeInTheDocument();
	});

	it("treats a report with no generation as pre-fix", async () => {
		/**
		 * The wire type is REQUIRED now (a route that drops the field must be a
		 * compile error — that omission shipped once). The runtime fallback still
		 * matters for a payload cached before the field existed, so the missing
		 * case is constructed deliberately rather than by leaving it out.
		 */
		const { scoringVersion: _omitted, ...withoutVersion } = detail();
		apiFetch.mockResolvedValue(withoutVersion);
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(await screen.findByText(/scoring gen 1/)).toBeInTheDocument();
	});

	it("says nothing for a current report", async () => {
		apiFetch.mockResolvedValue(detail({ scoringVersion: 3 }));
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		// Wait for the report to render, then assert the absence — otherwise this
		// passes merely because nothing has mounted yet.
		await screen.findByText("Pooled summary");
		expect(screen.queryByText(/scoring gen/)).toBeNull();
	});

	it("keeps a historical generation-2 report visible but marks its old timing", async () => {
		apiFetch.mockResolvedValue(detail({ scoringVersion: 2 }));
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(await screen.findByText(/scoring gen 2/)).toBeInTheDocument();
		expect(screen.getByText("Pooled summary")).toBeInTheDocument();
	});

	it("titles the report by its encoding name (heading)", async () => {
		apiFetch.mockResolvedValue(detail());
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		// the encoding name is the heading (h1), not the short id.
		expect(
			await screen.findByRole("heading", { level: 1, name: "bbb-pte-crf-17" }),
		).toBeInTheDocument();
	});

	it("falls back to the short id as the heading when the report has no encoding name (LIVE)", async () => {
		apiFetch.mockResolvedValue(
			detail({ encodingName: null, encodingJobId: null, mode: "LIVE" }),
		);
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(
			await screen.findByRole("heading", { level: 1, name: "00000000" }),
		).toBeInTheDocument();
	});

	it("shows a 'VMAF running…' state while PENDING with no results", async () => {
		apiFetch.mockResolvedValue(detail({ status: "RUNNING", results: [] }));
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(await screen.findByText(/VMAF running/i)).toBeInTheDocument();
		expect(screen.queryByText("Pooled summary")).not.toBeInTheDocument();
	});

	it("renders the progress %/bar and the resources line while RUNNING", async () => {
		apiFetch.mockResolvedValue(
			detail({
				status: "RUNNING",
				results: [],
				totalUnits: 4,
				doneUnits: 1,
				cores: 8,
				threads: 4,
				concurrency: 2,
			}),
		);
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		// 1/4 = 25%, rendered as "done/total (XX%)".
		expect(await screen.findByText(/1\/4 \(25%\)/)).toBeInTheDocument();
		// resources line composes cores · threads × concurrent.
		expect(
			screen.getByText(/8 cores · 4 libvmaf threads · 2 concurrent/i),
		).toBeInTheDocument();
	});

	it("shows an indeterminate 'starting…' state when totalUnits=0 (no NaN%)", async () => {
		apiFetch.mockResolvedValue(
			detail({
				status: "RUNNING",
				results: [],
				totalUnits: 0,
				doneUnits: 0,
				cores: null,
				threads: null,
				concurrency: null,
			}),
		);
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(await screen.findByText(/starting…/i)).toBeInTheDocument();
		// guard: never renders NaN%.
		expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
		// resources line omits gracefully when every field is null.
		expect(screen.queryByText(/Running on/i)).not.toBeInTheDocument();
	});

	it("shows a unit/resources summary on a FINISHED report", async () => {
		apiFetch.mockResolvedValue(
			detail({
				totalUnits: 3,
				doneUnits: 3,
				cores: 6,
				threads: 3,
				concurrency: 2,
			}),
		);
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(await screen.findByText(/Scored 3\/3 units/)).toBeInTheDocument();
		expect(
			screen.getByText(/6 cores · 3 libvmaf threads · 2 concurrent/i),
		).toBeInTheDocument();
	});

	it("surfaces job.error on an ERROR report", async () => {
		apiFetch.mockResolvedValue(
			detail({
				status: "ERROR",
				results: [],
				error: "libvmaf exited 1: missing reference",
			}),
		);
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(
			await screen.findByText(/libvmaf exited 1: missing reference/i),
		).toBeInTheDocument();
	});

	it("renders the failure line when the fetch errors", async () => {
		apiFetch.mockRejectedValue(new Error("boom"));
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		expect(
			await screen.findByText(/Failed to load the VMAF report/i),
		).toBeInTheDocument();
	});

	it("disables delete while the report is still RUNNING", async () => {
		apiFetch.mockResolvedValue(detail({ status: "RUNNING", results: [] }));
		wrap(<VmafReport id="00000000-0000-4000-8000-0000000000a4" />);
		await screen.findByText(/VMAF running/i);
		expect(
			screen.getByRole("button", { name: /Delete VMAF report \(disabled\)/ }),
		).toBeDisabled();
	});

	it("confirms then DELETEs a finished report and redirects to the lab", async () => {
		const id = "00000000-0000-4000-8000-0000000000a4";
		apiFetch.mockResolvedValue(detail());
		wrap(<VmafReport id={id} />);
		await screen.findByText("Pooled summary");

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Delete VMAF report" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/vmaf-jobs/${id}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/qc"));
	});
});

describe("VmafLabClient (index)", () => {
	function page(items: VmafJobListItem[]) {
		return { items, nextCursor: undefined };
	}

	for (const locale of ["ja", "en"] as const) {
		for (const status of ["PENDING", "RUNNING", "FINISHED", "ERROR"] as const) {
			it(`${locale}: ${status} without results is pending only while active`, async () => {
				apiFetch.mockResolvedValue(
					page([
						listItem({
							status,
							renditionMeans: [],
							error: status === "ERROR" ? "Scoring failed" : null,
						}),
					]),
				);
				wrap(<VmafLabClient />, locale);
				const row = (await screen.findByText(status)).closest("tr");
				expect(row).not.toBeNull();
				const scoreCell = within(row as HTMLTableRowElement).getAllByRole(
					"cell",
				)[5];
				const active = status === "PENDING" || status === "RUNNING";
				expect(scoreCell).toHaveTextContent(
					active ? (locale === "ja" ? "処理待ち" : "Pending") : "—",
				);
				if (!active)
					expect(scoreCell).not.toHaveTextContent(/処理待ち|Pending/);
				if (status === "ERROR")
					expect(
						within(row as HTMLTableRowElement).getByText("Scoring failed"),
					).toBeVisible();
			});
		}
		it(`${locale}: ERROR preserves partial numeric scores including zero and the error`, async () => {
			apiFetch.mockResolvedValue(
				page([
					listItem({
						status: "ERROR",
						error: "Second rendition failed",
						renditionMeans: [
							{ label: "360p", mean: 84.2 },
							{ label: "480p", mean: 0 },
						],
					}),
				]),
			);
			wrap(<VmafLabClient />, locale);
			const row = (await screen.findByText("ERROR")).closest(
				"tr",
			) as HTMLTableRowElement;
			expect(within(row).getByText("84.2")).toBeVisible();
			expect(within(row).getByText("0.0")).toBeVisible();
			expect(within(row).getByText("Second rendition failed")).toBeVisible();
			expect(within(row).queryByText(/処理待ち|Pending/)).toBeNull();
		});
	}

	it("lists reports with per-rendition mean VMAF and status", async () => {
		apiFetch.mockResolvedValue(
			page([
				{
					id: "00000000-0000-4000-8000-0000000000a5",
					encodingJobId: "00000000-0000-4000-8000-0000000000e3",
					encodingName: "bbb-pte-crf-17",
					mode: "VOD",
					model: "vmaf_v0.6.1",
					scoringVersion: 2,
					status: "FINISHED",
					error: null,
					createdAt: "2026-06-18T00:00:00.000Z",
					renditionMeans: [
						{ label: "360p", mean: 84.2 },
						{ label: "1080p", mean: 96.1 },
					],
				},
			]),
		);
		wrap(<VmafLabClient />);
		expect(await screen.findByText("84.2")).toBeInTheDocument();
		expect(screen.getByText("96.1")).toBeInTheDocument();
		expect(screen.getByText("FINISHED")).toBeInTheDocument();
		// the report link reads the encoding name, not the short id (the row also
		// links the encoding job by name, so match the /qc/ report link by href).
		const reportLink = screen
			.getAllByRole("link", { name: "bbb-pte-crf-17" })
			.find(
				(a) =>
					a.getAttribute("href") === "/qc/00000000-0000-4000-8000-0000000000a5",
			);
		expect(reportLink).toBeDefined();
	});

	it("shows the empty state when there are no reports", async () => {
		apiFetch.mockResolvedValue(page([]));
		wrap(<VmafLabClient />);
		await waitFor(() =>
			expect(screen.getByText(/No VMAF reports yet/i)).toBeInTheDocument(),
		);
	});

	function listItem(over: Partial<VmafJobListItem> = {}): VmafJobListItem {
		return {
			id: "00000000-0000-4000-8000-0000000000a5",
			encodingJobId: null,
			// default null so these rows label by short id (the compare/delete
			// aria-labels in the existing cases match the 8-char id fallback).
			encodingName: null,
			mode: "VOD",
			model: "vmaf_v0.6.1",
			scoringVersion: 2,
			status: "FINISHED",
			error: null,
			createdAt: "2026-06-18T00:00:00.000Z",
			renditionMeans: [{ label: "360p", mean: 84.2 }],
			...over,
		};
	}

	it("disables delete for an in-flight (RUNNING) report and enables it for a terminal one", async () => {
		apiFetch.mockResolvedValue(
			page([
				listItem({
					id: "11111111-1111-4111-8111-111111111111",
					renditionMeans: [{ label: "360p", mean: 84.2 }],
				}),
				listItem({
					id: "22222222-2222-4222-8222-222222222222",
					status: "RUNNING",
					renditionMeans: [],
				}),
			]),
		);
		wrap(<VmafLabClient />);
		await screen.findByText("84.2");
		// FINISHED report (id 11111111…) → enabled delete.
		expect(
			screen.getByRole("button", { name: "Delete report 11111111" }),
		).not.toBeDisabled();
		// RUNNING report (id 22222222…) → disabled delete.
		expect(
			screen.getByRole("button", {
				name: /Delete report 22222222 \(disabled\)/,
			}),
		).toBeDisabled();
	});

	it("selects terminal reports and navigates to the compare view", async () => {
		const a = "11111111-1111-4111-8111-111111111111";
		const b = "22222222-2222-4222-8222-222222222222";
		const running = "33333333-3333-4333-8333-333333333333";
		apiFetch.mockResolvedValue(
			page([
				listItem({ id: a }),
				listItem({ id: b }),
				listItem({ id: running, status: "RUNNING", renditionMeans: [] }),
			]),
		);
		wrap(<VmafLabClient />);
		await screen.findByRole("checkbox", { name: "Select report 11111111" });

		const user = userEvent.setup();
		// "Compare selected" is disabled until ≥2 finished reports are ticked.
		const compareBtn = screen.getByRole("button", { name: "Compare selected" });
		expect(compareBtn).toBeDisabled();

		// The RUNNING report's checkbox is disabled (the worker still owns the row —
		// the bulk-delete route's own 409 guard).
		expect(
			screen.getByRole("checkbox", {
				name: /Select report 33333333 \(unavailable/,
			}),
		).toBeDisabled();

		await user.click(
			screen.getByRole("checkbox", { name: "Select report 11111111" }),
		);
		// One selected → still disabled.
		expect(compareBtn).toBeDisabled();
		await user.click(
			screen.getByRole("checkbox", { name: "Select report 22222222" }),
		);
		// Two selected → enabled; clicking routes to /qc/compare with both ids.
		expect(compareBtn).not.toBeDisabled();
		await user.click(compareBtn);
		expect(routerPush).toHaveBeenCalledWith(`/qc/compare?jobs=${a},${b}`);
	});

	it("select-all picks every TERMINAL report and bulk-deletes the selection", async () => {
		const finished = "11111111-1111-4111-8111-111111111111";
		const errored = "22222222-2222-4222-8222-222222222222";
		const running = "33333333-3333-4333-8333-333333333333";
		apiFetch.mockImplementation(async (input: string) => {
			if (String(input).includes("/api/vmaf-jobs/bulk-delete")) {
				return { deleted: [finished, errored], skipped: [] };
			}
			return page([
				listItem({ id: finished }),
				listItem({ id: errored, status: "ERROR", renditionMeans: [] }),
				listItem({ id: running, status: "RUNNING", renditionMeans: [] }),
			]);
		});
		wrap(<VmafLabClient />);
		await screen.findByLabelText("Select all loaded reports");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select all loaded reports"));
		// Two terminal rows selected; the RUNNING one is not selectable.
		expect(await screen.findByText("2 selected")).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Delete 2 selected reports" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/api/vmaf-jobs/bulk-delete"),
			);
			expect(call).toBeTruthy();
			expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
				ids: [finished, errored],
			});
		});
		// The per-id outcome summary survives the selection being cleared.
		expect(await screen.findByText("2 deleted")).toBeInTheDocument();
	});

	it("disables the bulk delete with nothing selected", async () => {
		apiFetch.mockResolvedValue(
			page([listItem({ id: "44444444-4444-4444-8444-444444444444" })]),
		);
		wrap(<VmafLabClient />);
		expect(
			await screen.findByRole("button", {
				name: /Delete 0 selected reports \(disabled\)/,
			}),
		).toBeDisabled();
	});

	it("confirms then DELETEs a report and refetches the index", async () => {
		const id = "00000000-0000-4000-8000-0000000000a5";
		apiFetch.mockImplementation(async (_input: string, init?: RequestInit) => {
			if (init?.method === "DELETE") {
				return { id, deleted: true };
			}
			return page([listItem({ id })]);
		});
		wrap(<VmafLabClient />);
		await screen.findByText("84.2");

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Delete report 00000000" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/vmaf-jobs/${id}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		await waitFor(() => {
			const getCalls = apiFetch.mock.calls.filter(
				(c) => (c[1] as RequestInit)?.method !== "DELETE",
			);
			expect(getCalls.length).toBeGreaterThan(1);
		});
	});
});

it("retains a loaded report on refresh failure and offers recovery", async () => {
	apiFetch.mockResolvedValue(detail());
	const { client } = wrap(<VmafReport id="recover" />);
	await screen.findByText("Pooled summary");
	apiFetch.mockRejectedValue(new Error("offline"));
	await client.invalidateQueries({ queryKey: ["vmaf-job", "recover"] });
	await screen.findByText(/Failed to load the VMAF report/i);
	expect(screen.getByText("Pooled summary")).toBeInTheDocument();
	apiFetch.mockResolvedValue(detail());
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() =>
		expect(
			screen.queryByText(/Failed to load the VMAF report/i),
		).not.toBeInTheDocument(),
	);
});
it("retains loaded lab rows on refresh failure and offers recovery", async () => {
	apiFetch.mockResolvedValue({ items: [{ ...detail(), renditionMeans: [] }] });
	const { client } = wrap(<VmafLabClient />);
	await screen.findByText("FINISHED");
	apiFetch.mockRejectedValue(new Error("offline"));
	await client.invalidateQueries({ queryKey: ["vmaf-jobs"] });
	await screen.findByRole("alert");
	expect(screen.getByText("FINISHED")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});
it("keeps skipped bulk deletions selected and exposes their reasons", async () => {
	const a = {
		...detail(),
		id: "aaaaaaaa-0000-4000-8000-000000000001",
		encodingName: "Film A",
		renditionMeans: [],
	};
	const b = {
		...detail(),
		id: "bbbbbbbb-0000-4000-8000-000000000002",
		encodingName: "Film B",
		renditionMeans: [],
	};
	let deleted = false;
	apiFetch.mockImplementation(async (url: string) => {
		if (url.endsWith("bulk-delete")) {
			deleted = true;
			return {
				deleted: [a.id],
				skipped: [{ id: b.id, reason: "Cleanup is pending" }],
			};
		}
		return { items: deleted ? [b] : [a, b] };
	});
	wrap(<VmafLabClient />);
	await screen.findByLabelText("Select report Film A");
	await userEvent.click(screen.getByLabelText("Select all loaded reports"));
	await userEvent.click(
		screen.getByRole("button", { name: "Delete 2 selected reports" }),
	);
	await userEvent.click(screen.getByRole("button", { name: "Delete" }));
	await screen.findByText("Film B: Cleanup is pending");
	expect(screen.getByLabelText("Select report Film B")).toBeChecked();
	expect(screen.getByText("1 selected")).toBeInTheDocument();
});
