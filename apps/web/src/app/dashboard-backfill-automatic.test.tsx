import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DashboardBackfill } from "./dashboard-backfill";

const { fetcher, allowed } = vi.hoisted(() => ({
	fetcher: vi.fn(),
	allowed: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ apiFetch: fetcher }));
vi.mock("@/lib/auth/use-role-access", () => ({ useMutationAccess: allowed }));
const active = {
	accountId: "a1",
	from: "2026-10-01",
	to: "2026-10-16",
	status: "running",
	completedChunks: 0,
	totalChunks: 2,
	rowsUpserted: 0,
	error: null,
};
const props = {
	accountId: "a1",
	from: "2020-01-01",
	to: "2020-01-02",
	automatic: true,
};
const posts = () =>
	fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
	fetcher.mockReset().mockResolvedValue({ job: null });
	allowed.mockReset().mockReturnValue(true);
});
it("refreshes latest on mount/focus, without importing the selected historical range or refiring on date changes", async () => {
	const view = renderWithQuery(<DashboardBackfill {...props} />);
	await waitFor(() => expect(posts()).toHaveLength(1));
	expect(JSON.parse(posts()[0]?.[1].body)).toEqual({
		accountId: "a1",
		mode: "automatic",
	});
	view.rerender(<DashboardBackfill {...props} from="2019-01-01" />);
	await act(async () => {});
	expect(posts()).toHaveLength(1);
	fireEvent.focus(window);
	await waitFor(() => expect(posts()).toHaveLength(2));
	view.unmount();
	fireEvent.focus(window);
	expect(posts()).toHaveLength(2);
});
it.each([
	"viewer",
	"view-as",
])("never POSTs for %s or while automatic refresh is disabled", async () => {
	allowed.mockReturnValue(false);
	const view = renderWithQuery(<DashboardBackfill {...props} />);
	await waitFor(() => expect(fetcher).toHaveBeenCalled());
	fireEvent.focus(window);
	expect(posts()).toHaveLength(0);
	view.unmount();
	allowed.mockReturnValue(true);
	renderWithQuery(<DashboardBackfill {...props} automatic={false} />);
	fireEvent.focus(window);
	await act(async () => {});
	expect(posts()).toHaveLength(0);
});
it("joins an active manual job, rechecks once after completion, then finishes the latest job without a loop", async () => {
	let n = 0;
	fetcher.mockImplementation(async (_url, init) =>
		init?.method === "POST"
			? {
					job: {
						...active,
						...(++n === 1 ? {} : { from: "2026-10-13", automatic: true }),
					},
				}
			: { job: null },
	);
	const { client } = renderWithQuery(<DashboardBackfill {...props} />);
	const invalidate = vi.spyOn(client, "invalidateQueries");
	await waitFor(() => expect(posts()).toHaveLength(1));
	await screen.findByText(/Importing/);
	act(() =>
		client.setQueryData(["dashboard-backfill", "a1"], {
			job: { ...active, status: "completed" },
		}),
	);
	await waitFor(() => expect(posts()).toHaveLength(2));
	await screen.findByText(/Updating latest statistics/);
	act(() =>
		client.setQueryData(["dashboard-backfill", "a1"], {
			job: {
				...active,
				from: "2026-10-13",
				automatic: true,
				status: "completed",
			},
		}),
	);
	await screen.findByText(/Import complete/);
	await act(async () => {});
	expect(posts()).toHaveLength(2);
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: ["dashboard-usage", "a1"],
	});
});
it("does not hot-loop after automatic failure and provides an explicit latest-data retry", async () => {
	fetcher.mockImplementation(async (_url, init) => {
		if (init?.method === "POST") throw new Error("offline");
		return { job: null };
	});
	renderWithQuery(<DashboardBackfill {...props} />);
	await screen.findByRole("alert");
	fireEvent.focus(window);
	fireEvent.focus(window);
	await act(async () => {});
	expect(posts()).toHaveLength(1);
	fetcher.mockResolvedValue({ job: null });
	fireEvent.click(
		screen.getByRole("button", { name: "Retry latest statistics" }),
	);
	await waitFor(() => expect(posts()).toHaveLength(2));
});
it("late pre-POST status cannot overwrite the queued automatic job", async () => {
	let resolveOld: (value: unknown) => void = () => {};
	const old = new Promise((resolve) => {
		resolveOld = resolve;
	});
	fetcher.mockImplementation((_url, init) =>
		init?.method === "POST"
			? Promise.resolve({
					job: { ...active, status: "queued", automatic: true },
				})
			: old,
	);
	const { client } = renderWithQuery(<DashboardBackfill {...props} />);
	await screen.findByText(/Waiting to update latest statistics/);
	await act(async () => {
		resolveOld({ job: null });
		await old;
	});
	expect(client.getQueryData(["dashboard-backfill", "a1"])).toMatchObject({
		job: { status: "queued", automatic: true },
	});
});
it("does not publish an old account POST after switching accounts", async () => {
	let resolveOld: (value: unknown) => void = () => {};
	fetcher.mockImplementation(async (_url, init) =>
		init?.method === "POST" && JSON.parse(init.body).accountId === "a1"
			? new Promise((resolve) => {
					resolveOld = resolve;
				})
			: { job: null },
	);
	const view = renderWithQuery(<DashboardBackfill {...props} />);
	await waitFor(() => expect(posts()).toHaveLength(1));
	view.rerender(<DashboardBackfill {...props} accountId="a2" />);
	await waitFor(() => expect(posts()).toHaveLength(2));
	await act(async () => {
		resolveOld({ job: active });
	});
	expect(view.client.getQueryData(["dashboard-backfill", "a2"])).toEqual({
		job: null,
	});
	expect(
		view.client.getQueryData(["dashboard-backfill", "a1"]),
	).not.toMatchObject({ job: { status: "running" } });
});

