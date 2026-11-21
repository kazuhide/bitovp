import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
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
beforeEach(() => vi.clearAllMocks());

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

it("copies an MoQ plan as editable JSON and preserves its settings on explicit creation", async () => {
	const id = "70c37149-8ccc-4b3d-bc64-0fa06e49e82b";
	const newChannelId = "fb801929-e7a4-450d-876e-69bf643eaaa0";
	const credentialId = "eee3c000-00e3-4aaa-8aaa-000000000aaa";
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
		accountId: "5a6ad9b8-2cae-4485-a0b3-99130b771be5",
		cloudRegion: "AKAMAI_JP_OSA",
		encoderVersion: "BETA",
		labels: ["moq-example"],
	};
	plan.liveInput = {
		key: "primary",
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
	plan.renditions = [plan.renditions[1], plan.renditions[3]];
	plan.muxings = [
		{
			...plan.muxings[1],
			segmentLength: 1,
			destination: { outputKey: "relay", path: "test/video" },
		},
		{
			...plan.muxings[3],
			segmentLength: 1,
			destination: { outputKey: "relay", path: "test/audio" },
		},
	];
	plan.liveManifests = [];
	plan.start = { encodingOption: "CUSTOM", streamKey: "ExampleStream" };
	expect(
		validateLiveChannel(liveChannelPlanSchema.parse(plan)).filter(
			(issue) => issue.level === "error",
		),
	).toEqual([]);

	apiFetch.mockImplementation(async (url: string) => {
		if (url === `/api/live-channels/${id}`) return { name: plan.name, plan };
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
			return [{ id: credentialId, provider: "MOQ" }];
		if (url.startsWith("/api/live-channels/moq-readiness?"))
			return { status: "ready", issues: [] };
		if (url === "/api/live-channels") return { id: newChannelId };
		return [];
	});
	renderWithQuery(<LiveWizard duplicateFrom={id} />);
	fireEvent.click(await screen.findByRole("button", { name: "Edit JSON" }));
	const editor = screen.getByLabelText("Live channel plan JSON");
	expect(editor).toHaveValue(JSON.stringify(plan, null, 2));
	expect(screen.queryByRole("textbox", { name: "Channel name" })).toBeNull();
	expect(
		screen.queryByRole("button", { name: "Create channel (imported plan)" }),
	).toBeNull();
	const edited = { ...plan, name: "Edited MoQ channel" };
	fireEvent.change(editor, { target: { value: JSON.stringify(edited) } });
	fireEvent.click(screen.getByRole("button", { name: "Load plan" }));
	const create = await screen.findByRole("button", {
		name: "Create channel (imported plan)",
	});
	await waitFor(() => expect(create).toBeEnabled());

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
	expect(JSON.parse(writes()[0]?.[1].body)).toEqual({ plan: edited });
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
