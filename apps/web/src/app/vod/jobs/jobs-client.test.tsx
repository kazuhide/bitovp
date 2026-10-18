import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery } from "@/test/render";

/**
 * : the QC column and filter are flag-gated and the provider's own
 * default is OFF (a fresh deployment). These cases were written for the full
 * surface, so the helper renders with QC/VMAF ON; the two-state pin at the
 * bottom covers OFF.
 */
function wrap(
	node: React.ReactElement,
	locale: "en" | "ja" = "en",
	qcVmaf = true,
) {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf }}>{node}</FeatureFlagsProvider>,
		locale,
	);
}

// Control the data layer so the table renders against fixed payloads and the
// bulk-re-run POST is observable.
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { JOB_STATUSES, type JobListItem, JobsClient } from "./jobs-client";

function job(over: Partial<JobListItem> = {}): JobListItem {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		name: "Sample job",
		labels: [],
		status: "FINISHED",
		region: "us-east-1",
		doneSteps: 5,
		totalSteps: 5,
		error: null,
		bitmovinEncodingId: "bm-1",
		qcVerdict: null,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:02:30.000Z",
		// Equal to updatedAt in the base fixture — the backfill-approximated
		// shape, where the #123 fallback and the real value agree.
		finishedAt: "2026-06-18T00:02:30.000Z",
		...over,
	};
}

/** Resolves the GET list call and stubs each bulk POST with an empty outcome. */
function mockList(items: JobListItem[]) {
	apiFetch.mockImplementation(async (input: string) => {
		if (input === "/api/auth/session") {
			return {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			};
		}
		if (input.startsWith("/api/encoding-jobs/bulk-re-run")) {
			return { created: [], failed: [] };
		}
		if (input.startsWith("/api/encoding-jobs/bulk-cancel")) {
			return { canceled: [], skipped: [] };
		}
		if (input.startsWith("/api/encoding-jobs/bulk-delete")) {
			return { deleted: [], skipped: [] };
		}
		return { items };
	});
}

/** Body of the first POST to `path`, parsed. */
function bulkBody(path: string): unknown {
	const call = apiFetch.mock.calls.find((c) => String(c[0]).includes(path));
	return JSON.parse(String((call?.[1] as RequestInit)?.body));
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	window.localStorage.removeItem("ovp-vod-jobs-columns");
	vi.restoreAllMocks();
});

