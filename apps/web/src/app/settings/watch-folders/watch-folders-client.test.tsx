import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

// The StoragePicker is its own tested surface; here it answers a canned
// location on open so the create flow can be driven end-to-end.
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
	}: {
		open: boolean;
		onSelect: (selection: {
			credentialId: string;
			bucket: string;
			path: string;
		}) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onSelect({
						credentialId: "00000000-0000-4000-8000-0000000000e2",
						bucket: "hot",
						path: "in/",
					})
				}
			>
				mock-pick
			</button>
		) : null,
}));

import { WatchFoldersClient } from "./watch-folders-client";

/**
 *  PR3 — the create flow posts the schema-validated payload, the
 * list shows counts/errors, re-arm hits its route, and ja renders through
 * the catalogue (incl. the no-writes promise — the page's contract line).
 */

const RULE = {
	id: "00000000-0000-4000-8000-0000000000f1",
	name: "mezz-drop",
	credentialId: "00000000-0000-4000-8000-0000000000e2",
	credentialLabel: "cred",
	bucket: "hot",
	prefix: "in/",
	extensions: ["mp4"],
	presetId: "00000000-0000-4000-8000-0000000000e1",
	presetName: "mezz",
	outputPrefixTemplate: "watch/{basename}",
	labels: [],
	enabled: true,
	pollIntervalSec: 120,
	stabilityChecks: 2,
	maxConcurrentJobs: 3,
	lastSweepAt: "2026-08-13T11:00:00.000Z",
	disarmedByResetAt: null,
	lastError: null,
	objectCounts: { SUBMITTED: 2, SEEN: 1, ERROR: 1 },
};

