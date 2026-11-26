import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { OutputCompareClient, OutputComparison } from "./output-compare-client";
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
const third = "33333333-3333-4333-8333-333333333333";
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

it("loads three distinct outputs and preserves a separate center selection", async () => {
	search = new URLSearchParams({
		jobs: `${left},${right},${third}`,
		center: "dash",
	});
	renderWithQuery(<OutputCompareClient />);
	await waitFor(() =>
		expect(screen.getAllByTestId("output-surface")).toHaveLength(3),
	);
	expect(screen.getByLabelText("Output Center")).toHaveValue("dash");
	expect(screen.getByLabelText("Output Right")).toHaveValue("hls");
	expect(apiFetch).toHaveBeenCalledWith(`/api/encoding-jobs/${third}`);
});

it("keeps report IDs and the Lab route when an embedded output selection changes", async () => {
	search = new URLSearchParams({ jobs: "qc-a,qc-b,qc-c" });
	renderWithQuery(
		<OutputComparison jobIds={[left, right, third]} path="/qc/compare" />,
	);
	await waitFor(() =>
		expect(screen.getAllByTestId("output-surface")).toHaveLength(3),
	);
	fireEvent.change(screen.getByLabelText("Output Center"), {
		target: { value: "dash" },
	});
	expect(replace).toHaveBeenCalledWith(
		"/qc/compare?jobs=qc-a%2Cqc-b%2Cqc-c&center=dash",
	);
});

it.each([
	"",
	left,
	`${left},${left}`,
	`${left},invalid`,
	`${left},${right},${left}`,
	`${left},${right},${third},44444444-4444-4444-8444-444444444444`,
])("rejects ambiguous two-job URL state without fetching: %s", (raw) => {
	search = new URLSearchParams({ jobs: raw });
	renderWithQuery(<OutputCompareClient />);
	expect(screen.getByText(/Select two or three finished jobs/)).toBeVisible();
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
	expect(
		outputFormats({
			...plan,
			ingest: [{ ...plan.ingest[0], inputPath: "" }],
			withheldSourcePaths: [
				[{ collection: "ingest", index: 0, field: "inputPath" }],
			],
		}),
	).toContain("AV1 · Dolby Vision 10.1 · THREE_PASS");
	expect(
		outputFormats({
			renditions: [
				{
					codec: "H264",
					dynamicRangeFormat: "private-fixture",
					encodingMode: "private-fixture",
				},
			],
		}),
	).toBe("H.264");
	expect(outputFormats({})).toBe("");
});
