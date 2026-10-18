import { encodingPlanSchema, INTERNAL_HEVC_V2_BCF_VERSION } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import p1AudioCopy from "@/test/fixtures/p1-audio-copy.json";
import p1VideoCopy from "@/test/fixtures/p1-video-copy.json";
import { renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { CopyVodJob } from "./copy-job";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const replace = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace, push: vi.fn() }),
}));
const ID = "9f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
const ACCOUNT = "0f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
const CREDENTIAL = "1f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
const sourceState: WizardState = {
	...DEFAULT_WIZARD_STATE,
	name: "Copied source",
	accountId: ACCOUNT,
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: CREDENTIAL,
			bucket: "source",
			path: "input.mp4",
		},
	],
	output: {
		...DEFAULT_WIZARD_STATE.output,
		credentialId: CREDENTIAL,
		bucket: "output",
		basePath: "encoded",
	},
};
const plan = buildPlan(sourceState);
beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}` ? { name: "Copied source", plan } : [],
	);
});

it("prefills the wizard without creating a job and never overwrites edits on refetch", async () => {
	const view = renderWithQuery(<CopyVodJob source={ID} />);
	const name = await screen.findByRole("textbox", { name: /job name/i });
	expect(name).toHaveValue("Copied source");
	fireEvent.change(name, { target: { value: "My edited copy" } });
	await act(async () => {
		view.client.setQueryData(["encoding-job-copy", ID], {
			id: ID,
			plan: { ...plan, name: "Changed source" },
		});
	});
	expect(name).toHaveValue("My edited copy");
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

it("preserves the complete plan and credential/account references until explicit submission", async () => {
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	const start = screen.getByRole("button", { name: /Start encoding$/ });
	expect(start).toBeEnabled();
	fireEvent.click(start);
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const submission = apiFetch.mock.calls.find(
		([, value]) => value?.method === "POST",
	);
	if (!submission) throw new Error("Expected explicit job submission");
	const [, init] = submission;
	expect(encodingPlanSchema.parse(JSON.parse(init.body).plan)).toEqual(
		encodingPlanSchema.parse(plan),
	);
});

it("refuses a copy link combined with another plan source", async () => {
	renderWithQuery(<CopyVodJob source={ID} conflictingSource />);
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(apiFetch).not.toHaveBeenCalled();
});

it("repairs only stale Per-Title bitrate in a copied plan and explains it", async () => {
	const expected = buildPlan({
		...sourceState,
		videos: [
			{
				codec: "H264",
				height: 360,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE" },
			},
		],
		startOptions: {
			perTitle: {
				h264: {
					autoRepresentations: true,
					minBitrate: 200_000,
					maxBitrate: 4_000_000,
				},
			},
		},
		timing: "POST_ENCODING",
	});
	const stale = {
		...expected,
		renditions: expected.renditions.map((row, index) =>
			index === 0 ? { ...row, bitrate: 300_000 } : row,
		),
	};
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}` ? { plan: stale } : [],
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	expect(await screen.findByRole("textbox", { name: /job name/i })).toHaveValue(
		sourceState.name,
	);
	expect(
		screen.getByText(/cleared the incompatible fixed bitrate/i),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	fireEvent.click(screen.getByRole("button", { name: /Start encoding$/ }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
	if (!call) throw new Error("Expected explicit submission");
	expect(encodingPlanSchema.parse(JSON.parse(call[1].body).plan)).toEqual(
		encodingPlanSchema.parse(expected),
	);
	expect(stale.renditions[0]).toHaveProperty("bitrate", 300_000);
});

it.each([
	undefined,
	"",
	"not-an-id",
	[ID, ID],
])("fails closed for invalid source %j", async (source) => {
	renderWithQuery(<CopyVodJob source={source} />);
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(screen.queryByRole("textbox", { name: /job name/i })).toBeNull();
	expect(apiFetch).not.toHaveBeenCalled();
});

it("blocks the form while loading and after source retrieval fails", async () => {
	let fail!: (error: Error) => void;
	apiFetch.mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	expect(screen.queryByRole("textbox", { name: /job name/i })).toBeNull();
	await act(async () => fail(new Error("missing source")));
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(screen.queryByRole("textbox", { name: /job name/i })).toBeNull();
});

it("rejects a missing source plan instead of exposing the default form", async () => {
	apiFetch.mockResolvedValue({ name: "Missing plan" });
	renderWithQuery(<CopyVodJob source={ID} />);
	expect(await screen.findByRole("alert")).toBeInTheDocument();
	expect(screen.queryByRole("textbox", { name: /job name/i })).toBeNull();
});

it("preserves an advanced plan in the editable JSON import path", async () => {
	const advanced = { ...plan, customData: "retained advanced field" };
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}`
			? { name: "Advanced source", plan: advanced }
			: [],
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	fireEvent.click(await screen.findByRole("button", { name: "Edit JSON" }));
	await waitFor(() =>
		expect(
			screen.getByRole("textbox", { name: /import plan JSON/i }),
		).toBeInTheDocument(),
	);
	expect(
		(
			screen.getByRole("textbox", {
				name: /import plan JSON/i,
			}) as HTMLTextAreaElement
		).value,
	).toContain("retained advanced field");
});

const internalState: WizardState = {
	...sourceState,
	videos: [{ codec: "H265V2", height: 360, bitrate: 300_000 }],
	internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
};
const OTHER_ACCOUNT = "2f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
function mockInternalCopy(available: boolean, advanced = false) {
	const internalPlan = {
		...buildPlan(internalState),
		...(advanced ? { customData: "preserve verbatim" } : {}),
	};
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}`
			? { plan: internalPlan }
			: url === "/api/bitmovin-accounts"
				? [
						{ id: ACCOUNT, label: "test", internalHevcV2: available },
						{ id: OTHER_ACCOUNT, label: "main", internalHevcV2: false },
					]
				: [],
	);
	return internalPlan;
}
it.each([
	false,
	true,
])("blocks unauthorized internal copies without stripping the profile (verbatim %s)", async (advanced) => {
	mockInternalCopy(false, advanced);
	renderWithQuery(<CopyVodJob source={ID} />);
	expect(
		await screen.findByText(/HEVCv2 is unavailable for the selected account/i),
	).toBeInTheDocument();
	if (!advanced)
		fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	expect(screen.getByRole("button", { name: /Start encoding/ })).toBeDisabled();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});
