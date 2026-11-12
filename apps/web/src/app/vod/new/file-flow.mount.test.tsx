import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOD_FLOW_COOKIE } from "@/lib/vod-flow";
import { draftKey, writeWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import type { WizardState } from "./build-plan";
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

		await user.click(
			screen.getByRole("button", { name: "Back to simple view" }),
		);
		expect(steps()).toHaveLength(5);
		expect(planJson()).toBe(before);
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
		await user.click(back);
		// The ladder is not a step of the short view; the format step stands in for it.
		expect(screen.getByRole("button", { name: "3. Format" })).toHaveAttribute(
			"aria-current",
			"step",
		);
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
