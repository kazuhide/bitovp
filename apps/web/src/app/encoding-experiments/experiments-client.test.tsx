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
	capabilityId: "a".repeat(64),
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

const v1Profile = "bitovp-vmaf-cuda-1.0.16-3d0h";
const v1Descriptor = {
	scoringProfileId: v1Profile,
	scorerSha256: "b".repeat(64),
	modelSha256: "c".repeat(64),
	sourceSha256: "d".repeat(64),
	officialRevision: "e".repeat(40),
	decoderRuntimeSha256: "f".repeat(64),
};
let role: "VIEWER" | "OPERATOR";
let hasV1: boolean;
let hasSdk: boolean;
let workerOnline: boolean;
let v1Status: "succeeded" | "failed" | undefined;
beforeEach(() => {
	role = "OPERATOR";
	hasV1 = false;
	hasSdk = false;
	workerOnline = true;
	v1Status = undefined;
	apiFetch
		.mockReset()
		.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/auth/session")
				return { configured: true, authenticated: true, mode: "users", role };
			const additionalScoringProfiles = hasV1 ? [v1Descriptor] : undefined;
			if (url === `${root}/capabilities`)
				return workerOnline
					? {
							...capability,
							additionalScoringProfiles,
							...(hasSdk && {
								nvencSdk: { version: "13.0", catalogSha256: "b".repeat(64) },
							}),
						}
					: { available: false };
			if (url === `${root}/catalog`)
				return {
					sdkBindings: [
						{
							field: "NV_ENC_RC_PARAMS.enableAQ",
							phase: "session",
							type: "boolean",
							minimum: 0,
							maximum: 1,
							codecs: ["HEVC", "H264", "AV1"],
						},
						{
							field: "NV_ENC_PIC_PARAMS.encodePicFlags",
							phase: "picture",
							type: "integer",
							minimum: 0,
							maximum: 7,
							codecs: ["HEVC", "H264", "AV1"],
						},
					],
				};
			if (url === `${root}/sources`)
				return { items: [source], nextCursor: null };
			if (url === `${root}/campaigns`)
				return { items: [campaign], nextCursor: null };
			if (url === `${root}/campaigns/${id}`)
				return { ...campaign, runtime: { additionalScoringProfiles } };
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
										...(v1Status
											? { additionalScoringProfiles: [v1Profile] }
											: {}),
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
										...(v1Status === "succeeded"
											? {
													additionalScores: [
														{
															scoringProfileId: v1Profile,
															status: v1Status,
															meanVmaf: 87.25,
														},
													],
												}
											: v1Status === "failed"
												? {
														additionalScores: [
															{
																scoringProfileId: v1Profile,
																status: v1Status,
																failureCode: "VMAF_V1_SCORE_FAILED",
															},
														],
													}
												: {}),
									},
								},
							],
							nextCursor: null,
						};
			if (url === `${root}/campaigns/${id}/select`)
				return {
					status: "selected",
					trialId: "trial-1",
					scoringProfileId:
						JSON.parse(String(init?.body)).scoringProfileId ??
						capability.scoringProfileId,
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

it("sets catalog-backed SDK session and picture values in the queued trial", async () => {
	hasSdk = true;
	renderWithQuery(<ExperimentsClient />);
	await userEvent.selectOptions(
		await screen.findByLabelText("Registered source"),
		source.id,
	);
	expect(apiFetch.mock.calls.some(([url]) => url === `${root}/catalog`)).toBe(
		false,
	);
	await userEvent.click(await screen.findByText("NVENC settings"));
	await userEvent.selectOptions(
		await screen.findByLabelText("Setting"),
		"NV_ENC_RC_PARAMS.enableAQ",
	);
	await userEvent.selectOptions(screen.getByLabelText("Value"), "false");
	await userEvent.click(screen.getByRole("button", { name: "Apply setting" }));
	await userEvent.selectOptions(
		screen.getByLabelText("Setting"),
		"NV_ENC_PIC_PARAMS.encodePicFlags",
	);
	await userEvent.type(screen.getByLabelText("Value"), "2");
	expect(screen.getByLabelText("Frame index (zero-based)")).toHaveValue(0);
	await userEvent.click(screen.getByRole("button", { name: "Apply setting" }));
	await userEvent.click(screen.getByRole("button", { name: "Queue trial" }));
	await waitFor(() => {
		const request = apiFetch.mock.calls.find(
			([url, init]) =>
				url === `${root}/campaigns/${id}/trials` && init?.method === "POST",
		);
		expect(JSON.parse(String(request?.[1]?.body)).trials[0].sdk).toEqual({
			version: "13.0",
			session: { "NV_ENC_RC_PARAMS.enableAQ": false },
			pictures: [
				{ frameIndex: 0, fields: { "NV_ENC_PIC_PARAMS.encodePicFlags": 2 } },
			],
		});
	});
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

it("opts in to dual measurements in the editable trial request", async () => {
	hasV1 = true;
	renderWithQuery(<ExperimentsClient />);
	await userEvent.selectOptions(
		await screen.findByLabelText("Registered source"),
		source.id,
	);
	await userEvent.click(
		await screen.findByRole("checkbox", { name: "Also measure VMAF v1.0.16" }),
	);
	const editor = screen.getByLabelText(
		"Trial configuration (JSON)",
	) as HTMLTextAreaElement;
	expect(JSON.parse(editor.value)).toMatchObject({
		sourceId: source.id,
		codec: "HEVC",
		additionalScoringProfiles: [v1Profile],
	});
	await userEvent.click(screen.getByRole("button", { name: "Queue trial" }));
	const call = apiFetch.mock.calls.find(
		([url, init]) =>
			url === `${root}/campaigns/${id}/trials` && init?.method === "POST",
	);
	expect(JSON.parse(call?.[1].body)).toMatchObject({
		schemaVersion: 1,
		trials: [
			{
				sourceId: source.id,
				codec: "HEVC",
				additionalScoringProfiles: [v1Profile],
			},
		],
	});
});

it("reads both scores and selects v1 on a historical campaign when its runtime is offline", async () => {
	hasV1 = true;
	workerOnline = false;
	v1Status = "succeeded";
	renderWithQuery(<ExperimentsClient />);
	expect(await screen.findByText("87.25")).toBeInTheDocument();
	expect(screen.getByText("91.20")).toBeInTheDocument();
	await userEvent.selectOptions(
		await screen.findByLabelText("Quality scoring profile"),
		v1Profile,
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Select best quality" }),
	);
	expect(await screen.findByText("Selected trial trial-1")).toBeInTheDocument();
	const call = apiFetch.mock.calls.find(
		([url]) => url === `${root}/campaigns/${id}/select`,
	);
	expect(JSON.parse(call?.[1].body)).toMatchObject({
		scoringProfileId: v1Profile,
	});
});

it("shows an independent v1 measurement failure while retaining the primary score", async () => {
	hasV1 = true;
	v1Status = "failed";
	role = "VIEWER";
	renderWithQuery(<ExperimentsClient />);
	expect(await screen.findByText("VMAF_V1_SCORE_FAILED")).toBeInTheDocument();
	expect(screen.getByText("91.20")).toBeInTheDocument();
});