function mockApi(
	over: { rules?: unknown[]; objects?: unknown[]; reArmError?: Error } = {},
) {
	apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
		if (path.endsWith("/re-arm") && over.reArmError) {
			throw over.reArmError;
		}
		if (init?.method) {
			return { id: "new" };
		}
		if (path === "/api/watch-rules") {
			return over.rules ?? [RULE];
		}
		if (path === "/api/presets") {
			return [{ id: "00000000-0000-4000-8000-0000000000e1", name: "mezz" }];
		}
		if (path.startsWith("/api/watch-rules/")) {
			return { ...RULE, objects: over.objects ?? [] };
		}
		return [];
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("WatchFoldersClient", () => {
	it("lists rules with the counts line and the no-writes promise", async () => {
		mockApi();
		renderWithQuery(<WatchFoldersClient />);
		expect(await screen.findByText("mezz-drop")).toBeInTheDocument();
		// N-9: "1 errors" was pinned as correct before the One/Other split.
		expect(
			screen.getByText(/2 submitted · 1 pending · 1 error$/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/never writes, moves, or marks/),
		).toBeInTheDocument();
	});

	it("creates a rule from the picked location (schema-validated payload)", async () => {
		mockApi({ rules: [] });
		renderWithQuery(<WatchFoldersClient />);
		await screen.findByText(/No watch rules yet/);
		await userEvent.type(screen.getByLabelText("Rule name"), "mezz-drop");
		// The Field's <label htmlFor> makes "Watched location" the button's
		// ACCESSIBLE name; the visible copy is the reliable handle.
		await userEvent.click(screen.getByText("Choose bucket / prefix…"));
		await userEvent.click(screen.getByRole("button", { name: "mock-pick" }));
		await userEvent.selectOptions(
			screen.getByLabelText("Job template (FULL_PLAN preset)"),
			"00000000-0000-4000-8000-0000000000e1",
		);
		await userEvent.click(screen.getByRole("button", { name: "Create rule" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			);
			expect(call?.[0]).toBe("/api/watch-rules");
			const payload = JSON.parse((call?.[1] as RequestInit).body as string);
			expect(payload).toMatchObject({
				name: "mezz-drop",
				bucket: "hot",
				prefix: "in/",
				extensions: ["mp4", "mov", "mxf"],
				outputPrefixTemplate: "watch/{rule}/{date}/{basename}-{uuid}",
			});
		});
	});

	it("creating without a location is refused client-side, translated", async () => {
		mockApi({ rules: [] });
		renderWithQuery(<WatchFoldersClient />, "ja");
		await screen.findByText(/監視ルールがまだありません/);
		await userEvent.click(screen.getByRole("button", { name: "ルールを作成" }));
		expect(
			await screen.findByText(/まず監視するバケットとプレフィックスを選択/),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			),
		).toBeUndefined();
	});

	it("expanding a rule shows objects with job links; re-arm posts", async () => {
		mockApi({
			objects: [
				{
					id: "00000000-0000-4000-8000-0000000000f2",
					objectKey: "in/show.mp4",
					state: "SUBMITTED",
					stableCount: 2,
					error: null,
					updatedAt: "2026-08-13T11:00:00.000Z",
					encodingJob: { id: "job-1", status: "RUNNING", name: "show.mp4" },
				},
			],
		});
		renderWithQuery(<WatchFoldersClient />);
		await screen.findByText("mezz-drop");
		await userEvent.click(screen.getByRole("button", { name: "Objects" }));
		expect(await screen.findByText("in/show.mp4")).toBeInTheDocument();
		expect(screen.getByText("job: RUNNING")).toBeInTheDocument();
		// C-1: the FIRST click only arms the confirm — money moves on the
		// second. One click must never POST.
		await userEvent.click(screen.getByRole("button", { name: "Re-encode" }));
		expect(
			apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			),
		).toBeUndefined();
		await userEvent.click(
			screen.getByRole("button", { name: "Really re-encode? Click again" }),
		);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/watch-rules/${RULE.id}/re-arm`,
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("a REFUSED re-arm surfaces the server's reason beside the row", async () => {
		mockApi({
			objects: [
				{
					id: "00000000-0000-4000-8000-0000000000f2",
					objectKey: "in/show.mp4",
					state: "SUBMITTED",
					stableCount: 2,
					error: null,
					updatedAt: "2026-08-13T11:00:00.000Z",
					encodingJob: { id: "job-1", status: "RUNNING", name: "show.mp4" },
				},
			],
			reArmError: new Error(
				"This object already has a STABLE row pending or in flight — re-arming again would bill twice for one file",
			),
		});
		renderWithQuery(<WatchFoldersClient />);
		await screen.findByText("mezz-drop");
		await userEvent.click(screen.getByRole("button", { name: "Objects" }));
		await screen.findByText("in/show.mp4");
		await userEvent.click(screen.getByRole("button", { name: "Re-encode" }));
		await userEvent.click(
			screen.getByRole("button", { name: "Really re-encode? Click again" }),
		);
		expect(
			await screen.findByText(/Re-encode failed: .*bill twice/),
		).toBeInTheDocument();
	});

	it("enabling a reset-disarmed rule asks first, and consent carries the ack (ledger #132)", async () => {
		mockApi({
			rules: [
				{
					...RULE,
					enabled: false,
					disarmedByResetAt: "2026-08-21T00:00:00.000Z",
				},
			],
		});
		renderWithQuery(<WatchFoldersClient />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Enable" }),
		);
		// No PATCH yet — the dialog intercepts.
		expect(
			apiFetch.mock.calls.filter(
				([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
			),
		).toHaveLength(0);
		expect(
			screen.getByText("Re-detect everything under this prefix?"),
		).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: "Enable and re-detect" }),
		);
		const patches = apiFetch.mock.calls.filter(
			([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
		);
		expect(patches).toHaveLength(1);
		expect(JSON.parse(String((patches[0]?.[1] as RequestInit).body))).toEqual({
			enabled: true,
			acknowledgeRedetection: true,
		});
	});

	it("an un-stamped rule enables with no dialog (ledger #132)", async () => {
		mockApi({ rules: [{ ...RULE, enabled: false }] });
		renderWithQuery(<WatchFoldersClient />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Enable" }),
		);
		expect(
			screen.queryByText("Re-detect everything under this prefix?"),
		).toBeNull();
		const patches = apiFetch.mock.calls.filter(
			([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
		);
		expect(patches).toHaveLength(1);
		expect(JSON.parse(String((patches[0]?.[1] as RequestInit).body))).toEqual({
			enabled: true,
		});
	});

	it("renders Japanese throughout", async () => {
		mockApi();
		renderWithQuery(<WatchFoldersClient />, "ja");
		expect(await screen.findByText("mezz-drop")).toBeInTheDocument();
		expect(screen.getAllByText("監視フォルダ").length).toBeGreaterThan(0);
		expect(
			screen.getByText(
				"監視処理では、対象バケットの一覧取得だけを行います。入力オブジェクトの書き込み・移動や、処理済みマーカーの追加は行いません。処理済みかどうかはアプリ側で管理します。",
			),
		).toBeInTheDocument();
		expect(screen.getByText("投入 2 · 待機 1 · エラー 1")).toBeInTheDocument();
	});
});

it("reports failed watch-folder reads instead of calling them empty", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(<WatchFoldersClient />);
	expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
	expect(screen.queryByText("No watch folders yet.")).not.toBeInTheDocument();
	mockApi();
	for (const retry of screen.getAllByRole("button", { name: "Retry" }))
		await userEvent.click(retry);
	expect(await screen.findByText("mezz-drop")).toBeInTheDocument();
});

it("shows failed object reads and toggle failures with recovery", async () => {
	mockApi();
	const read = apiFetch.getMockImplementation();
	apiFetch.mockImplementation((url: string, options?: RequestInit) =>
		options?.method === "PATCH" || url.endsWith(RULE.id)
			? Promise.reject(new Error("offline"))
			: read?.(url, options),
	);
	renderWithQuery(<WatchFoldersClient />);
	await userEvent.click(await screen.findByRole("button", { name: "Objects" }));
	expect(
		await screen.findByRole("button", { name: "Retry" }),
	).toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "Disable" }));
	await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
});
