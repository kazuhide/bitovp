import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { OutputCompareClient } from "./output-compare-client";
import { outputFormats, parseOutputJobIds } from "./output-selection";

const apiFetch = vi.fn();
let search = new URLSearchParams();
const replace = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useSearchParams: () => search,
	useRouter: () => ({ replace }),
}));
vi.mock("../jobs/[id]/playback-surface", () => ({
	PlaybackSurface: ({ url }: { url: string }) => (
		<div data-testid="output-surface" data-url={url} />
	),
}));
const left = "11111111-1111-4111-8111-111111111111";
const right = "22222222-2222-4222-8222-222222222222";
const link = (key: string, kind = "HLS") => ({
	key,
	kind,
	label: key,
	path: key,
	url: `https://media.example.test/${key}`,
	via: "PUBLIC",
});
beforeEach(() => {
	vi.clearAllMocks();
	search = new URLSearchParams({ jobs: `${left},${right}` });
	apiFetch.mockImplementation(async (url: string) => ({
		id: url.split("/").at(-1),
		name: url.endsWith(left) ? "Left encoding" : "Right encoding",
		status: "FINISHED",
		plan: {},
		playbackLinks: [link("hls"), link("dash", "DASH")],
	}));
});

it("loads the two existing authenticated job details and honors output keys in the URL", async () => {
	search.set("left", "dash");
	renderWithQuery(<OutputCompareClient />);
	await waitFor(() =>
		expect(screen.getAllByTestId("output-surface")).toHaveLength(2),
	);
	expect(apiFetch).toHaveBeenCalledWith(`/api/encoding-jobs/${left}`);
	expect(apiFetch).toHaveBeenCalledWith(`/api/encoding-jobs/${right}`);
	expect(
		screen
			.getAllByTestId("output-surface")
			.map((video) => video.getAttribute("data-url")),
	).toEqual([
		"https://media.example.test/dash",
		"https://media.example.test/hls",
	]);
	expect(
		screen.getAllByText("Output settings: Format not specified"),
	).toHaveLength(2);
});

it.each([
	"",
	left,
	`${left},${left}`,
	`${left},invalid`,
	`${left},${right},${left}`,
])("rejects ambiguous two-job URL state without fetching: %s", (raw) => {
	search = new URLSearchParams({ jobs: raw });
	renderWithQuery(<OutputCompareClient />);
	expect(screen.getByText(/Select two finished jobs/)).toBeVisible();
	expect(apiFetch).not.toHaveBeenCalled();
});

it("preserves an unavailable explicit output instead of silently showing another stream", async () => {
	search.set("left", "deleted-manifest");
	renderWithQuery(<OutputCompareClient />);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"This output is unavailable",
	);
	expect(screen.queryByTestId("output-surface")).not.toBeInTheDocument();
});

it("offers recovery when either normal job read fails without starting a one-sided comparison", async () => {
	apiFetch.mockRejectedValue(new Error("not found"));
	renderWithQuery(<OutputCompareClient />);
	expect(await screen.findAllByText("Could not load this job.")).toHaveLength(
		2,
	);
	expect(screen.queryByTestId("output-surface")).not.toBeInTheDocument();
});

it("uses exact app job IDs and describes DV as output settings rather than verified display", () => {
	expect(parseOutputJobIds(`${left},${right}`)).toEqual([left, right]);
	const plan = JSON.parse(
		readFileSync(
			resolve(
				process.cwd(),
				"../../packages/core/src/plan/__fixtures__/av1-fmp4-dash-hls.plan.json",
			),
			"utf8",
		),
	);
	const rendition = plan.renditions.find(
		(value: { codec: string }) => value.codec === "AV1",
	);
	rendition.dynamicRangeFormat = "DOLBY_VISION_PROFILE_10_1";
	rendition.encodingMode = "THREE_PASS";
	expect(outputFormats(plan)).toContain("AV1 · Dolby Vision 10.1 · THREE_PASS");
	expect(outputFormats({})).toBe("");
});