it("preserves an authorized internal copied profile through submission", async () => {
	const expected = mockInternalCopy(true);
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	expect(screen.getByRole("checkbox", { name: "BCF override" })).toBeChecked();
	expect(screen.getByRole("textbox", { name: "BCF version" })).toHaveValue(
		INTERNAL_HEVC_V2_BCF_VERSION,
	);
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: /Start encoding$/ }),
		).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: /Start encoding$/ }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const submission = apiFetch.mock.calls.find(
		([, init]) => init?.method === "POST",
	);
	expect(
		encodingPlanSchema.parse(JSON.parse(submission?.[1].body).plan),
	).toEqual(encodingPlanSchema.parse(expected));
});
it("clears internal opt-in and its fixed generation mode when the account changes", async () => {
	mockInternalCopy(true);
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	fireEvent.change(screen.getByLabelText("Bitmovin account"), {
		target: { value: OTHER_ACCOUNT },
	});
	expect(
		screen.queryByText("Internal evaluation", { selector: "summary" }),
	).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	expect(screen.getByRole("button", { name: /Start encoding$/ })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: /Start encoding$/ }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const submission = apiFetch.mock.calls.find(
		([, init]) => init?.method === "POST",
	);
	const submitted = JSON.parse(submission?.[1].body).plan;
	expect(submitted.internal).toBeUndefined();
	expect(submitted.generation.encodingMode).not.toBe("SMART_PASS");
	expect(submitted.bitmovin.accountId).toBe(OTHER_ACCOUNT);
});

