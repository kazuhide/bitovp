import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ProviderResources } from "./provider-resources";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch,
}));

it("reads measurements only after selecting Output information and resets to details for another muxing", async () => {
	const endpoint = "/api/encoding-jobs/job/resources";
	apiFetch.mockImplementation(async (url: string) => {
		const query = new URL(url, "http://fixture.invalid").searchParams;
		if (!query.size)
			return {
				canManage: false,
				canRemove: false,
				resources: [
					{
						step: "muxing:wav",
						id: "recorded-wav",
						attempt: 2,
						hasList: true,
						hasInformation: true,
					},
					{
						step: "muxing:webm",
						id: "recorded-webm",
						attempt: 0,
						hasList: true,
					},
				],
			};
		if (query.get("view") === "information")
			return { fields: { fileSizeBytes: 0, containerBitrateBps: 64000 } };
		return {
			fields: {
				id:
					query.get("step") === "muxing:wav" ? "recorded-wav" : "recorded-webm",
			},
		};
	});
	const user = userEvent.setup();
	renderWithQuery(<ProviderResources endpoint={endpoint} />);
	await user.click(screen.getByText("Inspect provider resources"));
	const options = await screen.findByRole("combobox", { name: "Resource" });
	await user.selectOptions(
		options,
		screen.getByRole("option", { name: "muxing:wav · recorded-wav" }),
	);
	expect(await screen.findByText("recorded-wav")).toBeVisible();
	expect(apiFetch).toHaveBeenCalledTimes(2);
	await user.click(screen.getByRole("button", { name: "Output information" }));
	expect(await screen.findByText("Size (bytes)")).toBeVisible();
	expect(screen.getByText("0")).toBeVisible();
	expect(screen.queryByText("Duration (seconds)")).not.toBeInTheDocument();
	expect(apiFetch).toHaveBeenLastCalledWith(
		`${endpoint}?step=muxing%3Awav&attempt=2&view=information&offset=0`,
		expect.objectContaining({ signal: expect.anything() }),
	);
	await user.selectOptions(
		options,
		screen.getByRole("option", { name: "muxing:webm · recorded-webm" }),
	);
	expect(await screen.findByText("recorded-webm")).toBeVisible();
	expect(
		screen.queryByRole("button", { name: "Output information" }),
	).not.toBeInTheDocument();
});

it("loads a selected provider diagnostic and pages the original stream", async () => {
	const endpoint = "/api/encoding-jobs/job/resources";
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url: string) => {
		const query = new URL(url, "http://fixture.invalid").searchParams;
		if (!query.size)
			return {
				canManage: false,
				canRemove: false,
				resources: [
					{
						step: "stream:video",
						id: "recorded-video",
						attempt: 2,
						diagnostics: [
							{
								key: "psnr",
								label: "Provider PSNR",
								labelJa: "BitmovinのPSNR",
							},
						],
					},
				],
			};
		if (query.get("view") === "diagnostic")
			return {
				items:
					query.get("offset") === "25"
						? [{ id: "30:40", fromSeconds: 30, toSeconds: 40, psnrDb: 46 }]
						: [{ id: "0:10", fromSeconds: 0, toSeconds: 10, psnrDb: 39 }],
				total: 26,
			};
		return { fields: { id: "recorded-video" } };
	});
	const user = userEvent.setup();
	renderWithQuery(<ProviderResources endpoint={endpoint} />);
	await user.click(screen.getByText("Inspect provider resources"));
	await user.selectOptions(
		await screen.findByRole("combobox", { name: "Resource" }),
		screen.getByRole("option", { name: "stream:video · recorded-video" }),
	);
	expect(await screen.findByText("recorded-video")).toBeVisible();
	expect(apiFetch).toHaveBeenCalledTimes(2);

	await user.selectOptions(
		screen.getByRole("combobox", { name: "Diagnostics" }),
		"psnr",
	);
	expect(await screen.findByText("39")).toBeVisible();
	await user.click(screen.getByRole("button", { name: "Next page" }));
	expect(await screen.findByText("46")).toBeVisible();
	expect(apiFetch).toHaveBeenLastCalledWith(
		`${endpoint}?step=stream%3Avideo&attempt=2&view=diagnostic&diagnostic=psnr&offset=25`,
		expect.objectContaining({ signal: expect.anything() }),
	);
});
