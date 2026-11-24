import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { createSubmissionClient } from "@/lib/creation-submission";
import { renderWithQuery } from "@/test/render";
import { buildLiveChannelPlan } from "./build-live-plan";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";
import { LiveWizard } from "./live-wizard";

const { apiFetch, push } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	push: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
});

it("shows the existing refusal when source conversion cannot rebuild an unresolved output", async () => {
	const id = "9f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
	const raw = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	raw.muxings[0].destination.outputKey = "missing-output";
	expect(liveChannelPlanSchema.safeParse(raw).success).toBe(true);
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/live-channels/${id}` ? { name: raw.name, plan: raw } : [],
	);
	renderWithQuery(<LiveWizard duplicateFrom={id} />);
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(screen.queryByRole("textbox", { name: /channel name/i })).toBeNull();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

it.each([
	"OPUS",
	"AV1",
	"H264",
] as const)("shows the existing refusal for a schema-valid unrepresented %s duplicate", async (codec) => {
	const id = "9f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
	const raw = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	raw.renditions = [
		{
			key: "unsupported",
			codec,
			ingestKey: codec === "OPUS" ? "audio" : "video",
			...(codec === "H264"
				? { height: 720, bitrate: null }
				: {
						bitrate: 128000,
						...(codec === "OPUS" ? { rate: 48000 } : { height: 720 }),
					}),
		},
	];
	raw.muxings = [
		{
			key: "unsupported",
			kind: "FMP4",
			streamKey: "unsupported",
			destination: { outputKey: "origin", path: "unsupported" },
		},
	];
	expect(liveChannelPlanSchema.safeParse(raw).success).toBe(true);
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/live-channels/${id}` ? { name: raw.name, plan: raw } : [],
	);
	renderWithQuery(<LiveWizard duplicateFrom={id} />);
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(screen.queryByRole("textbox", { name: /channel name/i })).toBeNull();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

it.each([
	"",
	"invalid",
])("fails closed for malformed source %j", async (source) => {
	apiFetch.mockResolvedValue([]);
	renderWithQuery(<LiveWizard duplicateFrom={source} />);
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(screen.queryByRole("textbox", { name: /channel name/i })).toBeNull();
	expect(
		apiFetch.mock.calls.some(([url]) => url.startsWith("/api/live-channels/")),
	).toBe(false);
});

it("loads a channel into editable fields without creation and keeps edits on cache refresh", async () => {
	const id = "9f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
	const plan = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/live-channels/${id}` ? { name: plan.name, plan } : [],
	);
	const view = renderWithQuery(<LiveWizard duplicateFrom={id} />);
	const name = await screen.findByRole("textbox", { name: /channel name/i });
	expect(name).toHaveValue(plan.name);
	fireEvent.change(name, { target: { value: "Edited live copy" } });
	await act(async () => {
		view.client.setQueryData(["live-channel-duplicate", id], {
			name: "Changed source",
			plan: { ...plan, name: "Changed source" },
		});
	});
	expect(name).toHaveValue("Edited live copy");
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

const sourceChannelId = "70c37149-8ccc-4b3d-bc64-0fa06e49e82b";
const newChannelId = "fb801929-e7a4-450d-876e-69bf643eaaa0";
const credentialId = "eee3c000-00e3-4aaa-8aaa-000000000aaa";
const fixtureAccountId = "5a6ad9b8-2cae-4485-a0b3-99130b771be5";
const relayFolder =
	"InterBEE 2026 / Akamai Osaka / OBS RTMP → Cloudflare MoQ/fixture-run";

function moqCopyPlan(kind: "FMP4" | "CMAF") {
	const plan = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	plan.name = "RTMP to MoQ";
	plan.bitmovin = {
		accountId: fixtureAccountId,
		cloudRegion: "AKAMAI_JP_OSA",
		encoderVersion: "2.294.0",
		labels: ["moq-example"],
	};
	plan.liveInput = {
		key: "contribution",
		kind: "REDUNDANT_RTMP",
		name: "Primary RTMP input",
		ingestPoints: [{ applicationName: "live", streamKey: "ExampleStream" }],
	};
	plan.outputs = [
		{
			key: "relay",
			kind: "MOQ",
			name: "Sample MoQ relay",
			credentialId,
			draftVersion: "DRAFT_16",
			trackNamespace: ["sample-broadcast"],
		},
	];
	plan.renditions = [
		{
			...plan.renditions[1],
			bitrate: 2_500_000,
			rate: 30,
			presetConfiguration: "LIVE_LOW_LATENCY",
			minGop: 30,
			maxGop: 30,
			rcLookahead: 1,
			bframes: 0,
			openGop: false,
			sceneCutThreshold: 0,
		},
		plan.renditions[3],
	];
	plan.muxings = [
		{
			...plan.muxings[1],
			kind,
			segmentLength: kind === "CMAF" ? 0.5 : 1,
			...(kind === "CMAF" ? { framesPerCmafChunk: 3 } : {}),
			destination: { outputKey: "relay", path: `${relayFolder}/video/720p` },
		},
		{
			...plan.muxings[3],
			kind,
			segmentLength: kind === "CMAF" ? 0.5 : 1,
			destination: { outputKey: "relay", path: `${relayFolder}/audio/128000` },
		},
	];
	plan.liveManifests = [];
	plan.start = {
		encodingOption: "CUSTOM",
		streamKey: "ExampleStream",
		autoRestart: { restartOnEncoderError: false },
		autoShutdown: {
			bytesReadTimeoutSeconds: 60,
			streamTimeoutMinutes: 10,
			waitingForFirstConnectTimeoutMinutes: 10,
		},
	};
	return plan;
}

function mockMoqCopy(plan: ReturnType<typeof moqCopyPlan>) {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === `/api/live-channels/${sourceChannelId}`)
			return { name: plan.name, plan };
		if (url === "/api/auth/session")
			return {
				mode: "users",
				configured: true,
				authenticated: true,
				role: "OPERATOR",
				effectiveUserId: "user",
				organizationId: "org",
			};
		if (url === "/api/credentials")
			return [{ id: credentialId, label: "Test relay", provider: "MOQ" }];
		if (url === "/api/bitmovin-accounts")
			return [{ id: fixtureAccountId, label: "Test Bitmovin account" }];
		if (url.startsWith("/api/live-channels/moq-readiness?"))
			return url.includes("namespaceComponents=2")
				? { status: "publisher-only", issues: ["namespace-unsupported"] }
				: { status: "ready", issues: [] };
		if (url === "/api/live-channels") return { id: newChannelId };
		return [];
	});
}

it.each([
	"FMP4",
	"CMAF",
] as const)("copies a %s MoQ channel into the wizard and preserves its settings on creation", async (kind) => {
	const plan = moqCopyPlan(kind);
	expect(
		validateLiveChannel(liveChannelPlanSchema.parse(plan)).filter(
			(issue) => issue.level === "error",
		),
	).toEqual([]);
	mockMoqCopy(plan);
	renderWithQuery(<LiveWizard duplicateFrom={sourceChannelId} />);
	const name = await screen.findByRole("textbox", { name: "Channel name" });
	expect(name).toHaveValue(plan.name);
	expect(screen.queryByRole("button", { name: "Edit JSON" })).toBeNull();
	fireEvent.change(name, { target: { value: "" } });
	fireEvent.change(name, { target: { value: "Edited MoQ channel" } });
	fireEvent.click(screen.getByRole("button", { name: "3. Ladder" }));
	const audioBitrate = screen
		.getAllByLabelText<HTMLInputElement>("Bitrate (bps)")
		.find((input) => input.value === "128000");
	if (!audioBitrate) throw new Error("Missing copied audio bitrate");
	fireEvent.change(audioBitrate, { target: { value: "96000" } });
	fireEvent.click(screen.getByRole("button", { name: "4. Output" }));
	expect(screen.getByRole("combobox", { name: "Credential" })).toHaveValue(
		credentialId,
	);
	const draft = screen.getByRole("combobox", { name: "MoQT draft" });
	expect(draft).toHaveValue("DRAFT_16");
	fireEvent.change(draft, { target: { value: "DRAFT_18" } });
	const namespace = screen.getByRole("textbox", { name: "Track namespace" });
	expect(namespace).toHaveValue("sample-broadcast");
	fireEvent.change(namespace, { target: { value: "edited-broadcast\nwide" } });
	fireEvent.click(screen.getByRole("button", { name: "9. Review" }));
	const create = screen.getByRole("button", {
		name: "Create live channel",
	});
	await waitFor(() => expect(create).toBeEnabled());
	expect(await screen.findByText("Publishing only")).toBeInTheDocument();
	const readiness = new URLSearchParams({
		credentialId,
		draftVersion: "DRAFT_18",
		namespaceComponents: "2",
	});
	expect(apiFetch).toHaveBeenCalledWith(
		`/api/live-channels/moq-readiness?${readiness}`,
		expect.objectContaining({ cache: "no-store" }),
	);

	const writes = () =>
		apiFetch.mock.calls.filter(([, init]) =>
			["POST", "PATCH", "PUT", "DELETE"].includes(init?.method),
		);
	expect(writes()).toHaveLength(0);
	fireEvent.click(create);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(`/live/${newChannelId}`),
	);
	expect(writes()).toEqual([
		[
			"/api/live-channels",
			expect.objectContaining({
				method: "POST",
				body: expect.any(String),
			}),
		],
	]);
	const submitted = JSON.parse(writes()[0]?.[1].body).plan;
	expect(liveChannelPlanSchema.parse(submitted)).toEqual(
		liveChannelPlanSchema.parse({
			...plan,
			name: "Edited MoQ channel",
			renditions: [
				plan.renditions[0],
				{ ...plan.renditions[1], bitrate: 96000 },
			],
			outputs: [
				{
					...plan.outputs[0],
					draftVersion: "DRAFT_18",
					trackNamespace: ["edited-broadcast", "wide"],
				},
			],
		}),
	);
});

it.each([
	["FMP4", 0],
	["CMAF", 1],
] as const)("copies a single-track %s MoQ channel without adding renditions", (kind, index) => {
	const plan = moqCopyPlan(kind);
	plan.renditions = [plan.renditions[index]];
	plan.muxings = [plan.muxings[index]];
	plan.ingest = [plan.ingest[index]];
	const parsed = liveChannelPlanSchema.parse(plan);
	expect(
		validateLiveChannel(parsed).filter((issue) => issue.level === "error"),
	).toEqual([]);
	const copy = tryImportLiveChannelIntoWizard(plan);
	if (!copy.ok) throw Error(copy.reasonKey);
	expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(copy.state))).toEqual(
		parsed,
	);
});

it.each([
	"channel copy",
	"JSON import",
] as const)("reuses the pending expert request after loading through %s", async (entry) => {
	const plan = moqCopyPlan("FMP4");
	const duplicateFrom = entry === "channel copy" ? sourceChannelId : undefined;
	const lostResponse =
		vi.fn<(path: string, init: RequestInit) => Promise<unknown>>();
	lostResponse.mockRejectedValue(new Error("Connection closed after creation"));
	const legacy = createSubmissionClient(
		["org", "user", "live", `wizard:${duplicateFrom ?? "new"}`],
		{ storage: sessionStorage, send: lostResponse },
	);
	await expect(legacy.submit({ plan })).rejects.toThrow(
		"Connection closed after creation",
	);

	mockMoqCopy(plan);
	renderWithQuery(<LiveWizard duplicateFrom={duplicateFrom} />);
	if (entry === "JSON import") {
		fireEvent.click(
			await screen.findByRole("button", { name: /Import plan JSON/i }),
		);
		fireEvent.change(screen.getByLabelText("Live channel plan JSON"), {
			target: { value: JSON.stringify(plan) },
		});
		fireEvent.click(screen.getByRole("button", { name: "Load plan" }));
	}
	expect(
		await screen.findByRole("textbox", { name: "Channel name" }),
	).toHaveValue(plan.name);
	fireEvent.click(screen.getByRole("button", { name: "9. Review" }));
	const create = screen.getByRole("button", { name: "Create live channel" });
	await waitFor(() => expect(create).toBeEnabled());
	fireEvent.click(create);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(`/live/${newChannelId}`),
	);
	const posts = apiFetch.mock.calls.filter(
		([, init]) => init?.method === "POST",
	);
	expect(posts).toEqual([lostResponse.mock.calls[0]]);
});

it("does not expose a blank editable form while copying or after a source failure", async () => {
	let reject!: (error: Error) => void;
	apiFetch.mockImplementation((url: string) =>
		url.startsWith("/api/live-channels/")
			? new Promise((_resolve, fail) => {
					reject = fail;
				})
			: Promise.resolve([]),
	);
	renderWithQuery(
		<LiveWizard duplicateFrom="9f8edfe4-fc30-4a9a-89e3-a3e89d5245df" />,
	);
	expect(screen.queryByRole("textbox", { name: /channel name/i })).toBeNull();
	await act(async () => reject(new Error("not found")));
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(screen.queryByRole("textbox", { name: /channel name/i })).toBeNull();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

// The UI must carry the name update through to the emitted plan, including
// copied output prefixes; custom paths stay exact.
it.each([
	false,
	true,
])("renames generated paths and preserves manual paths (custom=%s)", async (custom) => {
	const id = "9f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
	const plan = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	plan.name = "live-rtmp-simple";
	if (custom) {
		for (const manifest of plan.liveManifests)
			manifest.destination.path = "output/manual-live";
		for (const muxing of plan.muxings)
			muxing.destination.path = muxing.destination.path.replace(
				"output/live-rtmp-simple",
				"output/manual-live",
			);
	}
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/live-channels/${id}` ? { name: plan.name, plan } : [],
	);
	renderWithQuery(<LiveWizard duplicateFrom={id} />);
	const name = await screen.findByRole("textbox", { name: "Channel name" });
	fireEvent.change(name, { target: { value: "renamed-live" } });
	fireEvent.click(screen.getByRole("button", { name: "Plan JSON" }));
	const exported = JSON.parse(
		screen.getByText(
			(text, element) =>
				element?.tagName === "PRE" && text.includes('"liveManifests"'),
		).textContent ?? "{}",
	);
	expect(exported.liveManifests[0].destination.path).toBe(
		custom ? "output/manual-live" : "output/renamed-live",
	);
	expect(exported.muxings[0].destination.path).toBe(
		custom
			? "output/manual-live/video/1080p"
			: "output/renamed-live/video/1080p",
	);
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});