it("does not publish pending results or POST again after losing the write role", async () => {
	let resolveOld: (value: unknown) => void = () => {};
	fetcher.mockImplementation(async (_url, init) =>
		init?.method === "POST"
			? new Promise((resolve) => {
					resolveOld = resolve;
				})
			: { job: null },
	);
	const view = renderWithQuery(<DashboardBackfill {...props} />);
	await waitFor(() => expect(posts()).toHaveLength(1));
	allowed.mockReturnValue(false);
	view.rerender(<DashboardBackfill {...props} />);
	await act(async () => {
		resolveOld({ job: active });
	});
	fireEvent.focus(window);
	expect(posts()).toHaveLength(1);
	expect(
		view.client.getQueryData(["dashboard-backfill", "a1"]),
	).not.toMatchObject({ job: { status: "running" } });
});
it("keeps a failed automatic job visible and waits for explicit retry instead of a focus loop", async () => {
	fetcher.mockImplementation(async (_url, init) => ({
		job:
			init?.method === "POST"
				? { ...active, automatic: true, status: "failed" }
				: null,
	}));
	renderWithQuery(<DashboardBackfill {...props} />);
	await screen.findByRole("alert");
	fireEvent.focus(window);
	await act(async () => {});
	expect(posts()).toHaveLength(1);
	expect(
		screen.getByRole("button", { name: "Retry latest statistics" }),
	).toBeEnabled();
});
it("polls an active automatic job through completion, invalidates usage, and performs one fresh noop check", async () => {
	let posted = false;
	fetcher.mockImplementation(async (_url, init) => {
		if (init?.method === "POST") {
			const result = {
				job: posted ? null : { ...active, automatic: true, status: "queued" },
			};
			posted = true;
			return result;
		}
		return {
			job: posted ? { ...active, automatic: true, status: "completed" } : null,
		};
	});
	const { client } = renderWithQuery(<DashboardBackfill {...props} />);
	const invalidate = vi.spyOn(client, "invalidateQueries");
	await screen.findByText(/Waiting to update latest statistics/);
	await waitFor(() => expect(posts()).toHaveLength(2), { timeout: 3500 });
	expect(client.getQueryData(["dashboard-backfill", "a1"])).toEqual({
		job: null,
	});
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: ["dashboard-usage", "a1"],
	});
});

