import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { LiveCostEstimate } from "./live-cost-estimate";

/**
 *  PR3 — the estimate line renders REAL arithmetic from a REAL
 * schema-parsed plan (the ladder-panel lesson), the no-card path is a
 * sentence not a number, and the ja render goes through the catalogue.
 */

const PLAN = liveChannelPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../packages/core/src/live/__fixtures__/live-esam-full.plan.json",
			),
			"utf8",
		),
	),
);

const ladderHeight = Math.max(
	...PLAN.renditions
		.map((r) => ("height" in r ? (r.height ?? null) : null))
		.filter((h): h is number => h !== null),
);

const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000b1";
const CARD = {
	currency: "USD",
	liveRates: [{ maxHeight: Math.max(1080, ladderHeight), perHour: 6 }],
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("LiveCostEstimate", () => {
	it("renders the arithmetic for the default minutes from the stored card", async () => {
		apiFetch.mockResolvedValue({ defaults: { rateCard: CARD } });
		renderWithQuery(
			<LiveCostEstimate
				plan={PLAN}
				bitmovinAccountId={ACCOUNT_ID}
				defaultMinutes={90}
			/>,
		);
		// 6/h × 90m = 9 — the number is derived, not asserted-by-copy.
		expect(await screen.findByText(/≈ 9 USD \(6 USD\/h/)).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/bitmovin-accounts/${ACCOUNT_ID}`,
		);
		// Assumptions are RENDERED, not hidden.
		expect(screen.getByText(/encoding minutes only/)).toBeInTheDocument();
	});

	it("recomputes when the minutes change", async () => {
		apiFetch.mockResolvedValue({ defaults: { rateCard: CARD } });
		renderWithQuery(
			<LiveCostEstimate
				plan={PLAN}
				bitmovinAccountId={ACCOUNT_ID}
				defaultMinutes={60}
			/>,
		);
		await screen.findByText(/≈ 6 USD/);
		const input = screen.getByLabelText("Minutes");
		await userEvent.clear(input);
		await userEvent.type(input, "120");
		expect(await screen.findByText(/≈ 12 USD/)).toBeInTheDocument();
	});

	it("no stored card ⇒ the configured sentence, never a number", async () => {
		apiFetch.mockResolvedValue({ defaults: {} });
		renderWithQuery(
			<LiveCostEstimate
				plan={PLAN}
				bitmovinAccountId={ACCOUNT_ID}
				defaultMinutes={60}
			/>,
		);
		expect(
			await screen.findByText(/No rate card configured/),
		).toBeInTheDocument();
		expect(screen.queryByText(/≈/)).toBeNull();
	});

	it("a ladder above every tier names both heights", async () => {
		apiFetch.mockResolvedValue({
			defaults: {
				rateCard: {
					currency: "USD",
					liveRates: [{ maxHeight: ladderHeight - 1, perHour: 3 }],
				},
			},
		});
		renderWithQuery(
			<LiveCostEstimate
				plan={PLAN}
				bitmovinAccountId={ACCOUNT_ID}
				defaultMinutes={60}
			/>,
		);
		expect(
			await screen.findByText(
				new RegExp(`\\(${ladderHeight}p\\).*max ${ladderHeight - 1}p`),
			),
		).toBeInTheDocument();
	});

	it("renders Japanese through the catalogue", async () => {
		apiFetch.mockResolvedValue({ defaults: {} });
		renderWithQuery(
			<LiveCostEstimate
				plan={PLAN}
				bitmovinAccountId={ACCOUNT_ID}
				defaultMinutes={60}
			/>,
			"ja",
		);
		expect(
			await screen.findByText(/料金カードが未設定です/),
		).toBeInTheDocument();
	});
});