it("integrates HEVCv2 in Ladder and keeps a deliberately disabled BCF override disabled after edits", async () => {
	mockInternalCopy(true);
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	expect(screen.queryByText("Internal evaluation")).toBeNull();
	fireEvent.click(screen.getByRole("checkbox", { name: "BCF override" }));
	expect(screen.queryByLabelText("BCF version")).toBeNull();
	expect(
		screen.getByText(/HEVCv2 requires every video rung/),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "3. Ladder" }));
	expect(screen.getAllByLabelText("Codec")[0]).toHaveValue("H265V2");
	fireEvent.change(screen.getByLabelText("Video 1 bitrate"), {
		target: { value: "450000" },
	});
	expect(
		screen.getByText(/HEVCv2 requires every video rung/),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "1. Basics" }));
	expect(
		screen.getByRole("checkbox", { name: "BCF override" }),
	).not.toBeChecked();
	fireEvent.click(screen.getByRole("checkbox", { name: "BCF override" }));
	expect(screen.getByLabelText("BCF version")).toHaveValue(
		INTERNAL_HEVC_V2_BCF_VERSION,
	);
	fireEvent.click(screen.getByRole("button", { name: "8. Review" }));
	expect(screen.getByRole("button", { name: /Start encoding$/ })).toBeEnabled();
});
it("allows BCF selection first but requires explicit HEVCv2 selection in Ladder", async () => {
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}`
			? { plan }
			: url === "/api/bitmovin-accounts"
				? [{ id: ACCOUNT, label: "main", internalHevcV2: true }]
				: [],
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	await waitFor(() =>
		expect(
			screen.getByRole("checkbox", { name: "BCF override" }),
		).toBeInTheDocument(),
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "BCF override" }));
	expect(
		screen.getByText(/HEVCv2 requires every video rung/),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "3. Ladder" }));
	const [codec] = screen.getAllByLabelText("Codec");
	if (!codec) throw new Error("video codec control");
	fireEvent.change(codec, { target: { value: "H265V2" } });
	expect(screen.queryByText(/HEVCv2 requires every video rung/)).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "8. Review" }));
	expect(screen.getByRole("button", { name: /Start encoding$/ })).toBeEnabled();
});

it("keeps pinned encoder and BCF versions independent through edits and submission", async () => {
	mockInternalCopy(true);
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	expect(screen.getByRole("checkbox", { name: "BCF override" })).toBeChecked();
	fireEvent.change(screen.getByLabelText("Encoder version"), {
		target: { value: "BETA" },
	});
	expect(screen.getByLabelText("BCF version")).toHaveValue(
		INTERNAL_HEVC_V2_BCF_VERSION,
	);
	fireEvent.change(screen.getByLabelText("Encoder version"), {
		target: { value: "PINNED" },
	});
	fireEvent.change(screen.getByLabelText("Pinned encoder version"), {
		target: { value: "2.325.0" },
	});
	fireEvent.change(screen.getByLabelText("BCF version"), {
		target: { value: "v2.325.0-462-test" },
	});
	expect(screen.getByLabelText("Pinned encoder version")).toHaveValue(
		"2.325.0",
	);
	fireEvent.click(screen.getByRole("button", { name: "8. Review" }));
	fireEvent.click(screen.getByRole("button", { name: /Start encoding$/ }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const submitted = JSON.parse(
		apiFetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1].body,
	).plan;
	expect(submitted.bitmovin.encoderVersion).toBe("2.325.0");
	expect(submitted.internal.hevcV2.bcfVersion).toBe("v2.325.0-462-test");
});

it.each([
	{ kind: "MP4" as const, extraSegments: false, warning: false },
	{ kind: "FMP4" as const, extraSegments: false, warning: true },
	{ kind: "MP4" as const, extraSegments: true, warning: true },
])("warns only for actual segmented outputs without manifests: $kind extra=$extraSegments", async ({
	kind,
	extraSegments,
	warning,
}) => {
	const standalone = buildPlan({
		...sourceState,
		videos: [
			{
				codec: "H264",
				height: 360,
				bitrate: 300000,
				muxing: { kind, filename: "video.mp4" },
			},
		],
		audios: extraSegments ? sourceState.audios : [],
		manifests: { hls: false, dash: false },
	});
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}`
			? { name: "MP4 test", plan: standalone }
			: [],
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	expect(screen.queryByText(/without a playable playlist/i) !== null).toBe(
		warning,
	);
	expect(screen.getByRole("button", { name: /Start encoding$/ })).toBeEnabled();
});