it("refreshes a cached usage snapshot when the automatic request confirms statistics are already fresh", async () => {
	let finishFresh: (value: unknown) => void = () => {};
	fetcher.mockImplementation(async (_url, init) =>
		init?.method === "POST"
			? new Promise((resolve) => {
					finishFresh = resolve;
				})
			: { job: null },
	);
	const { client } = renderWithQuery(<DashboardBackfill {...props} />);
	await waitFor(() => expect(posts()).toHaveLength(1));
	const usageKey = ["dashboard-usage", "a1", "2026-10-01", "2026-10-16", ""];
	client.setQueryData(usageKey, {
		coverage: { missingDays: 1 },
		marker: "old snapshot",
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	await act(async () => {
		finishFresh({ job: null });
	});
	await waitFor(() =>
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["dashboard-usage", "a1"],
		}),
	);
	expect(client.getQueryState(usageKey)?.isInvalidated).toBe(true);
});

function PendingUsageView() {
	const usage = useQuery<{ marker: string }>({
		queryKey: ["dashboard-usage", "a1", "2026-10-01", "2026-10-16", ""],
		queryFn: ({ signal }) =>
			fetcher("/api/dashboard/usage?accountId=a1", { signal }),
		staleTime: 5 * 60 * 1000,
	});
	return <p>{usage.data?.marker ?? "Initial statistics pending"}</p>;
}
it("starts a fresh usage read after an automatic noop even while the first uncached GET is unresolved", async () => {
	let finishInitial: (value: unknown) => void = () => {};
	let finishAutomatic: (value: unknown) => void = () => {};
	const initial = new Promise((resolve) => {
		finishInitial = resolve;
	});
	const automatic = new Promise((resolve) => {
		finishAutomatic = resolve;
	});
	let reads = 0;
	fetcher.mockImplementation((url, init) => {
		if (url.startsWith("/api/dashboard/usage?"))
			return ++reads === 1
				? initial
				: Promise.resolve({ marker: "Fresh statistics snapshot" });
		return init?.method === "POST" ? automatic : Promise.resolve({ job: null });
	});
	const { client } = renderWithQuery(
		<>
			<PendingUsageView />
			<DashboardBackfill {...props} />
		</>,
	);
	await waitFor(() => expect(posts()).toHaveLength(1));
	expect(
		client.getQueryData([
			"dashboard-usage",
			"a1",
			"2026-10-01",
			"2026-10-16",
			"",
		]),
	).toBeUndefined();
	await act(async () => {
		finishAutomatic({ job: null });
	});
	await act(async () => {
		finishInitial({ marker: "Stale statistics snapshot" });
		await initial;
	});
	await waitFor(() => expect(reads).toBe(2), { timeout: 500 });
	expect(
		await screen.findByText("Fresh statistics snapshot"),
	).toBeInTheDocument();
	expect(screen.queryByText("Stale statistics snapshot")).toBeNull();
});
it("refreshes an unresolved initial usage read when a viewer observes an automatic job completing", async () => {
	allowed.mockReturnValue(false);
	let finishInitial: (value: unknown) => void = () => {};
	const initial = new Promise((resolve) => {
		finishInitial = resolve;
	});
	let reads = 0;
	fetcher.mockImplementation((url) =>
		url.startsWith("/api/dashboard/usage?")
			? ++reads === 1
				? initial
				: Promise.resolve({ marker: "Fresh statistics snapshot" })
			: Promise.resolve({ job: { ...active, automatic: true } }),
	);
	const { client } = renderWithQuery(
		<>
			<PendingUsageView />
			<DashboardBackfill {...props} />
		</>,
	);
	await screen.findByText(/Updating latest statistics/);
	const invalidate = vi.spyOn(client, "invalidateQueries");
	act(() =>
		client.setQueryData(["dashboard-backfill", "a1"], {
			job: { ...active, automatic: true, status: "completed" },
		}),
	);
	await waitFor(() =>
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["dashboard-usage", "a1"],
		}),
	);
	await act(async () => {
		finishInitial({ marker: "Stale statistics snapshot" });
		await initial;
	});
	await waitFor(() => expect(reads).toBe(2), { timeout: 500 });
	expect(
		await screen.findByText("Fresh statistics snapshot"),
	).toBeInTheDocument();
	expect(screen.queryByText("Stale statistics snapshot")).toBeNull();
	expect(posts()).toHaveLength(0);
});
