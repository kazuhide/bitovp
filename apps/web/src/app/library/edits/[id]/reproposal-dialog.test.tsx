import { toCompositionDocument } from "@bitovp/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { ReproposalDialog } from "./reproposal-dialog";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	canMutate: true,
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => mocks.canMutate,
}));
vi.mock("../../[id]/edits/use-editing-actor", () => ({
	useEditingActor: () => "operator:org",
}));
vi.mock("../../[id]/edits/association-review", () => ({
	AssociationReview: ({ onVerified }: { onVerified(value: boolean): void }) => (
		<button type="button" onClick={() => onVerified(true)}>
			Association checked
		</button>
	),
}));
const task = "44444444-4444-4444-8444-444444444444";
function fixture() {
	const project = editingProjectFixture();
	const document = toCompositionDocument(project.draft);
	document.analysisRevisionId = "33333333-3333-4333-8333-333333333333";
	const source = {
		sourceId: project.media.sourceId,
		files: [],
		mediaVersions: [project.media],
		analyses: [
			{ id: document.analysisRevisionId, locale: "en", title: "Source" },
		],
		localStoryAvailable: false,
		captionTranslationAvailable: true,
	};
	return { project, document, source };
}
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.canMutate = true;
});
function tree(beforeStart = vi.fn(async () => {}), dirty = false) {
	const data = fixture(),
		reframe = vi.fn(),
		onBusy = vi.fn();
	mocks.api.mockImplementation(async (url: string) => {
		if (url.endsWith("/editing-eligibility")) return data.source;
		return { taskId: task, state: "PENDING", cached: false };
	});
	renderWithQuery(
		<ReproposalDialog
			project={{ ...data.project, draft: data.document }}
			document={data.document}
			actorIdentity="operator:org"
			dirty={dirty}
			disabled={false}
			onReframe={reframe}
			beforeStart={beforeStart}
			onBusyChange={onBusy}
		/>,
	);
	return { ...data, beforeStart, reframe, onBusy };
}
async function open() {
	fireEvent.click(screen.getByRole("button", { name: "Revise this proposal" }));
	return screen.findByRole("dialog", { name: "Revise the edit" });
}
async function prepareForm() {
	const dialog = await open();
	await within(dialog).findByRole("button", { name: "Association checked" });
	fireEvent.click(
		within(dialog).getByText("Caption, framing and scene settings"),
	);
	fireEvent.click(
		within(dialog).getByRole("button", { name: "Association checked" }),
	);
	return dialog;
}

it("loads nothing until opened and can change the current crop without an inference or export", async () => {
	const { reframe } = tree();
	expect(mocks.api).not.toHaveBeenCalled();
	const dialog = await open();
	fireEvent.click(within(dialog).getByRole("button", { name: "Crop to fill" }));
	expect(reframe).toHaveBeenCalledExactlyOnceWith("FILL");
	expect(
		mocks.api.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
	expect(mocks.push).not.toHaveBeenCalled();
});

it("saves the current edit first, then creates a separate Japanese DRAFT with crop-to-fill", async () => {
	const order: string[] = [];
	const beforeStart = vi.fn(async () => {
		order.push("save");
	});
	const data = tree(beforeStart, true);
	const baseHandler = mocks.api.getMockImplementation();
	mocks.api.mockImplementation(async (url, options) => {
		if (options?.method === "POST") order.push("generate");
		return baseHandler?.(url, options);
	});
	const dialog = await prepareForm();
	fireEvent.change(within(dialog).getByRole("combobox", { name: "Captions" }), {
		target: { value: "JAPANESE" },
	});
	fireEvent.change(
		within(dialog).getByRole("combobox", { name: "Video framing" }),
		{ target: { value: "FILL" } },
	);
	fireEvent.click(
		within(dialog).getByRole("button", {
			name: "Save and create another proposal",
		}),
	);
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${task}`),
	);
	expect(order).toEqual(["save", "generate"]);
	const calls = mocks.api.mock.calls.filter(
		([, options]) => options?.method === "POST",
	);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.[0]).toBe("/api/library/media-tasks");
	const body = JSON.parse(calls[0]?.[1].body);
	expect(body).toMatchObject({
		kind: "GENERATE",
		mediaVersionId: data.project.media.id,
		analysisRevisionId: data.document.analysisRevisionId,
		parameters: {
			contentId: data.project.contentId,
			renderMode: "DRAFT",
			captions: "JAPANESE",
			variants: 1,
			presentation: { videoFit: "FILL" },
		},
	});
	expect(
		mocks.api.mock.calls.some(([url]) => /\/renders|\/revisions/.test(url)),
	).toBe(false);
});

it("does not submit a new proposal if saving the original edit fails", async () => {
	tree(
		vi.fn(async () => {
			throw new Error("private save details");
		}),
		true,
	);
	const dialog = await prepareForm();
	fireEvent.click(
		within(dialog).getByRole("button", {
			name: "Save and create another proposal",
		}),
	);
	await within(dialog).findByRole("alert");
	expect(
		mocks.api.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
	expect(mocks.push).not.toHaveBeenCalled();
	expect(
		screen.queryByText(/private save details|request result is unknown/i),
	).not.toBeInTheDocument();
});

it.each([
	false,
	true,
])("retains the exact uncertain request across reopen even when capabilities change (%s)", async (capabilitiesChange) => {
	const data = tree();
	let posts = 0;
	const handler = mocks.api.getMockImplementation();
	mocks.api.mockImplementation(async (url, options) => {
		if (options?.method === "POST" && ++posts === 1)
			throw new TypeError("lost response");
		return handler?.(url, options);
	});
	let dialog = await prepareForm();
	fireEvent.click(
		within(dialog).getByRole("button", { name: "Create another proposal" }),
	);
	await within(dialog).findByRole("alert");
	if (capabilitiesChange) {
		data.source.localStoryAvailable = true;
		data.source.captionTranslationAvailable = false;
	}
	fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
	await waitFor(() =>
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
	);
	dialog = await open();
	const retry = await within(dialog).findByRole("button", {
		name: "Check the same project request",
	});
	fireEvent.click(
		within(dialog).getByRole("button", { name: "Association checked" }),
	);
	fireEvent.click(retry);
	await waitFor(() => expect(mocks.push).toHaveBeenCalled());
	const bodies = mocks.api.mock.calls
		.filter(([, options]) => options?.method === "POST")
		.map(([, options]) => options.body);
	expect(bodies).toHaveLength(2);
	expect(bodies[1]).toBe(bodies[0]);
});

it("does not offer mutation actions to a viewer", () => {
	mocks.canMutate = false;
	tree();
	expect(
		screen.getByRole("button", { name: "Revise this proposal" }),
	).toBeDisabled();
	expect(mocks.api).not.toHaveBeenCalled();
});

it("shows an unavailable source after a completed lookup and still allows local framing changes", async () => {
	const data = tree();
	mocks.api.mockResolvedValue({ ...data.source, mediaVersions: [] });
	const dialog = await open();
	await within(dialog).findByText(
		"The video or AISA metadata used by this edit is no longer available for a new proposal.",
	);
	expect(
		within(dialog).queryByText("Checking the editing source…"),
	).not.toBeInTheDocument();
	fireEvent.click(within(dialog).getByRole("button", { name: "Crop to fill" }));
	expect(data.reframe).toHaveBeenCalledWith("FILL");
	expect(
		mocks.api.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
});
