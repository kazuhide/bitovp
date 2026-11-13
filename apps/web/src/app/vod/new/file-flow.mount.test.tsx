import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { VOD_FLOW_COOKIE } from "@/lib/vod-flow";
import { draftKey, writeWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import {
	editFile,
	FILE_OUTPUT_DEFAULT_STATE,
	renameFileJob,
} from "./file-output";
import { VodWizard } from "./wizard";

/**
 * The file-output flow, mounted: the same wizard and the same state, opened on a
 * short view. What these check is the part no pure test can — that the view shows
 * six steps, that the full steps stay reachable without changing the job, and that
 * a setting the short view cannot show keeps the wizard in the full one.
 */

const { apiFetch, push } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	push: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace: vi.fn() }),
}));
// The picker is its own component with its own tests. Here it stands for one
// choice: a folder below the bucket the job already writes to.
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		initialCredentialId,
		onSelect,
	}: {
		open: boolean;
		initialCredentialId?: string;
		onSelect: (selection: {
			credentialId: string;
			bucket: string;
			path: string;
		}) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onSelect({
						credentialId: initialCredentialId ?? "",
						bucket: "picked",
						path: "deliveries/2026",
					})
				}
			>
				Pick deliveries/2026
			</button>
		) : null,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		isFetchedAfterMount: true,
		isFetching: false,
		data: {
			mode: "users",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
			organizationId: "org",
			effectiveUserId: "user",
			role: "OPERATOR",
		},
	}),
}));

const credentialId = "44444444-4444-4444-8444-444444444444";
const accountId = "33333333-3333-4333-8333-333333333333";
const jobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8";

/** A file-output job with everything but the format left to do: a source and a folder. */
const ready: WizardState = {
	...FILE_OUTPUT_DEFAULT_STATE,
	...renameFileJob(FILE_OUTPUT_DEFAULT_STATE, "clip"),
	accountId,
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId,
			bucket: "synthetic",
			path: "input.mov",
			name: "S3 Input",
		},
	],
	output: {
		...FILE_OUTPUT_DEFAULT_STATE.output,
		credentialId,
		bucket: "synthetic",
		basePath: "exports",
	},
};

const fileDraft = draftKey(["org", "user"], "vod", "new:file");

function steps() {
	return within(
		screen.getByRole("navigation", {
			name: /^(Wizard steps|ウィザードのステップ)$/,
		}),
	)
		.getAllByRole("button")
		.map((button) => button.textContent);
}

/** `qcVmaf` is the deployment's switch for the quality check, off unless asked for. */
async function restore(state: WizardState, step = 0, qcVmaf = false) {
	writeWizardDraft(fileDraft, "vod", state, step);
	renderWithQuery(
		qcVmaf ? (
			<FeatureFlagsProvider flags={{ qcVmaf }}>
				<VodWizard flow="file" />
			</FeatureFlagsProvider>
		) : (
			<VodWizard flow="file" />
		),
	);
	await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
}

/** The entry of the Review step's list that has this path, with what it is called. */
function written(path: string) {
	return screen.getByText(path).textContent;
}

function planJson(): string {
	return screen.getByTestId("plan-json").textContent ?? "";
}

/** What a field's help says: opened, read, and closed again. */
async function helpOf(label: string) {
	const button = screen.getByRole("button", {
		name: `${label} — more information`,
	});
	await userEvent.click(button);
	const text = screen.getByRole("note").textContent;
	await userEvent.click(button);
	return text;
}

function importJson(raw: unknown) {
	fireEvent.click(screen.getByRole("button", { name: /Import plan JSON/ }));
	fireEvent.change(screen.getByRole("textbox", { name: /Import plan JSON/ }), {
		target: { value: JSON.stringify(raw) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Validate.*load/i }));
}

function current(step: string) {
	return expect(screen.getByRole("button", { name: step })).toHaveAttribute(
		"aria-current",
		"step",
	);
}

beforeEach(() => {
	localStorage.clear();
	// biome-ignore lint/suspicious/noDocumentCookie: jsdom has no CookieStore
	document.cookie = `${VOD_FLOW_COOKIE}=; Path=/; Max-Age=0`;
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
		init?.method === "POST"
			? { id: jobId }
			: url === "/api/credentials"
				? [{ id: credentialId, label: "Storage", provider: "AWS_S3" }]
				: url === "/api/bitmovin-accounts"
					? [{ id: accountId, label: "Account" }]
					: // The Encoding step lists two things a page at a time: the
						// account's prewarmed pools, and the profiles a quality check
						// can run on.
						url.startsWith("/api/infrastructure/") ||
							url === "/api/vmaf-compute-profiles"
						? { items: [] }
						: [],
	);
});

