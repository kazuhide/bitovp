import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOD_FLOW_COOKIE } from "@/lib/vod-flow";
import { draftKey, writeWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { FILE_OUTPUT_DEFAULT_STATE, renameFileJob } from "./file-output";
import { VodWizard } from "./wizard";

/**
 * The file-output flow, mounted: the same wizard and the same state, opened on a
 * short view. What these check is the part no pure test can — that the view shows
 * five steps, that the full steps stay reachable without changing the job, and that
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

async function restore(state: WizardState, step = 0) {
	writeWizardDraft(fileDraft, "vod", state, step);
	renderWithQuery(<VodWizard flow="file" />);
	await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
}

function planJson(): string {
	return screen.getByTestId("plan-json").textContent ?? "";
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
					: [],
	);
});

describe("VodWizard — the file-output flow", () => {
	it.each([
		[
			"en",
			["1. Basics", "2. Sources", "3. Format", "4. Destination", "5. Review"],
			"Export files",
			"File 1",
			"File name",
			"Include audio in every file",
		],
		[
			"ja",
			["1. 基本", "2. ソース", "3. 出力形式", "4. 保存先", "5. 確認"],
			"ファイルを書き出す",
			"ファイル 1",
			"ファイル名",
			"すべてのファイルに音声を入れる",
		],
	] as const)("opens on five steps with one MP4 that carries the audio (%s)", async (locale, labels, current, file, fileName, audio) => {
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
		expect(screen.getByRole("checkbox", { name: audio })).toBeChecked();
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

		await user.click(screen.getByRole("button", { name: "5. Review" }));
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
		await user.click(
			screen.getByRole("checkbox", { name: "Include audio in every file" }),
		);
		expect(
			screen.getByText("The files are written without an audio track."),
		).toBeInTheDocument();

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
		]);
		expect(
			files().muxings.map((muxing) => [
				muxing.filename,
				muxing.additionalStreamKeys ?? [],
			]),
		).toEqual([
			["clip.mp4", []],
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
		expect(files().muxings.map((muxing) => muxing.filename)).toEqual([
			"clip.mp4",
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
		await user.click(screen.getByRole("button", { name: "5. Review" }));
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
		expect(steps()).toHaveLength(5);
		await userEvent.click(screen.getByRole("button", { name: "5. Review" }));
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

		await user.click(screen.getByRole("button", { name: "5. Review" }));
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
		await user.click(screen.getByRole("button", { name: "5. Review" }));
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

		await user.click(screen.getByRole("button", { name: "5. Review" }));
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
		).toEqual(["MP4 (.mp4)", "MPEG-TS (.ts)", "QuickTime (.mov)"]);

		await user.selectOptions(container, "MPEG-TS (.ts)");
		expect(screen.getByLabelText("File name")).toHaveValue("clip.ts");
		expect(container).not.toHaveAccessibleDescription();

		await user.click(screen.getByRole("button", { name: "5. Review" }));
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

	it("says that QuickTime is not verified yet, and which container cannot hold the audio codec", async () => {
		const user = userEvent.setup();
		await restore(ready);
		await user.click(screen.getByRole("button", { name: "3. Format" }));
		const container = screen.getByRole("combobox", { name: "Container" });
		const audioCodec = within(
			screen.getByRole("region", { name: "Audio" }),
		).getByRole("combobox", { name: "Codec" });

		await user.selectOptions(audioCodec, "AC3");
		expect(audioCodec).not.toHaveAccessibleDescription();
		await user.selectOptions(container, "QuickTime (.mov)");
		expect(container).toHaveAccessibleDescription(
			"Not yet verified on a real encode. Check the first file this job writes.",
		);
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mov");
		// The codec that was chosen stays on show; only what fits is offered beside it.
		expect(audioCodec).toHaveValue("AC3");
		expect(audioCodec).toHaveAccessibleDescription(
			"QuickTime (.mov) cannot hold this codec.",
		);
		expect(
			within(audioCodec)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["AAC", "AC3"]);

		await user.selectOptions(audioCodec, "AAC");
		expect(audioCodec).not.toHaveAccessibleDescription();
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
		expect(screen.getByText("Files this job writes")).toBeInTheDocument();
		expect(screen.getByText("synthetic/exports/clip.mp4")).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Back to simple view" }),
		);
		expect(steps()).toHaveLength(5);
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
		expect(screen.queryByText("Files this job writes")).toBeNull();
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
		expect(steps()).toHaveLength(5);
		current("3. Format");
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mp4");
	});

	it("opens a draft saved on a step the short view leaves out on the format step", async () => {
		await restore(ready, 4);
		expect(steps()).toHaveLength(5);
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
		// The ladder and its manifest are in sight, not behind five steps.
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

	it("opens a plan this flow built, loaded from JSON, on its five steps again", async () => {
		renderWithQuery(<VodWizard flow="file" />);
		importJson(buildPlan(ready));
		expect(steps()).toHaveLength(5);
		expect(screen.queryByRole("link", { name: "Export files" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "3. Format" }));
		expect(screen.getByLabelText("File name")).toHaveValue("clip.mp4");
		await userEvent.click(screen.getByRole("button", { name: "5. Review" }));
		expect(screen.getByText("synthetic/exports/clip.mp4")).toBeInTheDocument();
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
