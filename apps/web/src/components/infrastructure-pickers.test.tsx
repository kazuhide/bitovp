import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/**
 * 's pickers (review of PR #176, I3: the component shipped with no
 * co-located test while both siblings have one). Pins: the aggregate wire
 * shape renders as candidates with kind badges, the skipped banner names the
 * families, the static-ip picker requests the C6 limit and surfaces the
 * truncation (review I2's silent-25 defect), and the error branch names the
 * list that failed while paste stays usable.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
	InfrastructureIdPicker,
	StaticIpIdPicker,
} from "./infrastructure-pickers";

const ACCOUNT = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockResolvedValue({ items: [], skipped: [] });
});

describe("InfrastructureIdPicker", () => {
	it("renders candidates with kind badges and the skipped-families banner", async () => {
		apiFetch.mockResolvedValue({
			items: [{ id: "aws-1", name: "prod-vpc", kind: "AWS" }],
			skipped: ["OCI", "AKAMAI"],
		});
		renderWithQuery(
			<InfrastructureIdPicker
				inputId="t-infra"
				value=""
				onChange={vi.fn()}
				bitmovinAccountId={ACCOUNT}
			/>,
		);
		await screen.findByText("prod-vpc");
		expect(screen.getByText("AWS")).toBeInTheDocument();
		expect(screen.getByText(/OCI, AKAMAI/)).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/infrastructure/infrastructures?bitmovinAccountId=${ACCOUNT}`,
		);
	});

	it("does not fetch without an account, and paste still works", async () => {
		const onChange = vi.fn();
		renderWithQuery(
			<InfrastructureIdPicker
				inputId="t-infra"
				value=""
				onChange={onChange}
				bitmovinAccountId={undefined}
			/>,
		);
		expect(apiFetch).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("textbox"));
		await userEvent.paste("infra-pasted");
		expect(onChange).toHaveBeenCalledWith("infra-pasted");
	});

	it("a payload WITHOUT skipped renders candidates and no banner (review-178 O1)", async () => {
		// The unguarded `.length` blanked the entire wizard when a payload
		// omitted the field — observed live under a synthetic mock.
		apiFetch.mockResolvedValue({
			items: [{ id: "aws-1", name: "prod-vpc", kind: "AWS" }],
		});
		renderWithQuery(
			<InfrastructureIdPicker
				inputId="t-infra"
				value=""
				onChange={vi.fn()}
				bitmovinAccountId={ACCOUNT}
			/>,
		);
		await screen.findByText("prod-vpc");
		expect(screen.queryByText(/skipped|スキップ/)).toBeNull();
	});

	it("a failed list shows the named error and keeps the field usable", async () => {
		apiFetch.mockRejectedValue(new Error("boom"));
		renderWithQuery(
			<InfrastructureIdPicker
				inputId="t-infra"
				value=""
				onChange={vi.fn()}
				bitmovinAccountId={ACCOUNT}
			/>,
		);
		await screen.findByText(/Could not list infrastructures/);
		expect(screen.getByRole("textbox")).toBeEnabled();
	});
});

describe("StaticIpIdPicker", () => {
	it("requests the C6 limit and surfaces truncation from totalCount (review I2)", async () => {
		apiFetch.mockResolvedValue({
			items: [{ id: "ip-1", ipAddress: "203.0.113.5", status: "CREATED" }],
			totalCount: 140,
		});
		renderWithQuery(
			<StaticIpIdPicker
				inputId="t-ip"
				value=""
				onChange={vi.fn()}
				bitmovinAccountId={ACCOUNT}
			/>,
		);
		await screen.findByText("203.0.113.5");
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/infrastructure/static-ips?bitmovinAccountId=${ACCOUNT}&limit=100`,
		);
		// 140 total, 1 shown → the truncation banner must say so.
		await waitFor(() =>
			expect(screen.getByText(/1.*140|140.*1/)).toBeInTheDocument(),
		);
	});

	it("a COMPLETE list shows no truncation banner (review-176 R2)", async () => {
		// Their M12: `>= 0` in the condition would print "Showing 1 of 1" on a
		// complete list and nothing caught it.
		apiFetch.mockResolvedValue({
			items: [{ id: "ip-1", ipAddress: "203.0.113.5" }],
			totalCount: 1,
		});
		renderWithQuery(
			<StaticIpIdPicker
				inputId="t-ip"
				value=""
				onChange={vi.fn()}
				bitmovinAccountId={ACCOUNT}
			/>,
		);
		await screen.findByText("203.0.113.5");
		expect(screen.queryByText(/Showing|表示/)).toBeNull();
	});
});
