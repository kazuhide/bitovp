import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { LiveWizard } from "./live-wizard";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
