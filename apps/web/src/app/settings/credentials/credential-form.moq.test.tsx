import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import { CredentialForm } from "./credential-form";
import { PROVIDER_CONFIG_SUMMARY } from "./provider-fields";

describe("MoQ credential form", () => {
	it.each([
		false,
		true,
	])("keeps the relay and optional authentication encrypted (token=%s)", async (withToken) => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);
		await user.selectOptions(screen.getByLabelText("Provider"), "MOQ");
		await user.type(screen.getByLabelText("Label"), "MoQ evaluation");
		const relay = screen.getByLabelText("MoQ relay URL");
		expect(relay).toHaveAttribute("type", "password");
		await user.type(relay, "moqt://relay.example.com:443");
		if (withToken) {
			const token = screen.getByLabelText("Authorization token (optional)");
			expect(token).toHaveAttribute("type", "password");
			await user.type(token, "publish-secret");
			await user.type(screen.getByLabelText("Token type (optional)"), "0");
		}
		await user.click(screen.getByRole("button", { name: "Create credential" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			provider: "MOQ",
			label: "MoQ evaluation",
			config: {},
			secret: {
				relayUrl: "moqt://relay.example.com:443",
				...(withToken ? { authToken: "publish-secret", authTokenType: 0 } : {}),
			},
		});
	});

	it("rejects a token type without a token", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);
		await user.selectOptions(screen.getByLabelText("Provider"), "MOQ");
		await user.type(screen.getByLabelText("Label"), "MoQ evaluation");
		await user.type(
			screen.getByLabelText("MoQ relay URL"),
			"moqt://relay.example.com:443",
		);
		await user.type(screen.getByLabelText("Token type (optional)"), "1");
		await user.click(screen.getByRole("button", { name: "Create credential" }));
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not show encrypted relay details in the readable credential summary", () => {
		expect(
			PROVIDER_CONFIG_SUMMARY.MOQ({
				relayUrl: "moqt://private.example.com:443",
				authToken: "do-not-display",
			}),
		).toBe("MoQ relay");
	});

	it("preserves the existing relay secret when only its label is edited", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(
			<CredentialForm
				credential={{
					id: "00000000-0000-4000-8000-000000000002",
					provider: "MOQ",
					label: "MoQ evaluation",
					config: {},
					hasSecret: true,
					createdAt: "2026-11-17T00:00:00.000Z",
					updatedAt: "2026-11-17T00:00:00.000Z",
				}}
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		expect(screen.queryByLabelText("MoQ relay URL")).toBeNull();
		await user.clear(screen.getByLabelText("Label"));
		await user.type(screen.getByLabelText("Label"), "Renamed MoQ evaluation");
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			label: "Renamed MoQ evaluation",
			config: {},
		});
	});
});
