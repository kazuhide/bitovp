import type { QcGate, QcVerdict } from "@bitovp/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as renderL } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { QcGatePanel } from "./qc-gate-panel";

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * The gate panel's states are CLAIMS about a delivery decision, so each one
 * must say exactly what happened: a failing verdict is FAIL, a failed
 * MEASUREMENT is not (it never judged quality), a parked job explains what it
 * is waiting for, and an unmeasured target is a word — not an empty cell an
 * operator reads as zero .
 */

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";
const VMAF_ID = "00000000-0000-4000-8000-0000000000a1";

const gate = (over: Partial<QcGate> = {}): QcGate => ({
	rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
	onFail: "BLOCK_MANIFESTS",
	...over,
});

const failingVerdict: QcVerdict = {
	pass: false,
	ruleResults: [
		{
			rule: { metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 },
			pass: false,
			actuals: [
				{ rendition: "v360", value: 95.44, pass: true },
				{ rendition: "pt", variant: "360p_500k", value: 61.2, pass: false },
				{ rendition: "ghost", value: null, pass: false },
			],
		},
	],
};

function renderPanel(props: Partial<Parameters<typeof QcGatePanel>[0]> = {}) {
	return renderL(
		<QcGatePanel
			gate={gate()}
			verdict={null}
			status="FINISHED"
			jobId={JOB_ID}
			vmafJobId={VMAF_ID}
			{...props}
		/>,
		// ja on purpose: the assertions read the JAPANESE catalogue, so an
		// untranslated string in this panel fails here rather than surviving
		// until a ja render sweep (the #35 lesson).
		"ja",
	);
}

describe("QcGatePanel", () => {
	it("renders one row PER ACTUAL — rungs and unmeasured targets included", () => {
		renderPanel({ verdict: failingVerdict, status: "QC_FAILED" });
		const rows = screen.getAllByRole("row").slice(1); // minus header
		expect(rows).toHaveLength(3);
		// The per-title rung carries its variant beside the rendition key.
		expect(rows[1]).toHaveTextContent("pt");
		expect(rows[1]).toHaveTextContent("(360p_500k)");
		expect(within(rows[1] as HTMLElement).getByText("61.20")).toBeTruthy();
		// Unmeasured = the word, not an empty cell.
		expect(rows[2]).toHaveTextContent("未測定");
		// The section verdict is FAIL (the ja word).
		expect(screen.getAllByText("不合格").length).toBeGreaterThan(0);
	});

	it("AWAITING_QC explains the park instead of claiming a verdict", () => {
		renderPanel({ status: "AWAITING_QC" });
		expect(screen.getByText("測定待ち")).toBeTruthy();
		expect(screen.getByText(/マニフェスト生成を保留しています/)).toBeTruthy();
		// The spec rows render with no actuals — dashes, not zeros or PASS.
		expect(screen.queryByText("合格")).toBeNull();
	});

	it("QC_FAILED with NO verdict reads MEASUREMENT FAILED, never FAIL", () => {
		renderPanel({ status: "QC_FAILED", verdict: null });
		expect(screen.getByText("測定失敗")).toBeTruthy();
		expect(screen.queryByText("不合格")).toBeNull();
	});

	it("MARK_ONLY + errored measurement: FINISHED job, no verdict → 測定失敗, not 判定なし (review-202 I2)", () => {
		/* Mark-only quality checks do not park a finished encoding. A failed analysis with no verdict must remain distinct from having no quality check. */
		renderPanel({
			gate: gate({ onFail: "MARK_ONLY" }),
			status: "FINISHED",
			verdict: null,
			measurementStatus: "ERROR",
		});
		expect(screen.getByText("測定失敗")).toBeTruthy();
		expect(screen.queryByText("判定なし")).toBeNull();
	});

	it("no measurement yet on a FINISHED MARK_ONLY job stays 判定なし", () => {
		renderPanel({
			gate: gate({ onFail: "MARK_ONLY" }),
			status: "FINISHED",
			verdict: null,
			measurementStatus: "RUNNING",
		});
		expect(screen.getByText("判定なし")).toBeTruthy();
	});

	it("links the VMAF report only when a measurement exists, exports always", () => {
		const { unmount } = renderPanel({ verdict: failingVerdict });
		expect(
			screen.getByRole("link", { name: "VMAF レポートを見る" }),
		).toHaveAttribute("href", `/qc/${VMAF_ID}`);
		for (const [name, format] of [
			["レポート (JSON)", "json"],
			["レポート (CSV)", "csv"],
			["印刷用レポート (HTML)", "html"],
		] as const) {
			expect(screen.getByRole("link", { name })).toHaveAttribute(
				"href",
				`/api/encoding-jobs/${JOB_ID}/qc-report?format=${format}`,
			);
		}
		unmount();
		renderPanel({ vmafJobId: null });
		expect(
			screen.queryByRole("link", { name: "VMAF レポートを見る" }),
		).toBeNull();
		expect(screen.getByRole("link", { name: "レポート (JSON)" })).toBeTruthy();
	});

	it("QC_FAILED shows the two-click Deliver-anyway; success invalidates the job query (ledger #86 PR4)", async () => {
		apiFetch.mockResolvedValue({ id: JOB_ID, status: "QUEUED" });
		const { client } = renderPanel({
			status: "QC_FAILED",
			verdict: failingVerdict,
		});
		const spy = vi.spyOn(client, "invalidateQueries");
		const user = userEvent.setup();
		const arm = screen.getByRole("button", { name: "それでも配信する" });
		await user.click(arm);
		// First click ARMS — no POST yet.
		expect(apiFetch).not.toHaveBeenCalled();
		const confirm = screen.getByRole("button", {
			name: "確認: 不合格のまま配信",
		});
		await user.click(confirm);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/encoding-jobs/${JOB_ID}/qc-override`,
				{ method: "POST" },
			);
		});
		await waitFor(() => {
			expect(spy).toHaveBeenCalledWith({
				queryKey: ["encoding-job", JOB_ID],
			});
		});
	});

	it("no override button outside QC_FAILED; the forced-delivery line renders when stamped", () => {
		const { unmount } = renderPanel({
			status: "FINISHED",
			verdict: failingVerdict,
			overriddenAt: "2026-08-14T01:00:00.000Z",
		});
		expect(
			screen.queryByRole("button", { name: "それでも配信する" }),
		).toBeNull();
		// A forced delivery is never silent (design §4).
		expect(screen.getByText(/に不合格のまま配信を強制しました。/)).toBeTruthy();
		unmount();
		renderPanel({ status: "FINISHED", verdict: failingVerdict });
		expect(screen.queryByText(/配信を強制しました/)).toBeNull();
	});

	it("names the onFail mode — blocking vs mark-only read differently", () => {
		const { unmount } = renderPanel();
		expect(screen.getByText("不合格時はマニフェスト生成を保留")).toBeTruthy();
		unmount();
		renderPanel({ gate: gate({ onFail: "MARK_ONLY" }) });
		expect(screen.getByText("不合格でも記録のみ(配信は継続)")).toBeTruthy();
	});
});
