import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { VmafLabClient } from "./vmaf-lab-client";

afterEach(() => vi.resetAllMocks());
function setup(profiles: unknown[]) {
	apiFetch.mockImplementation(
		async (url: string, options?: { method?: string }) => {
			if (options?.method === "POST") return { id: "created" };
			if (url === "/api/vmaf-compute-profiles") return { items: profiles };
			if (url.startsWith("/api/encoding-jobs"))
				return { items: [{ id: "finished-id", name: "Finished film" }] };
			return { items: [] };
		},
	);
}
it("defaults to local and never invents a cloud budget", async () => {
	setup([]);
	wrap(<VmafLabClient />);
	const user = userEvent.setup();
	await user.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByText(
		"No cloud profiles configured. Measurements run locally.",
	);
	await user.selectOptions(
		screen.getByLabelText("Finished job"),
		"finished-id",
	);
	expect(screen.queryByLabelText("Budget (USD)")).not.toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Measure" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/vmaf-jobs",
			expect.objectContaining({ method: "POST" }),
		),
	);
	const call = apiFetch.mock.calls.find(
		([, options]) => options?.method === "POST",
	);
	expect(JSON.parse(call?.[1].body).execution).toEqual({ backend: "LOCAL" });
});
it("requires an explicit budget for cloud and clears it when switching profiles", async () => {
	setup([{ id: "aws-test", label: "AWS test", region: "us-east-1" }]);
	wrap(<VmafLabClient />);
	const user = userEvent.setup();
	await user.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByRole("option", { name: "AWS test · us-east-1" });
	await user.selectOptions(
		screen.getByLabelText("Finished job"),
		"finished-id",
	);
	await user.selectOptions(screen.getByLabelText("Run on"), "aws-test");
	const submit = screen.getByRole("button", { name: "Measure" });
	expect(submit).toBeDisabled();
	await user.type(screen.getByLabelText("Budget (USD)"), "12.50");
	expect(submit).toBeEnabled();
	await user.click(submit);
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/vmaf-jobs",
			expect.objectContaining({ method: "POST" }),
		),
	);
	const call = apiFetch.mock.calls.find(
		([, options]) => options?.method === "POST",
	);
	expect(JSON.parse(call?.[1].body).execution).toEqual({
		backend: "CLOUD",
		profileId: "aws-test",
		budgetUsd: 12.5,
	});
	await user.selectOptions(screen.getByLabelText("Run on"), "");
	await user.selectOptions(screen.getByLabelText("Run on"), "aws-test");
	expect(screen.getByLabelText("Budget (USD)")).toHaveValue(null);
	expect(submit).toBeDisabled();
});
it("offers the same local-only explanation in Japanese", async () => {
	setup([]);
	wrap(<VmafLabClient />, "ja");
	await userEvent.click(
		screen.getByRole("button", { name: "既存ジョブを計測…" }),
	);
	expect(
		await screen.findByText("クラウド設定がないため、ローカルで計測します。"),
	).toBeInTheDocument();
	expect(screen.getByLabelText("実行先")).toHaveValue("");
});
it("can load older finished jobs from the next picker page", async () => {
	setup([]);
	apiFetch.mockImplementation(async (url: string) => {
		if (url.includes("cursor="))
			return { items: [{ id: "older", name: "Older film" }] };
		if (url.startsWith("/api/encoding-jobs"))
			return {
				items: [{ id: "recent", name: "Recent film" }],
				nextCursor: "next",
			};
		return { items: [] };
	});
	wrap(<VmafLabClient />);
	await userEvent.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByRole("option", { name: "Recent film" });
	await userEvent.click(screen.getByRole("button", { name: "Load more" }));
	await screen.findByRole("option", { name: "Older film" });
	await userEvent.selectOptions(screen.getByLabelText("Finished job"), "older");
	expect(screen.getByRole("button", { name: "Measure" })).toBeEnabled();
});
it("blocks a removed finished selection after refreshing the choices", async () => {
	setup([]);
	const { client } = wrap(<VmafLabClient />);
	await userEvent.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByRole("option", { name: "Finished film" });
	await userEvent.selectOptions(
		screen.getByLabelText("Finished job"),
		"finished-id",
	);
	client.setQueryData(["encoding-jobs", "finished-for-lab"], {
		pages: [{ items: [] }],
		pageParams: [""],
	});
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Measure" })).toBeDisabled(),
	);
});
it("links to the created report and clears the selected job after success", async () => {
	setup([]);
	wrap(<VmafLabClient />);
	await userEvent.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByRole("option", { name: "Finished film" });
	await userEvent.selectOptions(
		screen.getByLabelText("Finished job"),
		"finished-id",
	);
	await userEvent.click(screen.getByRole("button", { name: "Measure" }));
	expect(
		await screen.findByRole("link", {
			name: "Measurement created. View report",
		}),
	).toHaveAttribute("href", "/qc/created");
	expect(screen.getByRole("button", { name: "Measure" })).toBeDisabled();
});
it("distinguishes unavailable finished jobs from an empty list and retries the read", async () => {
	setup([]);
	const original = apiFetch.getMockImplementation();
	apiFetch.mockImplementation(async (url: string) => {
		if (url.startsWith("/api/encoding-jobs")) throw new Error("offline");
		return original?.(url);
	});
	wrap(<VmafLabClient />);
	await userEvent.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByText("Failed to load finished jobs.");
	expect(
		screen.queryByText("No finished jobs are available."),
	).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Measure" })).toBeDisabled();
	setup([]);
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	await screen.findByRole("option", { name: "Finished film" });
	expect(
		screen.queryByText("Failed to load finished jobs."),
	).not.toBeInTheDocument();
});
it("exposes a deleted cloud profile and requires choosing a valid execution target", async () => {
	setup([{ id: "gone", label: "Temporary cloud", region: "us-east-1" }]);
	const { client } = wrap(<VmafLabClient />);
	const user = userEvent.setup();
	await user.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByRole("option", { name: "Finished film" });
	await user.selectOptions(
		screen.getByLabelText("Finished job"),
		"finished-id",
	);
	await user.selectOptions(screen.getByLabelText("Run on"), "gone");
	await user.type(screen.getByLabelText("Budget (USD)"), "12");
	client.setQueryData(["vmaf-compute-profiles"], { items: [] });
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Measure" })).toBeDisabled(),
	);
	expect(screen.getByRole("alert")).toHaveTextContent(
		"The selected cloud profile is no longer available.",
	);
	expect(screen.getByLabelText("Run on")).toHaveValue("gone");
	await user.selectOptions(screen.getByLabelText("Run on"), "");
	expect(screen.getByRole("button", { name: "Measure" })).toBeEnabled();
});