describe("VodWizard — the file-output flow", () => {
	it.each([
		[
			"en",
			[
				"1. Basics",
				"2. Sources",
				"3. Format",
				"4. Destination",
				"5. Encoding",
				"6. Review",
			],
			"Export files",
			"File 1",
			"File name",
			"Include audio",
		],
		[
			"ja",
			[
				"1. 基本",
				"2. ソース",
				"3. 出力形式",
				"4. 保存先",
				"5. エンコーディング",
				"6. 確認",
			],
			"ファイルを書き出す",
			"ファイル 1",
			"ファイル名",
			"音声を入れる",
		],
	] as const)("opens on six steps with one MP4 that carries the audio (%s)", async (locale, labels, current, file, fileName, audio) => {
		renderWithQuery(<VodWizard flow="file" />, locale);
		expect(steps()).toEqual(labels);
		expect(screen.getByRole("link", { name: current })).toHaveAttribute(
			"aria-current",
			"page",
		);

		await userEvent.click(screen.getByRole("button", { name: labels[2] }));
		const first = within(screen.getByRole("group", { name: file }));
		expect(
			first.getByRole("combobox", { name: /Container|コンテナ/ }),
		).toHaveValue("MP4");
		expect(first.getByLabelText(fileName)).toHaveValue("output.mp4");
		expect(first.getByRole("checkbox", { name: audio })).toBeChecked();
	});

	it("leaves the streaming wizard as it was, with the switch beside it", () => {
		renderWithQuery(<VodWizard flow="streaming" />);
		expect(steps()).toHaveLength(8);
		expect(
			screen.getByRole("link", { name: "Package for streaming" }),
		).toHaveAttribute("aria-current", "page");
		expect(screen.getByRole("link", { name: "Export files" })).toHaveAttribute(
			"href",
			"/vod/new?flow=file",
		);
	});

	it("offers no switch when a template decides the form", () => {
		renderWithQuery(<VodWizard />);
		expect(screen.queryByRole("link", { name: "Export files" })).toBeNull();
	});

	it("opens a copied job on the eight steps, whichever flow it is asked for", () => {
		// The page keeps the flow away from a copy; the wizard does not rely on it.
		renderWithQuery(
			<VodWizard
				flow="file"
				copiedJob={{
					id: jobId,
					plan: buildPlan(ready) as unknown as Record<string, unknown>,
				}}
			/>,
		);
		expect(steps()).toHaveLength(8);
		expect(
			screen.queryByRole("button", { name: "Back to simple view" }),
		).toBeNull();
		expect(screen.getByLabelText(/job name/i)).toHaveValue("clip");
	});

	it("remembers the flow that was chosen", async () => {
		renderWithQuery(<VodWizard flow="file" />);
		const link = screen.getByRole("link", { name: "Package for streaming" });
		// jsdom cannot follow a link; the choice is recorded before navigation.
		link.addEventListener("click", (event) => event.preventDefault());
		await userEvent.click(link);
		expect(document.cookie).toContain(`${VOD_FLOW_COOKIE}=streaming`);
	});

	it("names each file after the job until a name is typed", async () => {
		const user = userEvent.setup();
		renderWithQuery(<VodWizard flow="file" />);
		await user.type(screen.getByLabelText(/job name/i), "trailer");
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		const name = screen.getByLabelText("File name");
		expect(name).toHaveValue("trailer.mp4");

		await user.clear(name);
		// An MP4 has no name of its own to fall back on.
		expect(name).toHaveAccessibleDescription("Enter a file name.");
		await user.type(name, "final.mp4");
		expect(name).not.toHaveAccessibleDescription();
		await user.click(screen.getByRole("button", { name: "1. Basics" }));
		await user.type(screen.getByLabelText(/job name/i), "-v2");
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		expect(screen.getByLabelText("File name")).toHaveValue("final.mp4");
	});

	it("says on both fields when two files were given one name, and refuses the job", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await user.click(screen.getByRole("button", { name: "Add file" }));
		const second = within(screen.getByRole("group", { name: "File 2" }));
		expect(second.getByLabelText("File name")).toHaveValue("clip-540p.mp4");
		expect(screen.queryByText(/Another file has this name/)).toBeNull();

		await user.clear(second.getByLabelText("File name"));
		await user.type(second.getByLabelText("File name"), "clip.mp4");
		for (const file of ["File 1", "File 2"])
			expect(
				within(screen.getByRole("group", { name: file })).getByLabelText(
					"File name",
				),
			).toHaveAccessibleDescription(
				"Another file has this name, and one would replace the other.",
			);
		expect(
			screen.getByText(/\[PLAN_OUTPUT_FILE_COLLISION\]/),
		).toHaveTextContent('"exports/clip.mp4"');

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(
			screen.getByRole("button", { name: "Start encoding" }),
		).toBeDisabled();
	});

	it("writes a file at the source's own height and with no audio track, and takes a file away again", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		expect(screen.queryByRole("button", { name: /Remove file/ })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Add file" }));
		const second = () => within(screen.getByRole("group", { name: "File 2" }));
		// No height is the source's own, and the name counts the file instead.
		await user.clear(second().getByLabelText("Height (p)"));
		expect(second().getByLabelText("Height (p)")).toHaveValue(null);
		expect(second().getByLabelText("File name")).toHaveValue("clip-2.mp4");
		// Each file has its own audio: the second is written without, the first with.
		await user.click(second().getByRole("checkbox", { name: "Include audio" }));
		expect(
			second().getByText("This file is written without an audio track."),
		).toBeInTheDocument();
		expect(
			within(screen.getByRole("group", { name: "File 1" })).getByRole(
				"checkbox",
				{ name: "Include audio" },
			),
		).toBeChecked();

		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		const files = () =>
			JSON.parse(planJson()) as {
				renditions: { codec: string; height?: number | null }[];
				muxings: { filename: string; additionalStreamKeys?: string[] }[];
			};
		expect(
			files().renditions.map((rendition) => [
				rendition.codec,
				rendition.height ?? "source",
			]),
		).toEqual([
			["H264", 1080],
			["H264", "source"],
			// The one audio track, which has no height.
			["AAC", "source"],
		]);
		expect(
			files().muxings.map((muxing) => [
				muxing.filename,
				muxing.additionalStreamKeys ?? [],
			]),
		).toEqual([
			["clip.mp4", ["a192"]],
			["clip-2.mp4", []],
		]);

		// The file that stays is the first one now, and is named as the first one is.
		await user.click(screen.getByRole("button", { name: "Remove file 1" }));
		expect(screen.queryByRole("group", { name: "File 2" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Remove file/ })).toBeNull();
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mp4");
		expect(screen.getByLabelText("Height (p)")).toHaveValue(null);
		expect(
			files().renditions.map((rendition) => rendition.height ?? "source"),
		).toEqual(["source"]);
		// It is the file that had no audio, and the track nothing holds is gone.
		expect(
			files().muxings.map((muxing) => [
				muxing.filename,
				muxing.additionalStreamKeys ?? [],
			]),
		).toEqual([["clip.mp4", []]]);
		expect(files().renditions.map((rendition) => rendition.codec)).toEqual([
			"H264",
		]);
	});

	it("says on both files when they are one video stream twice, and refuses the job", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await user.click(screen.getByRole("button", { name: "Add file" }));
		const file = (n: number) =>
			within(screen.getByRole("group", { name: `File ${n}` }));
		const told =
			/Another file has the same height and codec, and the same bitrate once both are rounded to kbps/;
		expect(
			file(1).getByLabelText("Bitrate (bps)"),
		).not.toHaveAccessibleDescription();

		// The first file once more, as QuickTime.
		await user.selectOptions(
			file(2).getByRole("combobox", { name: "Container" }),
			"PROGRESSIVE_MOV",
		);
		// The values as a whole: what is under test is the two files being equal,
		// not the keystrokes on the way there.
		const set = (label: string, value: string) =>
			fireEvent.change(file(2).getByLabelText(label), { target: { value } });
		set("Height (p)", "1080");
		// Under a kilobit from the first file's 8,000,000: the same bitrate in kbps.
		set("Bitrate (bps)", "8000400");
		expect(file(2).getByLabelText("File name")).toHaveValue("clip-1080p.mov");
		for (const n of [1, 2])
			expect(
				file(n).getByLabelText("Bitrate (bps)"),
			).toHaveAccessibleDescription(told);
		expect(
			screen.getAllByText(/\[PLAN_DUPLICATE_KEY\]/).length,
		).toBeGreaterThan(0);
		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(
			screen.getByRole("button", { name: "Start encoding" }),
		).toBeDisabled();

		// One kilobit apart is two streams.
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		set("Bitrate (bps)", "7999000");
		for (const n of [1, 2])
			expect(
				file(n).getByLabelText("Bitrate (bps)"),
			).not.toHaveAccessibleDescription();
		expect(screen.queryByText(/\[PLAN_DUPLICATE_KEY\]/)).toBeNull();
	});

	it("starts a job that writes one file into the chosen folder, with no manifest", async () => {
		await restore(ready);
		expect(steps()).toHaveLength(6);
		await userEvent.click(screen.getByRole("button", { name: "6. Review" }));
		// The folder is used as given: no subfolder named after the job.
		expect(screen.getByText("synthetic/exports/clip.mp4")).toBeInTheDocument();

		const start = screen.getByRole("button", { name: "Start encoding" });
		await waitFor(() => expect(start).toBeEnabled());
		await userEvent.click(start);
		await waitFor(() =>
			expect(push).toHaveBeenCalledWith(`/vod/jobs/${jobId}`),
		);
		const post = apiFetch.mock.calls.find(
			([, init]) => init?.method === "POST",
		);
		const { plan } = JSON.parse(post?.[1].body);
		expect(plan.manifests ?? []).toEqual([]);
		expect(plan.muxings).toEqual([
			expect.objectContaining({
				kind: "MP4",
				filename: "clip.mp4",
				streamKey: "v1080",
				additionalStreamKeys: ["a192"],
				destination: expect.objectContaining({ path: "exports/" }),
			}),
		]);
		expect(localStorage.getItem(fileDraft)).toBeNull();
	});

	it("writes into the folder typed in Destination, and adds none for the job", async () => {
		const user = userEvent.setup();
		// A folder that ends in the job's name: the streaming flow shows such a
		// folder without it, because there the job's name is a folder of its own.
		await restore({
			...ready,
			output: { ...ready.output, basePath: "exports/clip" },
		});
		await user.click(screen.getByRole("button", { name: "4. Destination" }));
		await user.click(screen.getByRole("button", { name: "Enter manually" }));
		const folder = screen.getByLabelText(/output folder/i, {
			selector: "input",
		});
		// Here the field shows the folder as it is, the one the files go to.
		expect(folder).toHaveValue("exports/clip");
		await user.clear(folder);
		await user.type(folder, "deliveries/2026");
		expect(folder).toHaveValue("deliveries/2026");

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(
			screen.getByText("synthetic/deliveries/2026/clip.mp4"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).muxings[0].destination.path).toBe(
			"deliveries/2026/",
		);

		// No folder at all is the top of the bucket.
		await user.click(screen.getByRole("button", { name: "4. Destination" }));
		await user.click(screen.getByRole("button", { name: "Enter manually" }));
		await user.clear(
			screen.getByLabelText(/output folder/i, { selector: "input" }),
		);
		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(screen.getByText("synthetic/clip.mp4")).toBeInTheDocument();
	});

	it("writes into the folder picked from storage, and adds none for the job", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "4. Destination" }));
		await user.click(screen.getByRole("button", { name: "Change" }));
		await user.click(
			screen.getByRole("button", { name: "Pick deliveries/2026" }),
		);

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(
			screen.getByText("picked/deliveries/2026/clip.mp4"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		const plan = JSON.parse(planJson());
		expect(plan.outputs[0].bucket).toBe("picked");
		expect(plan.muxings[0].destination.path).toBe("deliveries/2026/");
	});

	it("writes an MPEG-TS file when that container is chosen, named after the job", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		const container = screen.getByRole("combobox", { name: "Container" });
		expect(
			within(container)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual([
			"MP4 (.mp4)",
			"MPEG-TS (.ts)",
			"QuickTime (.mov)",
			"WebM (.webm)",
		]);

		await user.selectOptions(container, "MPEG-TS (.ts)");
		expect(screen.getByLabelText("File name")).toHaveValue("clip.ts");
		expect(container).not.toHaveAccessibleDescription();

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(screen.getByText("synthetic/exports/clip.ts")).toBeInTheDocument();
		const start = screen.getByRole("button", { name: "Start encoding" });
		await waitFor(() => expect(start).toBeEnabled());
		await user.click(start);
		await waitFor(() =>
			expect(push).toHaveBeenCalledWith(`/vod/jobs/${jobId}`),
		);
		const post = apiFetch.mock.calls.find(
			([, init]) => init?.method === "POST",
		);
		const { plan } = JSON.parse(post?.[1].body);
		expect(plan.manifests ?? []).toEqual([]);
		expect(plan.muxings).toEqual([
			expect.objectContaining({
				kind: "PROGRESSIVE_TS",
				filename: "clip.ts",
				streamKey: "v1080",
				additionalStreamKeys: ["a192"],
				destination: expect.objectContaining({ path: "exports/" }),
			}),
		]);
	});

	const UNVERIFIED =
		"The container's format defines this codec, but no Bitmovin document was found that lists the combination. The job may be refused: check the first file it writes.";
	const options = (select: HTMLElement) =>
		within(select)
			.getAllByRole("option")
			.map((option) => option.textContent);
	/** The codecs and the files of the plan on show, once "Plan JSON" is open. */
	const planned = () => {
		const plan = JSON.parse(planJson()) as {
			renditions: { key: string; codec: string }[];
			muxings: {
				kind: string;
				filename: string;
				streamKey: string;
				additionalStreamKeys?: string[];
			}[];
		};
		const codec = (key: string) =>
			plan.renditions.find((rendition) => rendition.key === key)?.codec;
		return plan.muxings.map((muxing) => [
			muxing.kind,
			muxing.filename,
			...[muxing.streamKey, ...(muxing.additionalStreamKeys ?? [])].map(
				(key) => `${key}:${codec(key)}`,
			),
		]);
	};

	it("reports partially qualified QuickTime support and warns for an unlisted codec", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		const container = screen.getByRole("combobox", { name: "Container" });
		const audioCodec = screen.getByRole("combobox", { name: "Audio codec" });

		await user.selectOptions(audioCodec, "AC3");
		expect(audioCodec).not.toHaveAccessibleDescription();
		await user.selectOptions(container, "QuickTime (.mov)");
		expect(container).toHaveAccessibleDescription(
			"Some codec combinations for this container remain unverified. Inspect an initial output.",
		);
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mov");
		// AC-3 is a codec the format has and Bitmovin does not list for it: the
		// change of container does not take the file into that pair by itself.
		expect(audioCodec).toHaveValue("AAC");
		expect(audioCodec).not.toHaveAccessibleDescription();
		expect(options(audioCodec)).toEqual(["AAC", "AC3", "DD"]);

		// Chosen here, it is kept and said to be unlisted, and the job starts.
		await user.selectOptions(audioCodec, "AC3");
		expect(audioCodec).toHaveAccessibleDescription(UNVERIFIED);
		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(
			screen.getAllByText(/\[PLAN_MUXING_UNVERIFIED_CODEC\]/).length,
		).toBeGreaterThan(0);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Start encoding" }),
			).toBeEnabled(),
		);
	});

	it("offers each container every codec it can hold, the video beside the audio", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		const container = screen.getByRole("combobox", { name: "Container" });
		const codec = screen.getByRole("combobox", { name: "Codec" });
		const audioCodec = screen.getByRole("combobox", { name: "Audio codec" });
		const offered = async (name: string) => {
			await user.selectOptions(container, name);
			return [options(codec), options(audioCodec)];
		};

		expect([options(codec), options(audioCodec)]).toEqual([
			["H264", "H265", "AV1"],
			["AAC", "AC3", "EAC3", "OPUS", "DOLBY_ATMOS", "DDPLUS", "DD"],
		]);
		expect(await offered("MPEG-TS (.ts)")).toEqual([
			["H264", "H265"],
			["AAC", "AC3", "EAC3", "DDPLUS", "DD"],
		]);
		expect(await offered("QuickTime (.mov)")).toEqual([
			["H264", "H265"],
			["AAC", "AC3", "DD"],
		]);
		expect(await offered("WebM (.webm)")).toEqual([["VP9", "AV1"], ["OPUS"]]);
	});

	it("writes a WebM file of VP9 and Opus, and says what Bitmovin documents of audio beside AV1", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		const container = screen.getByRole("combobox", { name: "Container" });
		const codec = screen.getByRole("combobox", { name: "Codec" });
		// Read anew each time: the audio's fields go with the audio and come back.
		const audioCodec = () =>
			screen.getByRole("combobox", { name: "Audio codec" });

		await user.selectOptions(container, "WebM (.webm)");
		expect(screen.getByLabelText("File name")).toHaveValue("clip.webm");
		expect(codec).toHaveValue("VP9");
		expect(audioCodec()).toHaveValue("OPUS");
		expect(audioCodec()).not.toHaveAccessibleDescription();
		expect(screen.getByLabelText("Sample rate (Hz)")).toHaveValue(48_000);
		// VP9 has its own advanced options, as in the ladder step.
		expect(screen.getByText("Advanced (VP9)")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(planned()).toEqual([
			["PROGRESSIVE_WEBM", "clip.webm", "v1080:VP9", "a192:OPUS"],
		]);
		expect(steps()).toHaveLength(6);

		await user.selectOptions(codec, "AV1");
		expect(screen.getByText("Advanced (AV1)")).toBeInTheDocument();
		expect(audioCodec()).toHaveAccessibleDescription(
			"Bitmovin's release notes say that a WebM file with AV1 video takes no other stream, and no later note was found that says otherwise. The job may be refused: to be sure, write this file without audio, or use MP4.",
		);
		expect(planned()).toEqual([
			["PROGRESSIVE_WEBM", "clip.webm", "v1080:AV1", "a192:OPUS"],
		]);
		// Without the audio there is nothing left to say it of.
		await user.click(screen.getByRole("checkbox", { name: "Include audio" }));
		expect(planned()).toEqual([["PROGRESSIVE_WEBM", "clip.webm", "v1080:AV1"]]);

		// Back in MP4 the file is AV1 still, which MP4 holds, and has AAC again.
		await user.click(screen.getByRole("checkbox", { name: "Include audio" }));
		await user.selectOptions(container, "MP4 (.mp4)");
		expect(codec).toHaveValue("AV1");
		expect(audioCodec()).toHaveValue("AAC");
		expect(planned()).toEqual([["MP4", "clip.mp4", "v1080:AV1", "a192:AAC"]]);
		// Opus in MP4 is there to choose, and is said to be unlisted.
		await user.selectOptions(audioCodec(), "OPUS");
		expect(audioCodec()).toHaveAccessibleDescription(UNVERIFIED);
		expect(planned()).toEqual([["MP4", "clip.mp4", "v1080:AV1", "a192:OPUS"]]);
		expect(steps()).toHaveLength(6);
	});

	it("says of a codec a draft brought that the container cannot hold it, and offers what it can", async () => {
		const user = userEvent.setup();
		const [video] = ready.videos as [WizardState["videos"][number]];
		await restore(
			{
				...ready,
				videos: [
					{
						...video,
						codec: "VP9",
						muxing: { ...video.muxing, kind: "PROGRESSIVE_WEBM" },
					},
				],
			},
			2,
		);
		expect(steps()).toHaveLength(6);
		const audioCodec = screen.getByRole("combobox", { name: "Audio codec" });
		// The codec that is set stays on show; only what fits is offered beside it.
		expect(audioCodec).toHaveValue("AAC");
		expect(audioCodec).toHaveAccessibleDescription(
			"WebM (.webm) cannot hold this codec.",
		);
		expect(options(audioCodec)).toEqual(["OPUS", "AAC"]);
		await user.selectOptions(audioCodec, "OPUS");
		expect(audioCodec).not.toHaveAccessibleDescription();
		expect(options(audioCodec)).toEqual(["OPUS"]);
	});

	it("says of a video codec the Ladder step left that the container cannot hold it, and of Dolby Vision where Bitmovin names no such file", async () => {
		const user = userEvent.setup();
		const [video] = ready.videos as [WizardState["videos"][number]];
		await restore({ ...ready, videos: [{ ...video, codec: "VP9" }] }, 2);
		expect(steps()).toHaveLength(6);
		const codec = screen.getByRole("combobox", { name: "Codec" });
		expect(codec).toHaveValue("VP9");
		expect(codec).toHaveAccessibleDescription(
			"MP4 (.mp4) cannot hold this codec.",
		);
		expect(options(codec)).toEqual(["H264", "H265", "AV1", "VP9"]);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(
			screen.getByText(/\[PLAN_MUXING_CODEC_MISMATCH\]/),
		).toBeInTheDocument();
		await user.selectOptions(codec, "H265");
		expect(codec).not.toHaveAccessibleDescription();
		expect(options(codec)).toEqual(["H264", "H265", "AV1"]);
		expect(screen.queryByText(/\[PLAN_MUXING_CODEC_MISMATCH\]/)).toBeNull();
		cleanup();

		await restore(
			{
				...ready,
				videos: [
					{
						...video,
						codec: "H265",
						h265: { dynamicRangeFormat: "DOLBY_VISION_PROFILE_8_1" },
					},
				],
			},
			2,
		);
		const DOLBY_VISION =
			"Bitmovin's documents name Dolby Vision for MP4 and not for this container. The job may be refused, or the file may not be marked as Dolby Vision: check the first file it writes.";
		const hevc = screen.getByRole("combobox", { name: "Codec" });
		expect(hevc).not.toHaveAccessibleDescription();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Container" }),
			"MPEG-TS (.ts)",
		);
		expect(hevc).toHaveValue("H265");
		expect(hevc).toHaveAccessibleDescription(DOLBY_VISION);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(
			screen.getByText(/\[PLAN_MUXING_UNVERIFIED_CODEC\]/),
		).toBeInTheDocument();
	});

	it("says where a Dolby Atmos track gets its source, until it reads one", async () => {
		const user = userEvent.setup();
		await restore(
			{
				...ready,
				sources: {
					dolbyStreams: [
						{
							kind: "ATMOS",
							key: "atmos",
							inputFile: "main",
							inputFormat: "ADM",
						},
					],
				},
			},
			2,
		);
		const audioCodec = screen.getByRole("combobox", { name: "Audio codec" });
		await user.selectOptions(audioCodec, "DOLBY_ATMOS");
		expect(audioCodec).toHaveAccessibleDescription(
			"Dolby Atmos is encoded from a Dolby Atmos stream. Add one in the Sources step, then choose it as this file's audio source.",
		);
		// Atmos has no channel layout to choose, and has loudness control.
		expect(screen.queryByLabelText("Channel layout")).toBeNull();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Audio source" }),
			"atmos",
		);
		expect(audioCodec).not.toHaveAccessibleDescription();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(planned()).toEqual([
			["MP4", "clip.mp4", "v1080:H264", "a192:DOLBY_ATMOS"],
		]);
		expect(screen.queryByText(/\[PLAN_STREAM_SOURCE_MISMATCH\]/)).toBeNull();

		// MPEG-TS holds no Dolby Atmos. The track goes on in AAC, and from the input's
		// own audio: an Atmos stream is not something AAC is encoded from.
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Container" }),
			"MPEG-TS (.ts)",
		);
		const source = () => screen.getByRole("combobox", { name: "Audio source" });
		expect(screen.getByRole("combobox", { name: "Audio codec" })).toHaveValue(
			"AAC",
		);
		expect(source()).toHaveValue("");
		expect(source()).not.toHaveAccessibleDescription();
		expect(planned()).toEqual([
			["PROGRESSIVE_TS", "clip.ts", "v1080:H264", "a192:AAC"],
		]);
		expect(screen.queryByText(/\[PLAN_STREAM_SOURCE_MISMATCH\]/)).toBeNull();
		// Chosen for it all the same, the field says why the job is refused.
		await user.selectOptions(source(), "atmos");
		expect(source()).toHaveAccessibleDescription(
			"This is a Dolby Atmos stream, which only a Dolby Atmos track can read. Choose another source, or the job will be rejected.",
		);
		expect(
			screen.getByText(/\[PLAN_STREAM_SOURCE_MISMATCH\]/),
		).toBeInTheDocument();
		await user.selectOptions(source(), "");
		expect(source()).not.toHaveAccessibleDescription();
		expect(screen.queryByText(/\[PLAN_STREAM_SOURCE_MISMATCH\]/)).toBeNull();
	});

	it("takes a CRF for the bitrate of a VP9 file, as of an H.264 or H.265 one, and not of an AV1 one", async () => {
		const user = userEvent.setup();
		const [video] = ready.videos as [WizardState["videos"][number]];
		await restore(
			{
				...ready,
				videos: [
					{
						...video,
						codec: "VP9",
						bitrate: null,
						vp9: { crf: 30 },
						muxing: { ...video.muxing, kind: "PROGRESSIVE_WEBM" },
					},
				],
			},
			2,
		);
		const bitrate = screen.getByRole("spinbutton", { name: "Bitrate (bps)" });
		expect(bitrate).not.toHaveAccessibleDescription();
		// AV1 has no CRF here: the bitrate is what it is encoded to.
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"AV1",
		);
		expect(bitrate).toHaveAccessibleDescription("Enter a bitrate.");
		cleanup();

		await restore(
			{
				...ready,
				videos: [
					{
						...video,
						codec: "VP9",
						bitrate: null,
						muxing: { ...video.muxing, kind: "PROGRESSIVE_WEBM" },
					},
				],
			},
			2,
		);
		expect(
			screen.getByRole("spinbutton", { name: "Bitrate (bps)" }),
		).toHaveAccessibleDescription(
			"Enter a bitrate, or set CRF in the advanced options.",
		);
	});

	it("asks for the audio bitrate and the sample rate while either is empty", async () => {
		const user = userEvent.setup();
		await restore(ready, 2);
		const bitrate = screen.getByRole("spinbutton", {
			name: "Audio bitrate (bps)",
		});
		const rate = screen.getByRole("spinbutton", { name: "Sample rate (Hz)" });
		expect(bitrate).not.toHaveAccessibleDescription();
		expect(rate).not.toHaveAccessibleDescription();
		await user.clear(bitrate);
		expect(bitrate).toHaveAccessibleDescription("Enter a bitrate.");
		await user.type(bitrate, "128000");
		expect(bitrate).not.toHaveAccessibleDescription();
		await user.clear(rate);
		expect(rate).toHaveAccessibleDescription("Enter a sample rate.");
		await user.type(rate, "44100");
		expect(rate).not.toHaveAccessibleDescription();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(planned()).toEqual([["MP4", "clip.mp4", "v1080:H264", "a128:AAC"]]);
	});

	it("gives each file its own audio, typed a digit at a time beside another file's", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await user.click(screen.getByRole("button", { name: "Add file" }));
		const file = (n: number) =>
			within(screen.getByRole("group", { name: `File ${n}` }));
		const bitrate = (n: number) =>
			file(n).getByRole("spinbutton", { name: "Audio bitrate (bps)" });
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		// The added file holds the track the first one has: one track, encoded once.
		expect(planned()).toEqual([
			["MP4", "clip.mp4", "v1080:H264", "a192:AAC"],
			["MP4", "clip-540p.mp4", "v540:H264", "a192:AAC"],
		]);

		// Every keystroke is a state of its own, and none of them moves the other
		// file's audio, drops this file's, or leaves the short view.
		await user.clear(bitrate(2));
		await user.type(bitrate(2), "96000");
		expect(bitrate(2)).toHaveValue(96_000);
		expect(bitrate(1)).toHaveValue(192_000);
		expect(planned()).toEqual([
			["MP4", "clip.mp4", "v1080:H264", "a192:AAC"],
			["MP4", "clip-540p.mp4", "v540:H264", "a96:AAC"],
		]);
		expect(steps()).toHaveLength(6);

		// Two tracks at one bitrate in two codecs would have one key: the later one's
		// is numbered, and each file goes on holding its own.
		await user.clear(bitrate(2));
		await user.type(bitrate(2), "192000");
		expect(planned()[1]).toEqual([
			"MP4",
			"clip-540p.mp4",
			"v540:H264",
			"a192:AAC",
		]);
		await user.selectOptions(
			file(2).getByRole("combobox", { name: "Audio codec" }),
			"AC3",
		);
		expect(planned()).toEqual([
			["MP4", "clip.mp4", "v1080:H264", "a192:AAC"],
			["MP4", "clip-540p.mp4", "v540:H264", "a192-2:AC3"],
		]);
		expect(screen.queryByText(/\[PLAN_DUPLICATE_KEY\]/)).toBeNull();
		expect(steps()).toHaveLength(6);

		// The first file in the same codec holds the same track again.
		await user.selectOptions(
			file(1).getByRole("combobox", { name: "Audio codec" }),
			"AC3",
		);
		expect(planned()).toEqual([
			["MP4", "clip.mp4", "v1080:H264", "a192:AC3"],
			["MP4", "clip-540p.mp4", "v540:H264", "a192:AC3"],
		]);
		expect(steps()).toHaveLength(6);
	});

	it("lists in Review files of different containers and codecs, each by its own name", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await user.click(screen.getByRole("button", { name: "Add file" }));
		await user.selectOptions(
			within(screen.getByRole("group", { name: "File 2" })).getByRole(
				"combobox",
				{ name: "Container" },
			),
			"WebM (.webm)",
		);
		// H.264 beside VP9: the job runs in one mode, which each file is to be given.
		const ONE_MODE =
			"The files use more than one video codec, and a job runs in one encoding mode. Choose a mode other than “(default)”, the same one for every file, or the job will be rejected.";
		const mode = (n: number) =>
			within(screen.getByRole("group", { name: `File ${n}` })).getByRole(
				"combobox",
				{ name: "Encoding mode" },
			);
		expect(mode(1)).toHaveAccessibleDescription(ONE_MODE);
		expect(mode(2)).toHaveAccessibleDescription(ONE_MODE);
		expect(
			screen.getAllByText(/\[PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS\]/)
				.length,
		).toBeGreaterThan(0);
		await user.selectOptions(mode(1), "TWO_PASS");
		expect(mode(2)).toHaveAccessibleDescription(ONE_MODE);
		await user.selectOptions(mode(2), "TWO_PASS");
		expect(mode(1)).not.toHaveAccessibleDescription();
		expect(mode(2)).not.toHaveAccessibleDescription();
		expect(
			screen.queryByText(/\[PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS\]/),
		).toBeNull();

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(screen.getByText("synthetic/exports/clip.mp4")).toBeInTheDocument();
		expect(
			screen.getByText("synthetic/exports/clip-540p.webm"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(planned()).toEqual([
			["MP4", "clip.mp4", "v1080:H264", "a192:AAC"],
			["PROGRESSIVE_WEBM", "clip-540p.webm", "v540:VP9", "a192-2:OPUS"],
		]);
		const start = screen.getByRole("button", { name: "Start encoding" });
		await waitFor(() => expect(start).toBeEnabled());
	});

	it("offers HEVCv2 to an account that may use it, with its switch in Basics, and to no other", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		expect(options(screen.getByRole("combobox", { name: "Codec" }))).toEqual([
			"H264",
			"H265",
			"AV1",
		]);
		await user.click(screen.getByRole("button", { name: "1. Basics" }));
		expect(screen.queryByRole("checkbox", { name: "BCF override" })).toBeNull();
		cleanup();

		const plain = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
			url === "/api/bitmovin-accounts" && init?.method !== "POST"
				? [{ id: accountId, label: "Account", internalHevcV2: true }]
				: plain?.(url, init),
		);
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await waitFor(() =>
			expect(options(screen.getByRole("combobox", { name: "Codec" }))).toEqual([
				"H264",
				"H265",
				"AV1",
				"HEVCv2",
			]),
		);
		const codec = screen.getByRole("combobox", { name: "Codec" });
		// It takes the whole job, and says so while another file is in another codec.
		await user.click(screen.getByRole("button", { name: "Add file" }));
		const WHOLE_JOB =
			"HEVCv2 takes the whole job. Choose it for every file, and leave “BCF override” on in the Basics step.";
		const codecOf = (n: number) =>
			within(screen.getByRole("group", { name: `File ${n}` })).getByRole(
				"combobox",
				{ name: "Codec" },
			);
		await user.selectOptions(codecOf(1), "HEVCv2");
		expect(codecOf(1)).toHaveAccessibleDescription(WHOLE_JOB);
		expect(codecOf(2)).toHaveAccessibleDescription(WHOLE_JOB);
		await user.selectOptions(codecOf(2), "HEVCv2");
		expect(codecOf(1)).not.toHaveAccessibleDescription();
		// A file added now is in it too.
		await user.click(screen.getByRole("button", { name: "Add file" }));
		expect(codecOf(3)).toHaveValue("H265V2");
		expect(codecOf(3)).not.toHaveAccessibleDescription();
		await user.click(screen.getByRole("button", { name: "Remove file 3" }));
		await user.click(screen.getByRole("button", { name: "Remove file 2" }));
		// The one mode it has, as in the ladder step.
		const mode = screen.getByRole("combobox", { name: "Encoding mode" });
		expect(mode).toBeDisabled();
		expect(mode).toHaveValue("SMART_PASS");
		expect(screen.getByText("Advanced HEVCv2")).toBeInTheDocument();
		expect(steps()).toHaveLength(6);
		// MPEG-TS holds H.265, and so this; WebM does not, and the switch goes with it.
		const container = screen.getByRole("combobox", { name: "Container" });
		await user.selectOptions(container, "MPEG-TS (.ts)");
		expect(codec).toHaveValue("H265V2");

		await user.click(screen.getByRole("button", { name: "1. Basics" }));
		const override = screen.getByRole("checkbox", { name: "BCF override" });
		expect(override).toBeChecked();
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Container" }),
			"WebM (.webm)",
		);
		expect(screen.getByRole("combobox", { name: "Codec" })).toHaveValue("VP9");
		// It is H.265 to a container, so one that holds no H.265 does not offer it.
		expect(options(screen.getByRole("combobox", { name: "Codec" }))).toEqual([
			"VP9",
			"AV1",
		]);
		expect(
			screen.getByRole("combobox", { name: "Encoding mode" }),
		).toBeEnabled();
		await user.click(screen.getByRole("button", { name: "1. Basics" }));
		expect(
			screen.getByRole("checkbox", { name: "BCF override" }),
		).not.toBeChecked();
		expect(steps()).toHaveLength(6);
	});

	it("says what HEVCv2 needs of a file, takes no H.265 setting it has not, and says in Basics when its switch is on alone", async () => {
		const user = userEvent.setup();
		const plain = apiFetch.getMockImplementation();
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
			url === "/api/bitmovin-accounts" && init?.method !== "POST"
				? [{ id: accountId, label: "Account", internalHevcV2: true }]
				: plain?.(url, init),
		);
		const [video] = ready.videos as [WizardState["videos"][number]];
		// A CRF and no bitrate, as the H.265 bitrate field suggests.
		await restore(
			{
				...ready,
				videos: [{ ...video, codec: "H265", bitrate: null, h265: { crf: 24 } }],
			},
			2,
		);
		const codec = screen.getByRole("combobox", { name: "Codec" });
		await waitFor(() => expect(options(codec)).toContain("HEVCv2"));
		const height = screen.getByRole("spinbutton", { name: "Height (p)" });
		const bitrate = screen.getByRole("spinbutton", { name: "Bitrate (bps)" });
		expect(bitrate).not.toHaveAccessibleDescription();
		await user.selectOptions(codec, "HEVCv2");
		expect(bitrate).toHaveAccessibleDescription(
			"HEVCv2 needs a bitrate. Enter one.",
		);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		const refusals = () =>
			screen.queryAllByText(/\[PLAN_INTERNAL_HEVC_V2_UNSUPPORTED\]/);
		// One refusal, for the bitrate. The CRF did not come along.
		expect(refusals()).toHaveLength(1);
		expect(planJson()).not.toContain('"crf"');
		await user.type(bitrate, "6000000");
		expect(bitrate).not.toHaveAccessibleDescription();
		expect(refusals()).toHaveLength(0);
		await user.clear(height);
		expect(height).toHaveAccessibleDescription(
			"HEVCv2 needs a height. Enter one.",
		);
		expect(refusals()).toHaveLength(1);
		await user.type(height, "1080");
		expect(height).not.toHaveAccessibleDescription();
		expect(refusals()).toHaveLength(0);
		// Another codec takes the source's height, and is not asked for one.
		await user.selectOptions(codec, "H265");
		await user.clear(height);
		expect(height).not.toHaveAccessibleDescription();

		const ALONE =
			"“BCF override” is for HEVCv2, and no file uses it. Choose HEVCv2 for every file in the Format step, or switch this off: the job cannot start as it is.";
		await user.click(screen.getByRole("button", { name: "1. Basics" }));
		const override = () =>
			screen.getByRole("checkbox", { name: "BCF override" });
		expect(override()).not.toBeChecked();
		expect(screen.queryByText(ALONE)).toBeNull();
		await user.click(override());
		expect(screen.getByText(ALONE)).toHaveAttribute("role", "alert");
		expect(override()).toHaveAccessibleDescription(ALONE);
		await user.click(override());
		expect(screen.queryByText(ALONE)).toBeNull();
		await user.click(override());
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await user.type(
			screen.getByRole("spinbutton", { name: "Height (p)" }),
			"1080",
		);
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"HEVCv2",
		);
		await user.click(screen.getByRole("button", { name: "1. Basics" }));
		expect(override()).toBeChecked();
		expect(screen.queryByText(ALONE)).toBeNull();
	});

	it("keeps its draft apart from the streaming flow's", async () => {
		writeWizardDraft(fileDraft, "vod", ready, 0);
		renderWithQuery(<VodWizard flow="streaming" />);
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith("/api/credentials"),
		);
		expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
	});

	it("shows every step on request without changing the job, and returns", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		const before = planJson();
		expect(JSON.parse(before).muxings).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		expect(steps()).toHaveLength(8);
		expect(planJson()).toBe(before);
		// Nothing a hidden step holds is in use, so the list is still the whole job.
		await user.click(screen.getByRole("button", { name: "8. Review" }));
		expect(screen.getByText("What this job writes")).toBeInTheDocument();
		expect(screen.getByText("synthetic/exports/clip.mp4")).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Back to simple view" }),
		);
		expect(steps()).toHaveLength(6);
		expect(planJson()).toBe(before);
	});

	it("leaves the list of files out once a hidden step adds to what the job writes", async () => {
		const [file] = ready.videos as [WizardState["videos"][number]];
		// A folder per file is the packaging step's. The list would be one output
		// of several, and the plan beside the step names them all.
		await restore(
			{
				...ready,
				videos: [{ ...file, muxing: { ...file.muxing, path: "video/1080p" } }],
			},
			7,
		);
		expect(steps()).toHaveLength(8);
		current("8. Review");
		expect(screen.queryByText("What this job writes")).toBeNull();
		expect(
			screen.queryByText("synthetic/exports/video/1080p/clip.mp4"),
		).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).muxings[0].destination.path).toBe(
			"exports/video/1080p",
		);
	});

	it("returns a file to the output folder when a path typed in Packaging is deleted again", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		await user.click(screen.getByRole("button", { name: "5. Packaging" }));
		const path = screen.getByLabelText("Destination path");
		// Empty here is the folder itself, not the folder the ladder would derive.
		expect(path).toHaveAccessibleDescription(
			"Relative to the base output path — empty = that path itself, with no subfolder.",
		);
		const back = screen.getByRole("button", { name: "Back to simple view" });

		await user.type(path, "proxy");
		expect(back).toBeDisabled();
		expect(path).toHaveAccessibleDescription(/empty = derived "video\/1080p"/);
		await user.clear(path);
		expect(back).toBeEnabled();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).muxings[0].destination.path).toBe("exports/");
	});

	it("gives a file turned into segments in Packaging a folder of its own, however its path is emptied, and takes it back as a whole file", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		await user.click(screen.getByRole("button", { name: "5. Packaging" }));
		const kind = document.getElementById("wz-mx-v-0-kind") as HTMLSelectElement;
		const path = () =>
			document.getElementById("wz-mx-v-0-path") as HTMLInputElement;
		const back = screen.getByRole("button", { name: "Back to simple view" });
		expect(kind).toHaveValue("MP4");
		// The output folder itself is a place for one whole file. Segments of two
		// legs left there would share the folder, and their names.
		await user.selectOptions(kind, "FMP4");
		expect(path()).toHaveAccessibleDescription(
			/empty = derived "video\/1080p"/,
		);
		await user.type(path(), "proxy");
		await user.clear(path());
		expect(path()).toHaveValue("");
		expect(path()).toHaveAccessibleDescription(
			/empty = derived "video\/1080p"/,
		);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).muxings[0].destination.path).toBe(
			"exports/video/1080p",
		);
		expect(back).toBeDisabled();

		// One whole file again, it is back where it was, and the simple view has it.
		await user.selectOptions(
			document.getElementById("wz-mx-v-0-kind") as HTMLSelectElement,
			"MP4",
		);
		expect(path()).toHaveValue("");
		expect(path()).toHaveAccessibleDescription(
			"Relative to the base output path — empty = that path itself, with no subfolder.",
		);
		expect(JSON.parse(planJson()).muxings[0].destination.path).toBe("exports/");
		expect(back).toBeEnabled();
	});

	it("leaves a path typed in Packaging where it is when the container changes", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		await user.click(screen.getByRole("button", { name: "5. Packaging" }));
		const kind = () =>
			document.getElementById("wz-mx-v-0-kind") as HTMLSelectElement;
		const path = () =>
			document.getElementById("wz-mx-v-0-path") as HTMLInputElement;
		await user.type(path(), "proxy");
		await user.selectOptions(kind(), "FMP4");
		expect(path()).toHaveValue("proxy");
		await user.selectOptions(kind(), "MP4");
		expect(path()).toHaveValue("proxy");
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).muxings[0].destination.path).toBe(
			"exports/proxy",
		);
	});

	it("leaves a whole file in the folder derived for it when it becomes another kind of whole file", async () => {
		const user = userEvent.setup();
		const [file] = ready.videos as [WizardState["videos"][number]];
		// A file with no path of its own, as a loaded plan can leave it.
		await restore(
			{
				...ready,
				videos: [{ ...file, muxing: { ...file.muxing, path: undefined } }],
			},
			4,
		);
		expect(steps()).toHaveLength(8);
		current("5. Packaging");
		await user.selectOptions(
			document.getElementById("wz-mx-v-0-kind") as HTMLSelectElement,
			"PROGRESSIVE_MOV",
		);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).muxings[0].destination.path).toBe(
			"exports/video/1080p",
		);
	});

	it("stays in the full view while a setting the short view cannot show is in use", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		await user.click(screen.getByRole("button", { name: "3. Ladder" }));
		const guard = screen.getByRole("checkbox", {
			name: /Guard audio renditions/,
		});
		await user.click(guard);
		const back = screen.getByRole("button", { name: "Back to simple view" });
		expect(back).toBeDisabled();
		expect(back).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Ladder.",
		);

		await user.click(guard);
		expect(back).toBeEnabled();
		// Packaging is not a step of the short view, and has another number than
		// any step that is: the format step stands in for it.
		await user.click(screen.getByRole("button", { name: "5. Packaging" }));
		await user.click(back);
		expect(steps()).toHaveLength(6);
		current("3. Format");
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mp4");
	});

	it("opens a draft saved on a step the short view leaves out on the format step", async () => {
		await restore(ready, 4);
		expect(steps()).toHaveLength(6);
		current("3. Format");
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mp4");
	});

	it("shows the stream a file reads when it is gone from the sources, so it can be replaced", async () => {
		const user = userEvent.setup();
		const [file] = ready.videos as [WizardState["videos"][number]];
		await restore({
			...ready,
			videos: [{ ...file, extras: { source: "removed-track" } }],
		});
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		// With one input there is nothing to choose, and the field is left out —
		// which would leave this reference with nowhere to be changed.
		const source = screen.getByRole("combobox", { name: "Video source" });
		expect(source).toHaveValue("removed-track");
		expect(
			within(source)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["removed-track (missing)", "Input video track (implicit)"]);
		expect(screen.getByText(/\[PLAN_UNRESOLVED_REF\]/)).toBeInTheDocument();

		await user.selectOptions(source, "Input video track (implicit)");
		expect(screen.queryByText(/\[PLAN_UNRESOLVED_REF\]/)).toBeNull();
		expect(screen.queryByRole("combobox", { name: "Video source" })).toBeNull();
	});

	it("keeps the audio inside the file when the ladder step changes its bitrate", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		await user.click(screen.getByRole("button", { name: "3. Ladder" }));
		const bitrate = screen.getByRole("spinbutton", { name: "Audio 1 bitrate" });
		await user.clear(bitrate);
		await user.type(bitrate, "256000");
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		const plan = JSON.parse(planJson());
		expect(plan.muxings).toHaveLength(1);
		expect(plan.muxings[0].additionalStreamKeys).toEqual(["a256"]);
		expect(
			screen.getByRole("button", { name: "Back to simple view" }),
		).toBeEnabled();
	});

	it("keeps the audio inside the file while its bitrate is typed through another track's", async () => {
		const user = userEvent.setup();
		const [track] = ready.audios as [WizardState["audios"][number]];
		// A second track of 64 kbps in a container of its own, ahead of the one
		// the file carries: 640000 typed into that one is 64000 on the way.
		await restore({
			...ready,
			audios: [{ ...track, bitrate: 64_000, muxing: undefined }, track],
		});
		expect(steps()).toHaveLength(8);
		await user.click(screen.getByRole("button", { name: "3. Ladder" }));
		const bitrate = screen.getByRole("spinbutton", { name: "Audio 2 bitrate" });
		await user.clear(bitrate);
		await user.type(bitrate, "64000");
		// For this keystroke the two tracks have one key, and the job says so.
		expect(
			screen.getAllByText(/\[PLAN_DUPLICATE_KEY\]/).length,
		).toBeGreaterThan(0);
		await user.type(bitrate, "0");
		expect(bitrate).toHaveValue(640_000);
		expect(screen.queryByText(/\[PLAN_DUPLICATE_KEY\]/)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(
			JSON.parse(planJson()).muxings.map(
				(muxing: {
					kind: string;
					streamKey: string;
					additionalStreamKeys?: string[];
				}) => [
					muxing.kind,
					muxing.streamKey,
					...(muxing.additionalStreamKeys ?? []),
				],
			),
		).toEqual([
			["MP4", "v1080", "a640"],
			["FMP4", "a64"],
		]);
	});

	it("shows in Packaging the track a file carries while two tracks have one key, and keeps a track picked then", async () => {
		const user = userEvent.setup();
		const [track] = ready.audios as [WizardState["audios"][number]];
		// The second track is switched off as a container of its own by hand, so
		// what the step says of it does not change with what carries it.
		await restore({
			...ready,
			audios: [
				{ ...track, bitrate: 64_000, muxing: undefined },
				{ ...track, muxing: { ownContainer: false } },
			],
		});
		await user.click(screen.getByRole("button", { name: "3. Ladder" }));
		const bitrate = () =>
			screen.getByRole("spinbutton", { name: "Audio 2 bitrate" });
		await user.clear(bitrate());
		await user.type(bitrate(), "64000");
		await user.click(screen.getByRole("button", { name: "5. Packaging" }));
		const carried = () =>
			document.getElementById("wz-mx-v-0-muxaudio") as HTMLSelectElement;
		// The file is offered its track under the name it carries it by — the key
		// of the keystroke before, 6400 — not the key the two tracks have between
		// them, which would show it as carrying nothing.
		expect(carried()).toHaveValue("a6");
		expect([...carried().options].map((option) => option.value)).toEqual([
			"",
			"a64",
			"a6",
		]);
		expect(
			document.getElementById("wz-mx-a-1-own"),
		).toHaveAccessibleDescription(
			"No container of its own — this track ships only inside the video containers that carry it.",
		);
		await user.selectOptions(carried(), "");
		await user.selectOptions(carried(), "a6");

		await user.click(screen.getByRole("button", { name: "3. Ladder" }));
		await user.type(bitrate(), "0");
		expect(bitrate()).toHaveValue(640_000);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(
			JSON.parse(planJson()).muxings.map(
				(muxing: {
					kind: string;
					streamKey: string;
					additionalStreamKeys?: string[];
				}) => [
					muxing.kind,
					muxing.streamKey,
					...(muxing.additionalStreamKeys ?? []),
				],
			),
		).toEqual([
			["MP4", "v1080", "a640"],
			["FMP4", "a64"],
		]);
	});

	it("opens a streaming plan loaded from JSON in the full view, with no switch to leave it by", async () => {
		renderWithQuery(<VodWizard flow="file" />);
		expect(screen.getByRole("link", { name: "Export files" })).toBeVisible();
		importJson(
			buildPlan({
				...DEFAULT_WIZARD_STATE,
				name: "ladder",
				accountId,
				inputFiles: ready.inputFiles,
				output: { ...DEFAULT_WIZARD_STATE.output, ...ready.output },
			}),
		);
		// The ladder and its manifest are in sight, not behind six steps.
		expect(steps()).toHaveLength(8);
		current("1. Basics");
		expect(screen.getByLabelText(/job name/i)).toHaveValue("ladder");
		// Following a link would drop the loaded plan.
		expect(screen.queryByRole("link", { name: "Export files" })).toBeNull();
		const back = screen.getByRole("button", { name: "Back to simple view" });
		expect(back).toBeDisabled();
		expect(back).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Packaging and Manifests.",
		);
	});

	it("opens a plan this flow built, loaded from JSON, on its six steps again", async () => {
		renderWithQuery(<VodWizard flow="file" />);
		importJson(buildPlan(ready));
		expect(steps()).toHaveLength(6);
		expect(screen.queryByRole("link", { name: "Export files" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "3. Format" }));
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mp4");
		await userEvent.click(screen.getByRole("button", { name: "6. Review" }));
		expect(screen.getByText("synthetic/exports/clip.mp4")).toBeInTheDocument();
	});

	it("sets AI Scene Analysis in the short view's own Encoding step, and lists its result with the file", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "5. Encoding" }));
		current("5. Encoding");
		await user.click(
			screen.getByRole("checkbox", { name: /Enable AI Scene Analysis/ }),
		);
		// The step is one of the short view's own: nothing is out of sight.
		expect(steps()).toHaveLength(6);

		// The file goes straight into the folder, which other jobs write to as well.
		// The result is not named after the job, so it starts in a folder that is.
		expect(screen.getByLabelText("Destination path")).toHaveValue("clip/");
		expect(await helpOf("Destination path")).toBe(
			"Relative to the destination folder",
		);

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(written("synthetic/exports/clip.mp4")).toBe(
			"synthetic/exports/clip.mp4",
		);
		expect(written("synthetic/exports/clip/analysis.json")).toBe(
			"synthetic/exports/clip/analysis.jsonAI Scene Analysis result",
		);

		const start = screen.getByRole("button", { name: "Start encoding" });
		await waitFor(() => expect(start).toBeEnabled());
		await user.click(start);
		await waitFor(() =>
			expect(push).toHaveBeenCalledWith(`/vod/jobs/${jobId}`),
		);
		const post = apiFetch.mock.calls.find(
			([, init]) => init?.method === "POST",
		);
		const { plan } = JSON.parse(post?.[1].body);
		expect(plan.aiSceneAnalysis).toEqual({
			assetDescription: {
				filename: "analysis.json",
				destination: expect.objectContaining({ path: "exports/clip/" }),
			},
		});
		expect(plan.muxings).toHaveLength(1);
		expect(plan.manifests ?? []).toEqual([]);
	});

	it("starts what the job writes besides its files in a folder named after the job", async () => {
		const user = userEvent.setup();
		await restore(ready, 5, true);
		await user.click(
			screen.getByRole("checkbox", { name: /Enable AI Scene Analysis/ }),
		);
		await user.click(
			screen.getByRole("checkbox", { name: "Run VMAF QC after encoding" }),
		);
		await user.click(
			screen.getByRole("checkbox", {
				name: "Enable Kantar audio watermarking",
			}),
		);
		expect(screen.getByLabelText("Destination path")).toHaveValue("clip/");
		expect(screen.getByLabelText("Folder for the measured copies")).toHaveValue(
			"clip/",
		);
		expect(screen.getByLabelText("Report path")).toHaveValue("clip/");
		expect(await helpOf("Report path")).toBe(
			"Relative to the destination folder — where Kantar's processing report is written",
		);
		// The full view of this flow starts them there too: the files are in the
		// shared folder in either view.
		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		await user.click(
			screen.getByRole("checkbox", { name: /Enable AI Scene Analysis/ }),
		);
		await user.click(
			screen.getByRole("checkbox", { name: /Enable AI Scene Analysis/ }),
		);
		expect(screen.getByLabelText("Destination path")).toHaveValue("clip/");
	});

	it("moves that folder with the job's name, until another is typed for it", async () => {
		const user = userEvent.setup();
		await restore(
			{
				...ready,
				startOptions: {
					aiSceneAnalysis: { filename: "analysis.json", path: "clip/" },
				},
				qc: {
					vmaf: true,
					psnr: false,
					model: "vmaf_v0.6.1",
					mirrorPath: "clip/",
				},
				kantar: {
					credentialId,
					licenseId: 1,
					channelName: "channel",
					contentReference: "reference",
					serverUrl: "https://kantar.example",
					// Put somewhere else than the job's folder.
					reportPath: "reports/",
				},
			},
			0,
			true,
		);
		fireEvent.change(screen.getByLabelText("Job name"), {
			target: { value: "trailer" },
		});
		await user.click(screen.getByRole("button", { name: "5. Encoding" }));
		expect(screen.getByLabelText("Destination path")).toHaveValue("trailer/");
		expect(screen.getByLabelText("Folder for the measured copies")).toHaveValue(
			"trailer/",
		);
		expect(screen.getByLabelText("Report path")).toHaveValue("reports/");
		// A draft keeps no address, so the one the job needs is typed again.
		fireEvent.change(screen.getByLabelText("Server URL"), {
			target: { value: "https://kantar.example" },
		});

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(written("synthetic/exports/trailer.mp4")).toBe(
			"synthetic/exports/trailer.mp4",
		);
		expect(written("synthetic/exports/trailer/analysis.json")).toBe(
			"synthetic/exports/trailer/analysis.jsonAI Scene Analysis result",
		);
		expect(written("synthetic/exports/trailer/qc/")).toBe(
			"synthetic/exports/trailer/qc/Copies measured for quality (folder)",
		);
		expect(written("synthetic/exports/reports/")).toBe(
			"synthetic/exports/reports/Kantar report (folder)",
		);
	});

	it("puts the measured copies beside the files when their folder is left empty", async () => {
		const user = userEvent.setup();
		await restore(ready, 5, true);
		await user.click(
			screen.getByRole("checkbox", { name: "Run VMAF QC after encoding" }),
		);
		// One field says it: every file is in the one folder, so there is no
		// "beside each rendition" to choose apart from it.
		expect(
			screen.queryByRole("checkbox", {
				name: "Write the measured copies to one folder",
			}),
		).toBeNull();
		fireEvent.change(screen.getByLabelText("Folder for the measured copies"), {
			target: { value: "" },
		});
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect("mirrorPath" in JSON.parse(planJson()).qc).toBe(false);
		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(written("synthetic/exports/qc/")).toBe(
			"synthetic/exports/qc/Copies measured for quality (folder)",
		);
	});

	it("says in Review that the other destinations get the files and the copies, and not the result or the report", async () => {
		const mirrored: WizardState = {
			...ready,
			additionalOutputs: [
				{ credentialId, kind: "S3", bucket: "second", name: "Second" },
			],
		};
		await restore(mirrored, 5, true);
		const also =
			"The files and the measured copies are also written to the additional destinations (1).";
		const only =
			"The AI Scene Analysis result and the Kantar report are written to this destination only.";
		await userEvent.click(screen.getByRole("button", { name: "6. Review" }));
		expect(screen.getByText(also)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "5. Encoding" }));
		await userEvent.click(
			screen.getByRole("checkbox", { name: /Enable AI Scene Analysis/ }),
		);
		await userEvent.click(screen.getByRole("button", { name: "6. Review" }));
		expect(screen.getByText(`${also} ${only}`)).toBeInTheDocument();
	});

	it("says nothing about other destinations in a job that has one", async () => {
		await restore(ready, 5);
		expect(
			screen.queryByText(/are also written to the additional destinations/),
		).toBeNull();
	});

	it("has the input sequence editor in Sources, and keeps a job that uses it on the short view", async () => {
		const user = userEvent.setup();
		await restore(ready, 1);
		current("2. Sources");
		await user.click(screen.getByRole("button", { name: "Edit on timeline" }));
		expect(
			screen.getByRole("button", { name: "Use ordinary inputs" }),
		).toBeInTheDocument();
		expect(steps()).toHaveLength(6);
		// The sequence is part of the job in both views, and holds neither.
		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		expect(steps()).toHaveLength(8);
		const back = screen.getByRole("button", { name: "Back to simple view" });
		expect(back).toBeEnabled();
		await user.click(back);
		expect(steps()).toHaveLength(6);
		expect(
			screen.getByRole("button", { name: "Use ordinary inputs" }),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Use ordinary inputs" }),
		);
		expect(
			screen.getByRole("button", { name: "Edit on timeline" }),
		).toBeInTheDocument();
	});

	it("says on a source that a Dolby stream is read by something it cannot be made into", async () => {
		const user = userEvent.setup();
		await restore(
			{
				...ready,
				sources: {
					dolbyStreams: [
						{
							kind: "ATMOS",
							key: "atmos",
							inputFile: "main",
							inputFormat: "ADM",
						},
						{ kind: "VISION", key: "vision", videoInputFile: "main" },
						{ kind: "VISION_METADATA", key: "meta", inputFile: "main" },
					],
				},
			},
			2,
		);
		const ATMOS =
			"This is a Dolby Atmos stream, which only a Dolby Atmos track can read. Choose another source, or the job will be rejected.";
		const VISION =
			"This is a Dolby Vision stream, which only H.264, H.265 or AV1 video can read. Choose another source, or the job will be rejected.";
		const video = screen.getByRole("combobox", { name: "Video source" });
		const audio = screen.getByRole("combobox", { name: "Audio source" });
		const refused = () =>
			screen.queryAllByText(/\[PLAN_STREAM_SOURCE_MISMATCH\]/).length;
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(video).not.toHaveAccessibleDescription();
		expect(audio).not.toHaveAccessibleDescription();
		expect(refused()).toBe(0);
		await user.selectOptions(video, "atmos");
		expect(video).toHaveAccessibleDescription(ATMOS);
		expect(refused()).toBe(1);
		// A Dolby Vision stream is what H.264 is made from.
		await user.selectOptions(video, "vision");
		expect(video).not.toHaveAccessibleDescription();
		expect(refused()).toBe(0);
		await user.selectOptions(audio, "vision");
		expect(audio).toHaveAccessibleDescription(VISION);
		expect(refused()).toBe(1);
		await user.selectOptions(audio, "");
		expect(audio).not.toHaveAccessibleDescription();
		expect(refused()).toBe(0);
		// The lists offer the metadata stream too, which neither is made from.
		await user.selectOptions(video, "meta");
		expect(video).toHaveAccessibleDescription(
			"A file's video cannot be made from this stream. Choose another source, or the job will be rejected.",
		);
		expect(refused()).toBe(1);
		await user.selectOptions(video, "");
		await user.selectOptions(audio, "meta");
		expect(audio).toHaveAccessibleDescription(
			"A file's audio cannot be made from this stream. Choose another source, or the job will be rejected.",
		);
		expect(refused()).toBe(1);
	});

	it("says that AV1 with Dolby Vision is no file of this screen, and of audio beside Dolby Vision that Bitmovin names AAC and Dolby Atmos", async () => {
		const user = userEvent.setup();
		const [video] = ready.videos as [WizardState["videos"][number]];
		await restore(
			{
				...ready,
				videos: [
					{
						...video,
						codec: "AV1",
						av1: { dynamicRangeFormat: "DOLBY_VISION_PROFILE_10_0" },
					},
				],
			},
			2,
		);
		const codec = screen.getByRole("combobox", { name: "Codec" });
		expect(codec).toHaveAccessibleDescription(
			"AV1 with Dolby Vision is written as fMP4 only, which is not a file of this screen. Choose another dynamic range in the options below, or the job will be rejected.",
		);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(
			screen.getByText(/\[PLAN_MUXING_CODEC_MISMATCH\]/),
		).toBeInTheDocument();
		cleanup();

		await restore(
			{
				...ready,
				videos: [
					{
						...video,
						codec: "H265",
						h265: { dynamicRangeFormat: "DOLBY_VISION_PROFILE_8_1" },
					},
				],
			},
			2,
		);
		const audioCodec = screen.getByRole("combobox", { name: "Audio codec" });
		const warned = () =>
			screen.queryAllByText(/\[PLAN_MUXING_DOLBY_VISION_AUDIO\]/).length;
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(audioCodec).not.toHaveAccessibleDescription();
		expect(warned()).toBe(0);
		await user.selectOptions(audioCodec, "DDPLUS");
		expect(audioCodec).toHaveAccessibleDescription(
			"Bitmovin's rules name AAC and Dolby Atmos audio only beside Dolby Vision video in one file. The job may be refused: check the first file it writes, or use AAC.",
		);
		expect(warned()).toBe(1);
		await user.selectOptions(audioCodec, "AAC");
		expect(audioCodec).not.toHaveAccessibleDescription();
		expect(warned()).toBe(0);
	});

	it("says in Format that an input sequence without audio writes the file without it, and that the sources are the sequence's", async () => {
		const user = userEvent.setup();
		await restore(
			{
				...ready,
				sources: {
					dolbyStreams: [
						{
							kind: "ATMOS",
							key: "atmos",
							inputFile: "main",
							inputFormat: "ADM",
						},
					],
				},
				audios: (ready.audios ?? []).map((audio) => ({
					...audio,
					extras: { ...audio.extras, source: "atmos" },
				})),
				inputTimeline: {
					schemaVersion: 2,
					id: "00000000-0000-4000-8000-000000000001",
					audioEnabled: false,
					durationMs: 8000,
					videoClips: [
						{
							id: "00000000-0000-4000-8000-000000000002",
							sourceKey: "main",
							startMs: 0,
							inMs: 0,
							outMs: 8000,
						},
					],
					audioClips: [],
				},
			},
			2,
		);
		current("2. Sources");
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		const include = screen.getByRole("checkbox", { name: "Include audio" });
		expect(include).toBeChecked();
		const WITHOUT =
			"The input sequence in the Sources step has no audio, so this file is written without audio. Switch audio on in the sequence and place audio clips, or return to ordinary inputs.";
		expect(include).toHaveAccessibleDescription(WITHOUT);
		expect(screen.getByText(WITHOUT)).toHaveAttribute("role", "alert");
		// The plan reads the sequence, so an AAC track that names an Atmos stream
		// is not refused, and is not said to be.
		const UNUSED =
			"Not used while the input sequence is on: every file is made from the sequence in the Sources step.";
		const source = screen.getByRole("combobox", { name: "Audio source" });
		expect(source).toHaveValue("atmos");
		expect(source).toHaveAccessibleDescription(UNUSED);
		expect(
			screen.getByRole("combobox", { name: "Video source" }),
		).toHaveAccessibleDescription(UNUSED);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(screen.queryByText(/\[PLAN_STREAM_SOURCE_MISMATCH\]/)).toBeNull();
		expect(planned()).toEqual([["MP4", "clip.mp4", "v1080:H264"]]);
		await user.click(include);
		expect(screen.queryByText(WITHOUT)).toBeNull();
	});

	it("takes HEVCv2's own settings off a file when another account turns it into H.265", async () => {
		const user = userEvent.setup();
		const other = "33333333-3333-4333-8333-333333333334";
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
			init?.method === "POST"
				? { id: jobId }
				: url === "/api/credentials"
					? [{ id: credentialId, label: "Storage", provider: "AWS_S3" }]
					: url === "/api/bitmovin-accounts"
						? [
								{ id: accountId, label: "Account", internalHevcV2: true },
								{ id: other, label: "Other", internalHevcV2: false },
							]
						: url.startsWith("/api/infrastructure/") ||
								url === "/api/vmaf-compute-profiles"
							? { items: [] }
							: [],
		);
		// The file as the Format step makes it: HEVCv2, with a setting only it has.
		const v2 = { ...ready, ...editFile(ready, 0, { codec: "H265V2" }) };
		await restore(
			{
				...v2,
				...editFile(v2, 0, {
					h265: { motionCompensatedTemporalFiltering: "ON" } as never,
				}),
			},
			0,
		);
		const account = screen.getByRole("combobox", { name: "Bitmovin account" });
		await waitFor(() =>
			expect(within(account).getAllByRole("option").length).toBeGreaterThan(1),
		);
		expect(steps()).toHaveLength(6);
		await user.selectOptions(account, other);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		expect(screen.getByRole("combobox", { name: "Codec" })).toHaveValue("H265");
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(planJson()).not.toContain("motionCompensatedTemporalFiltering");
		expect(
			screen.queryByText(/\[PLAN_INTERNAL_HEVC_V2_UNSUPPORTED\]/),
		).toBeNull();
	});

	it("opens a draft with an input sequence on Sources, in the short view", async () => {
		await restore(
			{
				...ready,
				inputTimeline: {
					schemaVersion: 2,
					id: "00000000-0000-4000-8000-000000000001",
					audioEnabled: true,
					durationMs: 0,
					videoClips: [],
					audioClips: [],
				},
			},
			2,
		);
		expect(steps()).toHaveLength(6);
		current("2. Sources");
		expect(
			screen.getByRole("button", { name: "Use ordinary inputs" }),
		).toBeInTheDocument();
	});

	it("leaves the encodings a job is split into to the full view, and stays there while one is set", async () => {
		const user = userEvent.setup();
		await restore(ready, 1);
		current("2. Sources");
		// The other parts of the step are here.
		expect(screen.getByText(/^Keyframes/)).toBeInTheDocument();
		expect(screen.queryByText(/^Multi-encoding partition/)).toBeNull();

		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		await user.click(screen.getByText(/^Multi-encoding partition/));
		await user.click(screen.getByRole("button", { name: "Add encoding" }));
		const back = screen.getByRole("button", { name: "Back to simple view" });
		expect(back).toBeDisabled();
		expect(back).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Sources (multi-encoding partition).",
		);
		await user.click(screen.getByRole("button", { name: "Remove encoding 1" }));
		expect(back).toBeEnabled();
	});

	it("keeps a draft that uses the Encoding step on the short view, on that step", async () => {
		await restore(
			{
				...ready,
				labels: ["team-a"],
				startOptions: {
					aiSceneAnalysis: { filename: "analysis.json", path: "ai" },
				},
			},
			5,
		);
		expect(steps()).toHaveLength(6);
		current("5. Encoding");
		expect(
			screen.getByRole("checkbox", { name: /Enable AI Scene Analysis/ }),
		).toBeChecked();
		await userEvent.click(screen.getByRole("button", { name: "6. Review" }));
		expect(written("synthetic/exports/ai/analysis.json")).toBe(
			"synthetic/exports/ai/analysis.jsonAI Scene Analysis result",
		);
	});

	it("names the files where the full view names the ladder, for a mode set per file", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "5. Encoding" }));
		const mode = () => screen.getByLabelText("Encoding mode");
		const help = async () => {
			await user.click(
				screen.getByRole("button", {
					name: "Encoding mode — more information",
				}),
			);
			return screen.getByRole("note").textContent;
		};
		// An H.264 file takes its preset's mode, so the job has none of its own.
		expect(mode()).toBeDisabled();
		expect(within(mode()).getAllByRole("option")[0]).toHaveTextContent(
			"Use each file's encoding mode / preset",
		);
		expect(await help()).toContain(
			"Set the encoding mode or preset of each file in the Format step.",
		);

		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		current("6. Encoding");
		expect(within(mode()).getAllByRole("option")[0]).toHaveTextContent(
			"Use ladder encoding modes / presets",
		);
		expect(await help()).toContain("Set encoding modes or presets in step 3.");
	});

	it("leaves the Per-Title configuration to the full view, and stays there while a codec is switched on", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "5. Encoding" }));
		expect(screen.queryByText("Per-Title configuration")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		expect(screen.getByText("Per-Title configuration")).toBeInTheDocument();
		const codec = screen.getByRole("checkbox", {
			name: /Enable h264 per-title/i,
		});
		const back = screen.getByRole("button", { name: "Back to simple view" });
		await user.click(codec);
		expect(back).toBeDisabled();
		expect(back).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Encoding (Per-Title configuration).",
		);

		await user.click(codec);
		expect(back).toBeEnabled();
		await user.click(back);
		expect(steps()).toHaveLength(6);
		current("5. Encoding");
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).perTitle).toBeUndefined();
	});

	it("says in Format and in Review that a job which only measures writes none of its files", async () => {
		const user = userEvent.setup();
		await restore(ready, 5, true);
		await user.click(
			screen.getByRole("checkbox", { name: "Run VMAF QC after encoding" }),
		);
		// The help of the option says what it adds, in the words of this view.
		const adds = screen.getByRole("button", {
			name: "Run VMAF QC after encoding — more information",
		});
		expect(adds).toHaveAccessibleDescription(
			/^Adds a copy of each file's video to measure \(MP4, or WebM for a VP9 file\), written to qc\/ in the folder for the measured copies\./,
		);
		expect(adds).not.toHaveAccessibleDescription(/rendition/);
		// The folder is the job's own: a copy is not named after the job.
		expect(screen.getByLabelText("Folder for the measured copies")).toHaveValue(
			"clip/",
		);
		expect(await helpOf("Folder for the measured copies")).toMatch(
			/^Relative to the destination folder\. The copies are written to qc\/ inside it; empty puts qc\/ straight into the destination folder\./,
		);
		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(written("synthetic/exports/clip.mp4")).toBe(
			"synthetic/exports/clip.mp4",
		);
		expect(written("synthetic/exports/clip/qc/")).toBe(
			"synthetic/exports/clip/qc/Copies measured for quality (folder)",
		);

		await user.click(screen.getByRole("button", { name: "5. Encoding" }));
		// The option is named for the files: this view has no delivery outputs.
		expect(
			screen.queryByRole("checkbox", {
				name: "VMAF only (skip delivery outputs)",
			}),
		).toBeNull();
		// So is its help: what is written, and where, in the words of this view.
		const help = screen.getByRole("button", {
			name: "VMAF only (do not write the files) — more information",
		});
		expect(help).toHaveAccessibleDescription(
			/^Writes only the copies that are measured: one per file \(MP4, or WebM for a VP9 file\), in qc\/ in the folder for the measured copies\./,
		);
		expect(help).not.toHaveAccessibleDescription(/manifest|ladder|rendition/i);
		await user.click(
			screen.getByRole("checkbox", {
				name: "VMAF only (do not write the files)",
			}),
		);
		const told =
			"“VMAF only (do not write the files)” is on (Encoding → Quality control). This job writes only the copies it measures, which the Review step lists: the files below are not written, and audio is left out.";
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		expect(screen.getByText(told)).toBeInTheDocument();
		// The files stay editable: what they set is what gets measured.
		expect(screen.getByLabelText("Height (p)")).toBeEnabled();

		await user.click(screen.getByRole("button", { name: "6. Review" }));
		expect(screen.queryByText("synthetic/exports/clip.mp4")).toBeNull();
		expect(written("synthetic/exports/clip/qc/")).toBe(
			"synthetic/exports/clip/qc/Copies measured for quality (folder)",
		);
		expect(
			screen.getByText(
				"“VMAF only (do not write the files)” is on: this job measures the video of each file and does not write the files.",
			),
		).toBeInTheDocument();
		// The file carries the audio track, and such a job has no audio to carry.
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		const plan = JSON.parse(planJson());
		expect(
			plan.renditions.map((rendition: { key: string }) => rendition.key),
		).toEqual(["v1080"]);
		expect(plan.muxings[0].additionalStreamKeys).toBeUndefined();
		expect(screen.queryByText(/\[PLAN_UNRESOLVED_REF\]/)).toBeNull();
		expect(
			screen.getByRole("button", { name: "Start encoding" }),
		).toBeEnabled();

		// Unticked, the job writes its file again, audio and all.
		await user.click(screen.getByRole("button", { name: "5. Encoding" }));
		await user.click(
			screen.getByRole("checkbox", {
				name: "VMAF only (do not write the files)",
			}),
		);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		expect(screen.queryByText(told)).toBeNull();
		expect(JSON.parse(planJson()).muxings[0].additionalStreamKeys).toEqual([
			"a192",
		]);
	});

	it("offers a quality gate that records its verdict, and leaves holding the manifests back to the full view", async () => {
		const user = userEvent.setup();
		await restore(ready, 5, true);
		await user.click(
			screen.getByRole("checkbox", { name: "Run VMAF QC after encoding" }),
		);
		await user.click(screen.getByRole("button", { name: "Add gate rule" }));
		// A job of files has no manifest to hold back, so there is nothing to choose.
		expect(screen.queryByText("On fail")).toBeNull();
		const hint = () =>
			screen.getByRole("button", { name: "QC gate — more information" });
		expect(hint()).toHaveAccessibleDescription(
			/does not stop the files from being written/,
		);
		expect(hint()).not.toHaveAccessibleDescription(/BLOCK_MANIFESTS|ladder/);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).qc.gate.onFail).toBe("MARK_ONLY");

		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		expect(screen.getByText("On fail")).toBeInTheDocument();
		expect(hint()).toHaveAccessibleDescription(
			/BLOCK_MANIFESTS holds manifest generation/,
		);
		const back = screen.getByRole("button", { name: "Back to simple view" });
		expect(back).toBeEnabled();
		await user.click(
			screen.getByRole("radio", {
				name: "Blocks manifest generation on fail",
			}),
		);
		expect(back).toBeDisabled();
		expect(back).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Encoding (a QC gate that blocks manifest generation).",
		);
		await user.click(
			screen.getByRole("radio", {
				name: "Mark-only on fail (delivery proceeds)",
			}),
		);
		expect(back).toBeEnabled();
	});

	it("makes a gate rule for every file, and leaves choosing among them to the full view, where a file has a key", async () => {
		const user = userEvent.setup();
		await restore(ready, 5, true);
		await user.click(
			screen.getByRole("checkbox", { name: "Run VMAF QC after encoding" }),
		);
		await user.click(screen.getByRole("button", { name: "Add gate rule" }));
		// A file's key follows its height and bitrate here, so no rule names one.
		expect(screen.queryByText(/Target renditions/)).toBeNull();
		expect(screen.queryByRole("checkbox", { name: "v1080" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).qc.gate.rules).toEqual([
			{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 },
		]);

		await user.click(screen.getByRole("button", { name: "Show all settings" }));
		expect(
			screen.getByText("Target renditions (none selected = all)"),
		).toBeInTheDocument();
		const back = screen.getByRole("button", { name: "Back to simple view" });
		expect(back).toBeEnabled();
		await user.click(screen.getByRole("checkbox", { name: "v1080" }));
		expect(JSON.parse(planJson()).qc.gate.rules[0].renditions).toEqual([
			"v1080",
		]);
		expect(back).toBeDisabled();
		expect(back).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Encoding (a QC gate rule for selected renditions).",
		);
		await user.click(screen.getByRole("checkbox", { name: "v1080" }));
		expect(back).toBeEnabled();
	});

	it("opens a draft whose gate rule names a file in the full view, on the Encoding step", async () => {
		await restore(
			{
				...ready,
				qc: {
					vmaf: true,
					psnr: false,
					model: "vmaf_v0.6.1",
					gate: {
						rules: [
							{
								metric: "VMAF_MEAN",
								scope: "PER_RENDITION",
								gte: 80,
								renditions: ["v1080"],
							},
						],
						onFail: "MARK_ONLY",
					},
				},
			},
			5,
			true,
		);
		expect(steps()).toHaveLength(8);
		current("6. Encoding");
		expect(screen.getByRole("checkbox", { name: "v1080" })).toBeChecked();
	});

	it("stays in the full view while “VMAF only” holds back a manifest set there", async () => {
		const user = userEvent.setup();
		// The manifest is not in the plan while the option is on, and the short
		// view's Encoding step could untick the option.
		await restore(
			{
				...ready,
				manifests: { hls: true, dash: false },
				qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1", only: true },
			},
			5,
			true,
		);
		expect(steps()).toHaveLength(8);
		current("6. Encoding");
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(JSON.parse(planJson()).manifests ?? []).toEqual([]);
		expect(
			screen.getByRole("button", { name: "Back to simple view" }),
		).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Manifests.",
		);
	});

	it("says in the short view where a file gets its audio, when Kantar has none to mark", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		await user.click(screen.getByRole("checkbox", { name: "Include audio" }));
		await user.click(screen.getByRole("button", { name: "5. Encoding" }));
		await user.click(
			screen.getByRole("checkbox", {
				name: "Enable Kantar audio watermarking",
			}),
		);
		expect(
			screen.getByText(
				"No file has an audio track. Turn on “Include audio” for a file in the Format step, or the job will be rejected (Kantar watermarks audio).",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/add one on the Ladder step/)).toBeNull();
	});

	it("opens a draft that sets a hidden step in the full view, and says which step", async () => {
		await restore({ ...ready, manifests: { hls: true, dash: false } }, 6);
		expect(steps()).toHaveLength(8);
		expect(
			screen.getByRole("button", { name: "7. Manifests" }),
		).toHaveAttribute("aria-current", "step");
		expect(
			screen.getByRole("button", { name: "Back to simple view" }),
		).toHaveAccessibleDescription(
			"Settings the simple view does not show are in use in: Manifests.",
		);
	});
});
