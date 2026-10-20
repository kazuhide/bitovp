import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

import { BitmovinForm } from "./bitmovin-form";

const onSubmit = vi.fn();

/**
 * review-84b C1/I2/I3: this form had ZERO tests, and that is exactly why an
 * unrelated Settings save silently destroyed the operator's rate card — the
 * textarea was the one defaults field not hydrated, so the save omitted the
 * key and the wholesale defaults replace dropped it. These pin the WHOLE
 * survival chain: hydration → untouched save round-trips the card.
 */

const ACCOUNT = {
	id: "00000000-0000-4000-8000-00000000000a",
	label: "prod",
	tenantOrgId: null,
	createdAt: "2026-08-01T00:00:00.000Z",
	updatedAt: "2026-08-01T00:00:00.000Z",
	defaults: {
		encoderVersion: "STABLE",
		cloudRegion: "AWS_EU_WEST_1",
		rateCard: {
			currency: "USD",
			liveRates: [{ maxHeight: 1080, perHour: 3.0 }],
		},
	},
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("BitmovinForm API key entry", () => {
	it("keeps native secret protection while hinting against automatic password saving", () => {
		wrap(<BitmovinForm submitting={false} onSubmit={onSubmit} />);
		const input = screen.getByLabelText("API key");
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveAttribute("autocomplete", "one-time-code");
		expect(input).toHaveAttribute("autocapitalize", "none");
		expect(input).toHaveAttribute("spellcheck", "false");
	});

	it("keeps native text editing and submits the entered key through form registration", async () => {
		const user = userEvent.setup();
		wrap(<BitmovinForm submitting={false} onSubmit={onSubmit} />);
		await user.type(screen.getByLabelText("Label"), "Test account");
		await user.type(screen.getByLabelText("API key"), "not-a-real-api-key");
		await user.keyboard("{Home}{Delete}");
		await user.click(screen.getByRole("button", { name: "Add account" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit.mock.calls[0]?.[0].apiKey).toBe("ot-a-real-api-key");
	});

	it("uses a blank native password field for key rotation without changing stored account defaults", async () => {
		wrap(
			<BitmovinForm account={ACCOUNT} submitting={false} onSubmit={onSubmit} />,
		);
		expect(screen.queryByLabelText("API key")).toBeNull();
		fireEvent.click(screen.getByLabelText("Rotate API key"));
		const input = screen.getByLabelText("API key");
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveAttribute("autocomplete", "one-time-code");
		expect(input).toHaveValue("");
		fireEvent.change(input, {
			target: { value: "not-a-real-replacement-key" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
			apiKey: "not-a-real-replacement-key",
			defaults: { cloudRegion: "AWS_EU_WEST_1", encoderVersion: "STABLE" },
		});
	});

	it("retains the label, keyboard focus, validation description and disabled state", async () => {
		const view = wrap(<BitmovinForm submitting={false} onSubmit={onSubmit} />);
		const input = screen.getByLabelText("API key");
		input.focus();
		expect(input).toHaveFocus();
		fireEvent.change(screen.getByLabelText("Label"), {
			target: { value: "Test account" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add account" }));
		await waitFor(() => expect(input).toHaveAccessibleDescription(/required/i));
		expect(onSubmit).not.toHaveBeenCalled();
		view.rerender(<BitmovinForm submitting onSubmit={onSubmit} />);
		expect(screen.getByLabelText("API key")).toBe(input);
		expect(input).toBeDisabled();
	});
});

describe("BitmovinForm — rate card survival (review-84b C1)", () => {
	it("hydrates the stored card into the textarea on edit", () => {
		wrap(
			<BitmovinForm account={ACCOUNT} submitting={false} onSubmit={onSubmit} />,
		);
		const textarea = screen.getByLabelText(
			"Live rate card (JSON)",
		) as HTMLTextAreaElement;
		expect(textarea.value).toContain('"currency": "USD"');
		expect(textarea.value).toContain('"maxHeight": 1080');
	});

	it("an UNTOUCHED save round-trips the card — the silent-wipe chain is closed", async () => {
		wrap(
			<BitmovinForm account={ACCOUNT} submitting={false} onSubmit={onSubmit} />,
		);
		// The reviewer's probe: edit ONLY the label, save.
		fireEvent.change(screen.getByLabelText("Label"), {
			target: { value: "prod-renamed" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => {
			expect(onSubmit).toHaveBeenCalled();
		});
		const payload = onSubmit.mock.calls[0]?.[0] as {
			defaults: { rateCard?: { currency: string } };
		};
		expect(payload).not.toHaveProperty("apiKey");
		expect(payload.defaults.rateCard).toBeDefined();
		expect(payload.defaults.rateCard?.currency).toBe("USD");
	});

	it("EMPTYING the textarea deletes the card as an explicit act", async () => {
		wrap(
			<BitmovinForm account={ACCOUNT} submitting={false} onSubmit={onSubmit} />,
		);
		fireEvent.change(screen.getByLabelText("Live rate card (JSON)"), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => {
			expect(onSubmit).toHaveBeenCalled();
		});
		const payload = onSubmit.mock.calls[0]?.[0] as {
			defaults: Record<string, unknown>;
		};
		expect("rateCard" in payload.defaults).toBe(false);
	});

	it("invalid JSON fails the save visibly and posts nothing", async () => {
		wrap(
			<BitmovinForm account={ACCOUNT} submitting={false} onSubmit={onSubmit} />,
		);
		fireEvent.change(screen.getByLabelText("Live rate card (JSON)"), {
			target: { value: "{not json" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => {
			expect(screen.getByText(/JSON/i)).toBeInTheDocument();
		});
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("BitmovinForm region choices", () => {
	it("keeps the fallback select mounted and focused when its value changes", () => {
		wrap(
			<BitmovinForm
				account={{
					...ACCOUNT,
					defaults: { ...ACCOUNT.defaults, fallbackRegions: ["AWS_US_EAST_1"] },
				}}
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		const select = screen.getByLabelText(/Fallback regions.*1$/);
		select.focus();
		expect(select).toHaveFocus();
		fireEvent.change(select, { target: { value: "AWS_US_WEST_2" } });
		expect(screen.getByLabelText(/Fallback regions.*1$/)).toBe(select);
		expect(select).toHaveValue("AWS_US_WEST_2");
		expect(select).toHaveFocus();
	});
	it("uses enum choices and submits ordered fallback regions", async () => {
		wrap(
			<BitmovinForm
				account={{
					...ACCOUNT,
					defaults: {
						...ACCOUNT.defaults,
						fallbackRegions: ["AWS_US_EAST_1", "AWS_EU_WEST_1"],
					},
				}}
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		expect(screen.queryByLabelText("Default cloud region")).toBeNull();
		expect(screen.queryByLabelText("Encoder version")).toBeNull();
		const fallbacks = screen.getAllByLabelText(/Fallback regions.*[12]$/);
		expect(fallbacks).toHaveLength(2);
		fireEvent.change(fallbacks[0] as HTMLElement, {
			target: { value: "AWS_US_WEST_2" },
		});
		fireEvent.change(screen.getByLabelText(/^Fallback regions[^0-9]*$/), {
			target: { value: "GOOGLE_EUROPE_WEST_1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		expect(onSubmit.mock.calls[0]?.[0].defaults).toMatchObject({
			cloudRegion: "AWS_EU_WEST_1",
			fallbackRegions: [
				"AWS_US_WEST_2",
				"AWS_EU_WEST_1",
				"GOOGLE_EUROPE_WEST_1",
			],
		});
	});
	it("preserves stored unknown regions until explicitly removed", async () => {
		wrap(
			<BitmovinForm
				account={{
					...ACCOUNT,
					defaults: {
						...ACCOUNT.defaults,
						cloudRegion: "FUTURE_REGION",
						fallbackRegions: ["FUTURE_FALLBACK", "AWS_EU_WEST_1"],
					},
				}}
				submitting={false}
				onSubmit={onSubmit}
			/>,
		);
		expect(screen.queryByLabelText("Default cloud region")).toBeNull();
		expect(screen.getAllByLabelText(/Fallback regions.*[12]$/)[0]).toHaveValue(
			"FUTURE_FALLBACK",
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Remove FUTURE_FALLBACK" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		expect(onSubmit.mock.calls[0]?.[0].defaults).toMatchObject({
			cloudRegion: "FUTURE_REGION",
			fallbackRegions: ["AWS_EU_WEST_1"],
		});
	});
});

it("preserves a pinned version and region while renaming an account", async () => {
	wrap(
		<BitmovinForm
			account={{
				...ACCOUNT,
				defaults: {
					...ACCOUNT.defaults,
					encoderVersion: "2.325.0",
					cloudRegion: "FUTURE_REGION",
				},
			}}
			submitting={false}
			onSubmit={onSubmit}
		/>,
	);
	expect(screen.queryByLabelText("Encoder version")).toBeNull();
	expect(screen.queryByLabelText("Default cloud region")).toBeNull();
	fireEvent.change(screen.getByLabelText("Label"), {
		target: { value: "renamed" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
	await waitFor(() => expect(onSubmit).toHaveBeenCalled());
	expect(onSubmit.mock.calls[0]?.[0].defaults).toMatchObject({
		encoderVersion: "2.325.0",
		cloudRegion: "FUTURE_REGION",
	});
});

it("creates an account without choosing job-specific defaults", async () => {
	wrap(<BitmovinForm submitting={false} onSubmit={onSubmit} />);
	expect(screen.queryByLabelText("Encoder version")).toBeNull();
	expect(screen.queryByLabelText("Default cloud region")).toBeNull();
	fireEvent.change(screen.getByLabelText("Label"), {
		target: { value: "new" },
	});
	fireEvent.change(screen.getByLabelText("API key"), {
		target: { value: "test-key-1234567890" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Add account" }));
	await waitFor(() => expect(onSubmit).toHaveBeenCalled());
	expect(onSubmit.mock.calls[0]?.[0].defaults.encoderVersion).toBe("STABLE");
	expect(onSubmit.mock.calls[0]?.[0].defaults.cloudRegion).toBe("AUTO");
});