async function openMeasurementOptions() {
	const user = userEvent.setup();
	setup([{ id: "aws-test", label: "AWS test", region: "us-east-1" }]);
	wrap(<VmafLabClient />);
	await user.click(
		screen.getByRole("button", { name: "Measure an existing job…" }),
	);
	await screen.findByRole("option", { name: "Finished film" });
	await user.selectOptions(
		screen.getByLabelText("Finished job"),
		"finished-id",
	);
	await user.click(screen.getByText("Measurement options"));
	return user;
}
function submittedMeasurement() {
	const call = apiFetch.mock.calls.find(
		([, options]) => options?.method === "POST",
	);
	return call ? JSON.parse(call[1].body) : undefined;
}
it("preserves automatic source and inherited PSNR when options are untouched", async () => {
	const user = await openMeasurementOptions();
	expect(screen.getByLabelText("Measurement source")).toHaveValue("");
	expect(screen.getByLabelText("PSNR")).toHaveValue("");
	expect(screen.queryByLabelText("Measurement method")).not.toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Measure" }));
	await waitFor(() => expect(submittedMeasurement()).toBeDefined());
	expect(submittedMeasurement()).not.toHaveProperty("source");
	expect(submittedMeasurement()).not.toHaveProperty("psnr");
	expect(submittedMeasurement()).not.toHaveProperty("measurementMethod");
});
it("submits explicit MP4, PSNR, and cloud frame-index selections", async () => {
	const user = await openMeasurementOptions();
	await user.selectOptions(
		screen.getByLabelText("Measurement source"),
		"OUTPUT_MP4",
	);
	expect(screen.queryByLabelText("Measurement method")).not.toBeInTheDocument();
	await user.selectOptions(screen.getByLabelText("PSNR"), "true");
	await user.selectOptions(screen.getByLabelText("Run on"), "aws-test");
	await user.type(screen.getByLabelText("Budget (USD)"), "12");
	await user.selectOptions(
		screen.getByLabelText("Measurement method"),
		"FRAME_INDEX_BT709_10BIT",
	);
	await user.click(screen.getByRole("button", { name: "Measure" }));
	await waitFor(() =>
		expect(submittedMeasurement()).toMatchObject({
			source: "OUTPUT_MP4",
			psnr: true,
			measurementMethod: "FRAME_INDEX_BT709_10BIT",
			execution: { backend: "CLOUD", profileId: "aws-test", budgetUsd: 12 },
		}),
	);
});
it.each([
	"source",
	"execution",
])("clears incompatible frame-index selection after changing %s", async (changed) => {
	const user = await openMeasurementOptions();
	await user.selectOptions(screen.getByLabelText("Run on"), "aws-test");
	expect(screen.queryByLabelText("Measurement method")).not.toBeInTheDocument();
	await user.selectOptions(
		screen.getByLabelText("Measurement source"),
		"OUTPUT_MP4",
	);
	await user.selectOptions(
		screen.getByLabelText("Measurement method"),
		"FRAME_INDEX_BT709_10BIT",
	);
	if (changed === "source") {
		await user.selectOptions(
			screen.getByLabelText("Measurement source"),
			"QC_MIRROR",
		);
	} else {
		await user.selectOptions(screen.getByLabelText("Run on"), "");
	}
	expect(screen.queryByLabelText("Measurement method")).not.toBeInTheDocument();
	if (changed === "source") {
		await user.selectOptions(
			screen.getByLabelText("Measurement source"),
			"OUTPUT_MP4",
		);
	} else {
		await user.selectOptions(screen.getByLabelText("Run on"), "aws-test");
	}
	expect(screen.getByLabelText("Measurement method")).toHaveValue("");
	await user.type(screen.getByLabelText("Budget (USD)"), "12");
	await user.selectOptions(screen.getByLabelText("PSNR"), "false");
	await user.click(screen.getByRole("button", { name: "Measure" }));
	await waitFor(() => expect(submittedMeasurement()).toBeDefined());
	expect(submittedMeasurement().psnr).toBe(false);
	expect(submittedMeasurement()).not.toHaveProperty("measurementMethod");
});