describe("JobsClient", () => {
	it.each([
		"ja",
		"en",
	] as const)("%s: uses one canonical status in each row and filter option", async (locale) => {
		mockList(
			JOB_STATUSES.map((status, i) =>
				job({ id: `job-${i}`, name: `Job ${status}`, status }),
			),
		);
		wrap(<JobsClient />, locale);
		for (const status of JOB_STATUSES) {
			const row = (await screen.findByText(`Job ${status}`)).closest("tr");
			expect(row).not.toBeNull();
			const badge = within(row as HTMLElement).getByText(status);
			expect(badge.closest("td")).toHaveTextContent(new RegExp(`^${status}$`));
			expect(screen.getByRole("option", { name: status })).toHaveValue(status);
		}
	});
	it("renders the new columns (labels, region, progress %, duration)", async () => {
		mockList([
			job({
				name: "Promo encode",
				labels: ["promo", "q3"],
				region: "eu-west-1",
				doneSteps: 3,
				totalSteps: 6,
			}),
		]);
		wrap(<JobsClient />);

		expect(await screen.findByText("Promo encode")).toBeInTheDocument();
		expect(screen.getByText("promo")).toBeInTheDocument();
		expect(screen.getByText("q3")).toBeInTheDocument();
		expect(screen.getByText("eu-west-1")).toBeInTheDocument();
		// 3/6 → 50%.
		expect(screen.getByText("50%")).toBeInTheDocument();
		// Terminal job: run duration (00:00 → 00:02:30 = 2m 30s).
		expect(screen.getByText("2m 30s")).toBeInTheDocument();
	});

	it("ja: renders canonical status and provider region, with raw errors as technical detail", async () => {
		const providerError =
			"POST /encoding/encodings/enc-1/start 400: upstream rejected request";
		mockList([
			job({
				name: "東京向け配信",
				status: "ERROR",
				region: "AWS_AP_NORTHEAST_1",
				error: providerError,
			}),
		]);
		wrap(<JobsClient />, "ja");

		const row = (await screen.findByText("東京向け配信")).closest("tr");
		expect(row).not.toBeNull();
		expect(
			within(row as HTMLElement).queryByText("失敗"),
		).not.toBeInTheDocument();
		expect(within(row as HTMLElement).getByText("ERROR")).toBeInTheDocument();
		expect(
			within(row as HTMLElement).getByText("AWS ap-northeast-1"),
		).toBeInTheDocument();
		expect(
			within(row as HTMLElement).getByText("AWS_AP_NORTHEAST_1"),
		).toBeInTheDocument();
		expect(
			within(row as HTMLElement).getByText(
				"エンコードに失敗しました。技術情報を確認してから再実行してください。",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(providerError)).toBeNull();

		await userEvent.click(
			within(row as HTMLElement).getByRole("button", { name: "技術情報" }),
		);
		expect(await screen.findByText(providerError)).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "FINISHED" })).toHaveValue(
			"FINISHED",
		);
	});

	it("Duration derives from finishedAt — a late write must not inflate it (ledger #123)", async () => {
		mockList([
			job({
				// The step-log's documented sighting: the run FINISHED at 2m30s,
				// then a MARK_ONLY VMAF verdict wrote the row an hour later.
				// updatedAt moves; the displayed run time must not.
				finishedAt: "2026-06-18T00:02:30.000Z",
				updatedAt: "2026-06-18T01:02:30.000Z",
			}),
		]);
		wrap(<JobsClient />);
		expect(await screen.findByText("2m 30s")).toBeInTheDocument();
		expect(screen.queryByText("1h 2m 30s")).toBeNull();
	});

	it("rows without finishedAt fall back to updatedAt, stated not silent", async () => {
		mockList([job({ finishedAt: null })]);
		wrap(<JobsClient />);
		expect(await screen.findByText("2m 30s")).toBeInTheDocument();
	});

	it("shows '—' for unknown progress (pre-migration totalSteps=0) and live duration for active jobs", async () => {
		// : QC is hidden by DEFAULT now — this test pins the render,
		// so seed the full column set (the pre-#117 geometry).
		window.localStorage.setItem(
			"ovp-vod-jobs-columns",
			JSON.stringify([
				"status",
				"qc",
				"labels",
				"region",
				"progress",
				"duration",
				"created",
			]),
		);
		mockList([
			job({
				id: "00000000-0000-4000-8000-000000000009",
				name: "Legacy running",
				status: "RUNNING",
				doneSteps: 0,
				totalSteps: 0,
			}),
		]);
		wrap(<JobsClient />);

		const row = (await screen.findByText("Legacy running")).closest("tr");
		expect(row).not.toBeNull();
		// Columns: [checkbox, Name, Status, QC, Labels, Region, Progress,
		// Duration, Created] — QC landed at index 3 . The
		// Progress cell (index 6) shows "—" when totalSteps=0.
		const cells = (row as HTMLElement).querySelectorAll("td");
		expect(cells[6]?.textContent).toBe("—");
		// Active job → live "running" indicator instead of a static duration.
		expect(within(row as HTMLElement).getByText("running")).toBeInTheDocument();
	});

	it("drives the status and label filters into the query params", async () => {
		mockList([job()]);
		wrap(<JobsClient />);
		await screen.findByText("Sample job");

		const user = userEvent.setup();
		await user.selectOptions(screen.getByLabelText("Status"), "FINISHED");
		await user.type(screen.getByLabelText("Label"), "promo");

		await waitFor(() => {
			const urls = apiFetch.mock.calls.map((c) => String(c[0]));
			expect(
				urls.some(
					(u) => u.includes("status=FINISHED") && u.includes("label=promo"),
				),
			).toBe(true);
		});
	});

	it.each([
		"Status",
		"Label",
		"QC",
	])("clears selection when the %s filter changes", async (filter) => {
		mockList([job()]);
		wrap(<JobsClient />);
		await screen.findByText("Sample job");
		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select Sample job"));
		if (filter === "Label")
			await user.type(screen.getByLabelText(filter), "promo");
		else
			await user.selectOptions(
				screen.getByLabelText(filter),
				filter === "QC" ? "fail" : "ERROR",
			);
		await user.click(screen.getByRole("button", { name: "Clear" }));
		expect(await screen.findByLabelText("Select Sample job")).not.toBeChecked();
		expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
	});

	it("retains only failed re-runs and shows the source and reason for recovery", async () => {
		const a = job({ id: "00000000-0000-4000-8000-00000000000a", name: "A" });
		const b = job({ id: "00000000-0000-4000-8000-00000000000b", name: "B" });
		mockList([a, b]);
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("Missing API mock");
		apiFetch.mockImplementation((input, init) =>
			input.endsWith("/bulk-re-run")
				? Promise.resolve({
						created: [{ sourceId: a.id, newId: "new-a" }],
						failed: [{ sourceId: b.id, error: "Account unavailable" }],
					})
				: original(input, init),
		);
		wrap(<JobsClient />);
		await screen.findByText("A");
		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select all loaded jobs"));
		await user.click(screen.getByRole("button", { name: /Re-run selected/ }));
		expect(await screen.findByText("Account unavailable")).toBeVisible();
		expect(screen.getAllByRole("link", { name: "B" })).toHaveLength(2);
		expect(screen.getByLabelText("Select A")).not.toBeChecked();
		expect(screen.getByLabelText("Select B")).toBeChecked();
		await user.click(screen.getByRole("button", { name: /Re-run selected/ }));
		const calls = apiFetch.mock.calls.filter(([url]) =>
			String(url).endsWith("/bulk-re-run"),
		);
		const retryCall = calls[1];
		if (!retryCall) throw new Error("Expected a retry request");
		expect(JSON.parse(retryCall[1].body)).toEqual({ ids: [b.id] });
	});

	it.each([
		"cancel",
		"delete",
	])("keeps skipped bulk-%s rows selected and explains why", async (action) => {
		const status = action === "cancel" ? "RUNNING" : "FINISHED";
		const a = job({
			id: "00000000-0000-4000-8000-00000000000a",
			name: "A",
			status,
		});
		const b = job({
			id: "00000000-0000-4000-8000-00000000000b",
			name: "B",
			status,
		});
		mockList([a, b]);
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("Missing API mock");
		apiFetch.mockImplementation((input, init) =>
			input.endsWith(`/bulk-${action}`)
				? Promise.resolve({
						[action === "cancel" ? "canceled" : "deleted"]: [a.id],
						skipped: [{ id: b.id, reason: "Cleanup pending" }],
					})
				: original(input, init),
		);
		wrap(<JobsClient />);
		await screen.findByText("A");
		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select all loaded jobs"));
		await user.click(
			screen.getByRole("button", {
				name:
					action === "cancel" ? "Cancel selected" : "Delete 2 selected jobs",
			}),
		);
		if (action === "delete")
			await user.click(screen.getByRole("button", { name: "Delete" }));
		expect(await screen.findByText("Cleanup pending")).toBeVisible();
		expect(screen.getByLabelText("Select A")).not.toBeChecked();
		expect(screen.getByLabelText("Select B")).toBeChecked();
	});

	it.each([
		["Re-run failed", "再実行に失敗しました"],
		["Cancel failed", "キャンセルに失敗しました"],
		["Delete failed", "削除に失敗しました"],
	])("localizes the safe bulk failure %s", async (error, translated) => {
		const a = job({ name: "A" });
		mockList([a]);
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("Missing API mock");
		apiFetch.mockImplementation((input, init) =>
			input.endsWith("/bulk-re-run")
				? Promise.resolve({ created: [], failed: [{ sourceId: a.id, error }] })
				: original(input, init),
		);
		wrap(<JobsClient />, "ja");
		await screen.findByText("A");
		const user = userEvent.setup();
		await user.click(screen.getByRole("checkbox", { name: /A/ }));
		await user.click(screen.getByRole("button", { name: /再実行/ }));
		expect(await screen.findByText(translated)).toBeVisible();
		expect(screen.queryByText(error)).not.toBeInTheDocument();
	});

	it("selects rows and fires the bulk re-run with the selected ids", async () => {
		const a = job({ id: "00000000-0000-4000-8000-00000000000a", name: "A" });
		const b = job({ id: "00000000-0000-4000-8000-00000000000b", name: "B" });
		mockList([a, b]);
		wrap(<JobsClient />);
		await screen.findByText("A");

		const user = userEvent.setup();
		// No action bar until something is selected.
		expect(screen.queryByText(/Re-run selected/)).not.toBeInTheDocument();

		await user.click(screen.getByLabelText("Select A"));
		expect(await screen.findByText("1 selected")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /Re-run selected/ }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/api/encoding-jobs/bulk-re-run"),
			);
			expect(call).toBeTruthy();
			const init = call?.[1] as RequestInit;
			expect(init.method).toBe("POST");
			expect(JSON.parse(String(init.body))).toEqual({ ids: [a.id] });
		});
	});

	it("select-all picks every loaded row", async () => {
		mockList([
			job({ id: "00000000-0000-4000-8000-00000000000a", name: "A" }),
			job({ id: "00000000-0000-4000-8000-00000000000b", name: "B" }),
		]);
		wrap(<JobsClient />);
		await screen.findByText("A");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select all loaded jobs"));
		expect(await screen.findByText("2 selected")).toBeInTheDocument();
	});

	it("offers an enabled delete on terminal jobs and a disabled one on active jobs", async () => {
		mockList([
			job({ name: "Done one", status: "FINISHED" }),
			job({
				id: "00000000-0000-4000-8000-00000000000b",
				name: "Live one",
				status: "RUNNING",
			}),
		]);
		wrap(<JobsClient />);
		await screen.findByText("Done one");

		// Terminal job → an enabled "Delete <name>" trigger.
		const enabled = screen.getByRole("button", { name: "Delete Done one" });
		expect(enabled).not.toBeDisabled();
		// Active job → the disabled variant (its aria-label carries "(disabled)").
		expect(
			screen.getByRole("button", { name: /Delete Live one \(disabled\)/ }),
		).toBeDisabled();
	});

	it("sends ONLY the active selection to bulk-cancel and labels the eligible count", async () => {
		const running = job({
			id: "00000000-0000-4000-8000-00000000000a",
			name: "Live one",
			status: "RUNNING",
		});
		const done = job({
			id: "00000000-0000-4000-8000-00000000000b",
			name: "Done one",
			status: "FINISHED",
		});
		mockList([running, done]);
		wrap(<JobsClient />);
		await screen.findByText("Live one");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select all loaded jobs"));
		// 2 selected, only 1 cancelable → the button discloses the subset size.
		const cancelBtn = await screen.findByRole("button", {
			name: /Cancel selected \(1\)/,
		});
		await user.click(cancelBtn);

		await waitFor(() => {
			expect(bulkBody("/api/encoding-jobs/bulk-cancel")).toEqual({
				ids: [running.id],
			});
		});
	});

	it("disables Cancel selected when nothing in the selection is active", async () => {
		mockList([job({ name: "Done one", status: "FINISHED" })]);
		wrap(<JobsClient />);
		await screen.findByText("Done one");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select Done one"));
		expect(
			await screen.findByRole("button", { name: /Cancel selected \(0\)/ }),
		).toBeDisabled();
	});

	it("confirms then bulk-DELETEs only the terminal selection", async () => {
		const running = job({
			id: "00000000-0000-4000-8000-00000000000a",
			name: "Live one",
			status: "RUNNING",
		});
		const done = job({
			id: "00000000-0000-4000-8000-00000000000b",
			name: "Done one",
			status: "ERROR",
		});
		mockList([running, done]);
		wrap(<JobsClient />);
		await screen.findByText("Live one");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select all loaded jobs"));
		await user.click(
			await screen.findByRole("button", { name: "Delete 1 selected jobs" }),
		);
		// Only the explicit confirm click issues the request.
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			expect(bulkBody("/api/encoding-jobs/bulk-delete")).toEqual({
				ids: [done.id],
			});
		});
	});

	it("disables the bulk delete when the selection holds no terminal job", async () => {
		mockList([job({ name: "Live one", status: "RUNNING" })]);
		wrap(<JobsClient />);
		await screen.findByText("Live one");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select Live one"));
		expect(
			await screen.findByRole("button", {
				name: /Delete 0 selected jobs \(disabled\)/,
			}),
		).toBeDisabled();
	});

	it("reports the per-id bulk outcome (acted + skipped)", async () => {
		const a = job({ id: "00000000-0000-4000-8000-00000000000a", name: "A" });
		apiFetch.mockImplementation(async (input: string) => {
			if (input === "/api/auth/session") {
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			}
			if (input.startsWith("/api/encoding-jobs/bulk-delete")) {
				return {
					deleted: [a.id],
					skipped: [{ id: "x", reason: "Not found" }],
				};
			}
			return { items: [a] };
		});
		wrap(<JobsClient />);
		await screen.findByText("A");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Select A"));
		await user.click(
			await screen.findByRole("button", { name: "Delete 1 selected jobs" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		expect(await screen.findByText("1 deleted, 1 skipped")).toBeInTheDocument();
	});

	it("confirms then DELETEs the job and refetches the list", async () => {
		mockList([job({ name: "Done one", status: "FINISHED" })]);
		wrap(<JobsClient />);
		await screen.findByText("Done one");

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Delete Done one" }));
		// The confirm dialog only DELETEs on the explicit confirm click.
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/encoding-jobs/${job().id}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		// onSuccess invalidates ["encoding-jobs"] → at least one refetch GET fires.
		await waitFor(() => {
			const listCalls = apiFetch.mock.calls.filter(
				(c) =>
					String(c[0]).startsWith("/api/encoding-jobs") &&
					(c[1] as RequestInit)?.method !== "DELETE",
			);
			expect(listCalls.length).toBeGreaterThan(1);
		});
	});
});

/**
 * The list screen in Japanese. Hardcoded literals, not `t` lookups — an
 * expectation computed through the same catalogue the component reads moves in
 * lockstep with it and proves nothing.
 *
 * This screen shipped English-only in the first i18n pass; the owner was right that
 * the coverage was nowhere near enough, and these are strings an operator reads
 * every day.
 */
describe("JobsClient — Japanese", () => {
	it("renders the heading, filters and table headers in Japanese", async () => {
		mockList([]);
		wrap(<JobsClient />, "ja");
		/* Filter labels also appear as column headings, so use multi-match queries for those shared names. */
		for (const label of [
			"VOD ジョブ",
			"VOD ジョブを作成",
			"ステータス",
			"ラベル",
			"名前",
			"進捗",
			"操作",
		]) {
			expect((await screen.findAllByText(label)).length, label).toBeGreaterThan(
				0,
			);
		}
		for (const english of ["VOD Jobs", "New VOD Job", "Progress", "Actions"]) {
			expect(screen.queryByText(english), english).not.toBeInTheDocument();
		}
	});

	it("renders the empty-state hint in Japanese", async () => {
		mockList([]);
		wrap(<JobsClient />, "ja");
		expect(
			await screen.findByText(/ジョブがまだありません/),
		).toBeInTheDocument();
	});

	it("a QC-only filter with zero matches says NO MATCHES, never 'no jobs yet' (review-202 I1)", async () => {
		/* A quality filter must participate in both empty-state detection and the clear-filters affordance. */
		mockList([]);
		wrap(<JobsClient />, "ja");
		const user = userEvent.setup();
		await user.selectOptions(await screen.findByLabelText("QC"), "fail");
		await waitFor(() => {
			expect(
				screen.getByText("現在の絞り込み条件に一致するジョブはありません。"),
			).toBeInTheDocument();
		});
		expect(
			screen.queryByText(/ジョブがまだありません/),
		).not.toBeInTheDocument();
		// The filter genuinely reached the API (counterfactual guard).
		const urls = apiFetch.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.includes("qc=fail"))).toBe(true);
	});

	it("renders the QC column — PASS/FAIL badges from the verdict, dash without one (ledger #86 PR3)", async () => {
		// : QC is hidden by DEFAULT now — this test pins the render,
		// so seed the full column set (the pre-#117 geometry).
		window.localStorage.setItem(
			"ovp-vod-jobs-columns",
			JSON.stringify([
				"status",
				"qc",
				"labels",
				"region",
				"progress",
				"duration",
				"created",
			]),
		);
		mockList([
			job({ id: "00000000-0000-4000-8000-000000000001", name: "no-gate" }),
			job({
				id: "00000000-0000-4000-8000-000000000002",
				name: "gate-pass",
				qcVerdict: { pass: true },
			}),
			job({
				id: "00000000-0000-4000-8000-000000000003",
				name: "gate-fail",
				qcVerdict: { pass: false },
			}),
		]);
		wrap(<JobsClient />, "ja");
		await screen.findByText("no-gate");
		// Column header + filter label share the "QC" word; the cells carry
		// the localized verdict words.
		expect(screen.getAllByText("QC").length).toBeGreaterThan(0);
		// TWO of each verdict word: the cell badge and the filter option.
		expect(screen.getAllByText("合格")).toHaveLength(2);
		expect(screen.getAllByText("不合格")).toHaveLength(2);
		// The no-gate row's QC cell (index 3) is a dash.
		const noGateRow = screen.getByText("no-gate").closest("tr");
		expect(noGateRow?.querySelectorAll("td")[3]?.textContent).toBe("—");
	});
});

