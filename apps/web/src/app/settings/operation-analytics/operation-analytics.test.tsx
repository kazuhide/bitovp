import { act, screen, within } from "@testing-library/react";
import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import type { OperationAnalyticsWeek } from "@/lib/operation-analytics";
import { renderWithQuery } from "@/test/render";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/lib/auth/use-session", () => ({ useSession: mocks.session }));
vi.mock("recharts", async (original) => ({
	...(await original<typeof import("recharts")>()),
	ResponsiveContainer: ({ children }: { children: ReactNode }) =>
		isValidElement(children)
			? cloneElement(
					children as ReactElement<{ width: number; height: number }>,
					{
						width: 640,
						height: 224,
					},
				)
			: children,
}));

import { OperationAnalytics } from "./operation-analytics";

const organizationId = "00000000-0000-4000-8000-000000000123";
const empty: OperationAnalyticsWeek = {
	weekStart: "2026-11-16",
	isPartial: true,
	started: 0,
	firstFrame: 0,
	failed: 0,
	canceled: 0,
	unconfirmed: 0,
	pending: 0,
	firstFrameShare: null,
	p50Ms: null,
	p95Ms: null,
};

function session(overrides: Partial<SessionDto> = {}) {
	mocks.session.mockReturnValue({
		status: "success",
		isSuccess: true,
		isPending: false,
		data: {
			mode: "users",
			authenticated: true,
			configured: true,
			loginKind: "password-form",
			organizationId,
			role: "ADMIN",
			...overrides,
		} satisfies SessionDto,
	});
}

describe("OperationAnalytics", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		session();
	});

	it("shows paused history, the first-frame ratio and a measured zero distinctly from an empty week", async () => {
		mocks.apiFetch.mockResolvedValue({
			isCollecting: false,
			weeks: [
				{
					...empty,
					weekStart: "2026-11-09",
					isPartial: false,
					started: 5,
					firstFrame: 1,
					failed: 1,
					canceled: 1,
					unconfirmed: 1,
					pending: 1,
					firstFrameShare: 0.25,
					p50Ms: 0,
					p95Ms: 0,
				},
				empty,
			],
		});
		renderWithQuery(<OperationAnalytics />);

		const table = await screen.findByRole("table", {
			name: "Weekly MoQ playback data",
		});
		expect(screen.getByText("Collection paused")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Collection settings" }),
		).toHaveAttribute("href", "/settings/features#feat-operation-analytics");
		expect(
			screen.getByRole("heading", { name: "Playback attempts" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Time to first frame" }),
		).toBeInTheDocument();
		const [, measuredWeek, emptyWeek] = within(table).getAllByRole("row");
		if (!measuredWeek || !emptyWeek) throw new Error("Expected two dated rows");
		expect(within(measuredWeek).getByText("25%")).toBeInTheDocument();
		expect(within(measuredWeek).getByText("(1/4)")).toBeInTheDocument();
		expect(
			within(measuredWeek).getAllByRole("cell", { name: "0 ms" }),
		).toHaveLength(2);
		expect(within(emptyWeek).getAllByRole("cell", { name: "—" })).toHaveLength(
			3,
		);
		expect(within(emptyWeek).getByText("In progress")).toBeInTheDocument();
		expect(mocks.apiFetch).toHaveBeenCalledExactlyOnceWith(
			"/api/operation-analytics",
			{
				cache: "no-store",
				headers: { "x-bitovp-expected-org": organizationId },
				signal: expect.any(AbortSignal),
			},
		);
	});

	it("loads the Main report for a single-owner session and labels an empty period in Japanese", async () => {
		session({ mode: "password", organizationId: undefined, role: undefined });
		mocks.apiFetch.mockResolvedValue({ isCollecting: true, weeks: [empty] });
		renderWithQuery(<OperationAnalytics />, "ja");

		expect(
			await screen.findByText("この期間に記録された試行はありません。"),
		).toBeInTheDocument();
		expect(screen.getByText("計測中")).toBeInTheDocument();
		expect(
			screen.getByRole("table", { name: "MoQ再生の週次集計" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "再生試行" }),
		).not.toBeInTheDocument();
	});

	it("replaces cached data with the report error state when a refresh fails", async () => {
		mocks.apiFetch.mockResolvedValue({ isCollecting: true, weeks: [empty] });
		const { client } = renderWithQuery(<OperationAnalytics />);
		expect(await screen.findByText("Collecting")).toBeInTheDocument();

		mocks.apiFetch.mockRejectedValue(new Error("Settings read failed"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["operation-analytics"] });
		});

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not load operation analytics.",
		);
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
		expect(screen.queryByText("Collection paused")).not.toBeInTheDocument();
		expect(screen.queryByText("Collecting")).not.toBeInTheDocument();
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
	});
});