it("submits per-rendition mode and clears the old job-wide mode", async () => {
	const selected = buildPlan({
		...sourceState,
		videos: [{ codec: "H265", height: 360, bitrate: 300000 }],
		startOptions: { encodingMode: "TWO_PASS" },
	});
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}` ? { plan: selected } : [],
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	await screen.findByRole("textbox", { name: /job name/i });
	fireEvent.click(screen.getByRole("button", { name: "3. Ladder" }));
	fireEvent.change(screen.getByLabelText("Encoding mode"), {
		target: { value: "SINGLE_PASS" },
	});
	fireEvent.click(screen.getByRole("button", { name: "6. Encoding" }));
	expect(screen.getByLabelText("Encoding mode")).toBeDisabled();
	expect(screen.getByLabelText("Encoding mode")).toHaveValue("");
	fireEvent.click(screen.getByRole("button", { name: "8. Review" }));
	fireEvent.click(screen.getByRole("button", { name: /Start encoding$/ }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const submitted = JSON.parse(
		apiFetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1].body,
	).plan;
	expect(submitted.generation.encodingMode).toBeUndefined();
	expect(submitted.renditions[0].encodingMode).toBe("SINGLE_PASS");
});

// Provider-accepted combinations must remain editable after persistence, not
// only plans produced by buildPlan (which hides inverse-mapping defects).
it.each([
	["video filters/subtitles and MP4 + fMP4", p1VideoCopy],
	["AudioMix and multi-track MP4", p1AudioCopy],
])("copies %s into the form and preserves the submitted plan", async (_, raw) => {
	const saved = encodingPlanSchema.parse(raw);
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}` ? { name: saved.name, plan: saved } : [],
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	const name = await screen.findByRole("textbox", { name: /job name/i });
	expect(name).toHaveValue(saved.name);
	if (raw === p1VideoCopy) {
		fireEvent.click(screen.getByRole("button", { name: /^3\. Ladder$/ }));
		const extras = screen.getAllByText("Placement & extras")[0];
		if (!extras) throw new Error("Video extras control missing");
		fireEvent.click(extras);
		const width = screen.getByLabelText("Width (px)");
		expect(width).toHaveValue(640);
		fireEvent.change(width, { target: { value: "800" } });
		expect(width).toHaveValue(800);
		fireEvent.click(screen.getByRole("button", { name: /^1\. Basics$/ }));
	}
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
	fireEvent.change(screen.getByRole("textbox", { name: /job name/i }), {
		target: { value: "Edited media copy" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	fireEvent.click(screen.getByRole("button", { name: /Start encoding$/ }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const submitted = JSON.parse(
		apiFetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1].body,
	).plan;
	expect(encodingPlanSchema.parse(submitted)).toEqual({
		...saved,
		name: "Edited media copy",
		renditions: saved.renditions.map((row, index) =>
			raw === p1VideoCopy && index === 0 ? { ...row, width: 800 } : row,
		),
	});
});

it.each([
	["encoded/original-job", "encoded/new-job/"],
	["encoded/custom-destination", "encoded/custom-destination/"],
])("renames generated copied output %s and preserves manual destinations", async (basePath, expectedBase) => {
	const copiedPlan = buildPlan({
		...sourceState,
		name: "original-job",
		output: { ...sourceState.output, basePath },
	});
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/encoding-jobs/${ID}` ? { plan: copiedPlan } : [],
	);
	renderWithQuery(<CopyVodJob source={ID} />);
	fireEvent.change(await screen.findByRole("textbox", { name: /job name/i }), {
		target: { value: "new-job" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	fireEvent.click(screen.getByRole("button", { name: /Start encoding$/ }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	const call = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
	const submitted = JSON.parse(call?.[1].body).plan;
	expect(submitted.manifests[0].destination.path).toBe(expectedBase);
	expect(
		submitted.muxings.every((muxing: { destination: { path: string } }) =>
			muxing.destination.path.startsWith(expectedBase),
		),
	).toBe(true);
});