/**
 * : user-selectable columns, persisted per-browser. QC ships
 * HIDDEN by default (owner 2026-08-17); the stored set survives a reload and
 * unknown keys are dropped rather than kept as ghosts.
 */
describe("column picker (ledger #117)", () => {
	afterEach(() => window.localStorage.removeItem("ovp-vod-jobs-columns"));

	it("hides QC by default and shows it after toggling — persisting the choice", async () => {
		mockList([job()]);
		wrap(<JobsClient />);
		await screen.findByText("Sample job");
		// QC column: absent as a HEADER by default (the filter label may exist).
		expect(
			screen.queryByRole("columnheader", { name: "QC" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("columnheader", { name: "Status" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByText("Columns"));
		fireEvent.click(screen.getByRole("checkbox", { name: "QC" }));
		expect(
			screen.getByRole("columnheader", { name: "QC" }),
		).toBeInTheDocument();
		expect(
			JSON.parse(window.localStorage.getItem("ovp-vod-jobs-columns") ?? "[]"),
		).toContain("qc");
	});

	it("garbage storage falls back to defaults — valid-JSON-non-array and malformed JSON both (review-253 117-A1)", async () => {
		for (const garbage of ['{"not":"an array"}', "{{{not json"]) {
			window.localStorage.setItem("ovp-vod-jobs-columns", garbage);
			mockList([job()]);
			const view = wrap(<JobsClient />);
			await screen.findByText("Sample job");
			expect(
				screen.queryByRole("columnheader", { name: "QC" }),
			).not.toBeInTheDocument();
			expect(
				screen.getByRole("columnheader", { name: "Status" }),
			).toBeInTheDocument();
			view.unmount();
		}
	});

	it("a stored set that filters to NOTHING is schema drift, not all-off — defaults return (117-A1)", async () => {
		window.localStorage.setItem(
			"ovp-vod-jobs-columns",
			JSON.stringify(["ghost-a", "ghost-b"]),
		);
		mockList([job()]);
		wrap(<JobsClient />);
		await screen.findByText("Sample job");
		expect(
			screen.getByRole("columnheader", { name: "Status" }),
		).toBeInTheDocument();
	});

	it("reads the stored set on mount and DROPS unknown keys", async () => {
		window.localStorage.setItem(
			"ovp-vod-jobs-columns",
			JSON.stringify(["status", "qc", "ghost-column"]),
		);
		mockList([job()]);
		wrap(<JobsClient />);
		await screen.findByText("Sample job");
		expect(
			screen.getByRole("columnheader", { name: "QC" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("columnheader", { name: "Created" }),
		).not.toBeInTheDocument();
	});
	it("hides the QC column, its picker entry and the QC filter when QC/VMAF is OFF (ledger #131)", async () => {
		mockList([job({ name: "Promo encode" })]);
		const off = wrap(<JobsClient />, "en", false);
		await screen.findByText("Promo encode");
		expect(screen.queryByLabelText(/QC/i)).not.toBeInTheDocument();
		// Other columns and filters survive — a gate that hid the toolbar
		// would also pass a bare absence check.
		expect(screen.getByLabelText(/status/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /columns/i }));
		expect(
			screen.queryByRole("checkbox", { name: "QC" }),
		).not.toBeInTheDocument();
		off.unmount();

		mockList([job({ name: "Promo encode" })]);
		wrap(<JobsClient />, "en", true);
		await screen.findByText("Promo encode");
		expect(screen.getByLabelText(/QC/i)).toBeInTheDocument();
	});
});
