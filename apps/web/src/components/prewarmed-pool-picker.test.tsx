import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { PrewarmedPoolPicker } from "./prewarmed-pool-picker";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

/** Controlled harness mirroring the form's csv state. */
function Harness({
	accountId,
	initial = "",
}: {
	accountId?: string;
	initial?: string;
}) {
	const [csv, setCsv] = useState(initial);
	return (
		<>
			<PrewarmedPoolPicker accountId={accountId} csv={csv} onChange={setCsv} />
			<output data-testid="csv">{csv}</output>
		</>
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("PrewarmedPoolPicker", () => {
	it("lists the account's pools and toggles ids into the csv", async () => {
		apiFetch.mockResolvedValue({
			totalCount: 1,
			items: [
				{
					id: POOL_ID,
					name: "evening-rush",
					cloudRegion: "AWS_EU_WEST_1",
					status: "STARTED",
				},
			],
		});
		const user = userEvent.setup();
		wrap(<Harness accountId={ACCOUNT_ID} />);

		expect(apiFetch).toHaveBeenCalledWith(
			`/api/infrastructure/prewarmed-pools?bitmovinAccountId=${ACCOUNT_ID}&limit=100`,
		);
		const checkbox = await screen.findByRole("checkbox", {
			name: /evening-rush/,
		});
		await user.click(checkbox);
		expect(screen.getByTestId("csv").textContent).toBe(POOL_ID);
		await user.click(checkbox);
		expect(screen.getByTestId("csv").textContent).toBe("");
	});

	it("adds a manual pool id (other-org fallback) as a removable chip", async () => {
		apiFetch.mockResolvedValue({ totalCount: 0, items: [] });
		const user = userEvent.setup();
		wrap(<Harness accountId={ACCOUNT_ID} />);
		await screen.findByText(/No pools in this account/);

		await user.type(
			screen.getByLabelText("Add pool id manually"),
			"other-org-pool",
		);
		await user.click(screen.getByRole("button", { name: "Add id" }));
		expect(screen.getByTestId("csv").textContent).toBe("other-org-pool");

		await user.click(
			screen.getByRole("button", { name: "Remove pool other-org-pool" }),
		);
		expect(screen.getByTestId("csv").textContent).toBe("");
	});

	it("create mode (no account id yet): manual input only, no fetch", () => {
		wrap(<Harness initial="pre-existing-id" />);
		expect(apiFetch).not.toHaveBeenCalled();
		expect(
			screen.getByText(/Save the account first to pick from its pools/),
		).toBeInTheDocument();
		// existing csv ids still render as removable chips.
		expect(
			screen.getByRole("button", { name: "Remove pool pre-existing-id" }),
		).toBeInTheDocument();
	});
});
