import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ExperimentsClient } from "./experiments-client";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api")>()),
	apiFetch,
}));

const root = "/api/encoding-experiments/v1";
const id = "11111111-1111-4111-8111-111111111111";
const campaign = {
	id,
	name: "Day one",
	state: "RUNNING",
	sealed: false,
	statusCounts: {},
};
const source = { id: "source1", label: "Training sample" };
const capability = {
	available: true,
	capabilityId: "a".repeat(64),
	gpuName: "GPU fixture",
	supportedCodecs: ["H264", "HEVC", "AV1"],
	scoringProfileId: "official-vmaf-cuda-0.6.1",
};

let role: "VIEWER" | "OPERATOR";
beforeEach(() => {
	role = "OPERATOR";
	apiFetch
		.mockReset()
		.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/auth/session")
				return { configured: true, authenticated: true, mode: "users", role };
			if (url === `${root}/capabilities`) return capability;
			if (url === `${root}/sources`)
				return { items: [source], nextCursor: null };
			if (url === `${root}/campaigns`)
				return { items: [campaign], nextCursor: null };
			if (url === `${root}/campaigns/${id}`) return campaign;
			if (url === `${root}/campaigns/${id}/trials`)
				return init?.method === "POST"
					? { items: [], nextCursor: null }
					: {
							items: [
								{
									id: "trial-1",
									status: "SUCCEEDED",
									input: {
										codec: "HEVC",
										sourceId: source.id,
										window: {
											timeBase: { num: 1, den: 30 },
											startPts: "0",
											endPtsExclusive: "60",
										},
									},
									result: {
										meanVmaf: 91.2,
										videoBytes: "1000000",
										durationTicks: "2",
										timeBase: { num: 1, den: 1 },
										encodeMs: 123,
									},
								},
							],
							nextCursor: null,
						};
			if (url === `${root}/campaigns/${id}/select`)
				return {
					status: "selected",
					trialId: "trial-1",
					eligibleCount: 1,
					incompleteCount: 0,
				};
			throw Error(url);
		});
});

it("shows measured values to viewers and does not offer write controls", async () => {
	role = "VIEWER";
	renderWithQuery(<ExperimentsClient />);
	expect(await screen.findByText("91.20")).toBeInTheDocument();
	expect(screen.getByText("4.00 Mb/s")).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Queue trial" })).toBeNull();
});

it("queues a typed trial selected from the organization's registered sources", async () => {
	renderWithQuery(<ExperimentsClient />);
	await userEvent.selectOptions(
		await screen.findByLabelText("Registered source"),
		source.id,
	);
	await userEvent.click(screen.getByRole("button", { name: "Queue trial" }));
	await waitFor(() => {
		const call = apiFetch.mock.calls.find(
			([url, init]) =>
				url === `${root}/campaigns/${id}/trials` && init?.method === "POST",
		);
		expect(call?.[1]).toMatchObject({
			headers: { "Idempotency-Key": expect.any(String) },
		});
		expect(JSON.parse(call?.[1].body)).toMatchObject({
			schemaVersion: 1,
			trials: [{ sourceId: source.id, codec: "HEVC" }],
		});
	});
});

it("asks the Lean selector to evaluate the chosen measured source window", async () => {
	renderWithQuery(<ExperimentsClient />);
	const cap = await screen.findByLabelText("Bitrate ceiling (bps)");
	await userEvent.type(cap, "4500000");
	await userEvent.click(
		screen.getByRole("button", { name: "Select best quality" }),
	);
	expect(await screen.findByText("Selected trial trial-1")).toBeInTheDocument();
	const call = apiFetch.mock.calls.find(
		([url]) => url === `${root}/campaigns/${id}/select`,
	);
	expect(JSON.parse(call?.[1].body)).toEqual({
		schemaVersion: 1,
		sourceId: source.id,
		window: {
			timeBase: { num: 1, den: 30 },
			startPts: "0",
			endPtsExclusive: "60",
		},
		constraints: { bitrateLimitBps: 4500000 },
	});
});
