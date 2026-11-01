import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { CloudAccountForm } from "./cloud-account-form";

describe("CloudAccountForm integration secrets", () => {
	it("gives masked AWS keys a no-save hint and submits them unchanged", async () => {
		const onSubmit = vi.fn();
		render(
			<CloudAccountForm
				provider="aws"
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.click(
			screen.getByText(
				"Advanced (legacy) — static access keys, deprecated by Bitmovin",
			),
		);
		fireEvent.change(screen.getByLabelText("AWS account number"), {
			target: { value: "123456789012" },
		});
		for (const [label, value] of [
			["Access key", "aws-access"],
			["Secret key", "aws-secret"],
		]) {
			const input = screen.getByLabelText(label);
			expect(input).toHaveValue("");
			expect(input).toHaveAttribute("type", "password");
			expect(input).toHaveAttribute("autocomplete", "one-time-code");
			expect(input.closest("form")).toHaveAttribute("autocomplete", "off");
			fireEvent.change(input, { target: { value } });
		}
		fireEvent.click(screen.getByRole("button", { name: "Create account" }));
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({
				accountNumber: "123456789012",
				accessKey: "aws-access",
				secretKey: "aws-secret",
			}),
		);
	});

	it("gives the masked Akamai token a no-save hint while retaining its value", async () => {
		const onSubmit = vi.fn();
		render(
			<CloudAccountForm
				provider="akamai"
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		const input = screen.getByLabelText("API token");
		expect(input).toHaveValue("");
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveAttribute("autocomplete", "one-time-code");
		expect(input.closest("form")).toHaveAttribute("autocomplete", "off");
		fireEvent.change(input, { target: { value: "akamai-token" } });
		fireEvent.click(screen.getByRole("button", { name: "Create account" }));
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({ apiToken: "akamai-token" }),
		);
	});
});
