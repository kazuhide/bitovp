import {
	MAX_VOD_TIMELINE_SOURCES,
	vodInputPreviewSubmissionSchema,
} from "@bitovp/core/vod-input-timeline";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoragePickerSelection } from "@/components/storage-picker";
import type { DraftValue, WizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import {
	DEFAULT_WIZARD_STATE,
	type WizardInputFile,
	type WizardState,
} from "./build-plan";
import { SourceBin } from "./input-timeline/source-bin";
import type { VodInputTimelineEditorProps } from "./input-timeline/types";
import { VodWizard } from "./wizard";

const fixture = vi.hoisted(() => ({
	seed: null as unknown as WizardState,
	editor: null as unknown as VodInputTimelineEditorProps,
	patchSources: null as ((value: Partial<WizardState>) => void) | null,
	selection: null as unknown as StoragePickerSelection,
	api: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/wizard-draft-hook", () => ({
	useWizardDraft: ({
		onRestore,
	}: {
		onRestore: (draft: WizardDraft) => void;
	}) => ({
		available: true,
		restore: () =>
			onRestore({ step: 1, value: fixture.seed as unknown as DraftValue }),
		discard: vi.fn(),
		clear: vi.fn(),
	}),
}));
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
		onClose,
	}: {
		open: boolean;
		onSelect: (selection: StoragePickerSelection) => void;
		onClose: () => void;
	}) =>
		open ? (
			<div role="dialog" aria-label="Source picker">
				<button
					type="button"
					onClick={() => {
						onSelect(fixture.selection);
						onClose();
					}}
				>
					Choose source object
				</button>
			</div>
		) : null,
}));
vi.mock("./input-timeline/input-timeline-editor", () => ({
	VodInputTimelineEditor: (props: VodInputTimelineEditorProps) => {
		fixture.editor = props;
		return (
			<SourceBin
				sources={props.sources}
				facts={[]}
				selectedKey={null}
				disabled={false}
				canAdd={() => false}
				onSelect={vi.fn()}
				onAdd={vi.fn()}
				onAddSource={props.onAddSource}
			/>
		);
	},
}));
vi.mock("./sources-section", async (original) => ({
	...(await original<object>()),
	InputFilesEditor: ({
		onPatch,
	}: {
		onPatch: (value: Partial<WizardState>) => void;
	}) => {
		fixture.patchSources = onPatch;
		return null;
	},
}));

const credentialId = "00000000-0000-4000-8000-000000000001";
const media = (n: number): WizardInputFile => ({
	key: `media${n}`,
	inputKey: "shared",
	kind: "S3",
	credentialId,
	bucket: "inputs",
	path: `media${n}.mp4`,
});
const logo: WizardInputFile = {
	...media(99),
	key: "logo",
	path: "logo.png",
	purpose: "FILTER_IMAGE",
};
const empty: WizardInputFile = {
	key: "empty",
	inputKey: "empty_input",
	kind: "S3",
	credentialId: "",
	bucket: "",
	path: "",
};
function seed(files: WizardInputFile[]) {
	fixture.seed = {
		...DEFAULT_WIZARD_STATE,
		inputFiles: files,
		inputTimeline: {
			schemaVersion: 2,
			id: credentialId,
			audioEnabled: true,
			durationMs: 0,
			videoClips: [],
			audioClips: [],
		},
	};
}
function probeSources() {
	return fixture.editor.sources
		.filter((file) => file.path && file.purpose !== "FILTER_IMAGE")
		.map(({ key, credentialId, bucket, path }) => ({
			key,
			credentialId,
			bucket,
			objectKey: path,
		}));
}
async function mount() {
	const view = renderWithQuery(<VodWizard />);
	await waitFor(() =>
		expect(view.client.getQueryState(["credentials"])?.status).toBe("success"),
	);
	fireEvent.click(screen.getByRole("button", { name: "Restore" }));
	await screen.findByRole("button", { name: "Add source" });
}
function choose() {
	fireEvent.click(screen.getByRole("button", { name: "Choose source object" }));
}
beforeEach(() => {
	vi.clearAllMocks();
	fixture.patchSources = null;
	fixture.selection = { credentialId, bucket: "inputs", path: "chosen.mp4" };
	fixture.api.mockImplementation(async (url: string) =>
		url === "/api/credentials"
			? [{ id: credentialId, provider: "AWS_S3", label: "Source credential" }]
			: [],
	);
});

describe("Wizard timeline picker capacity", () => {
	it("accepts the sixteenth media source when a logo is also present", async () => {
		seed([...Array.from({ length: 15 }, (_, n) => media(n)), logo]);
		await mount();
		const add = screen.getByRole("button", { name: "Add source" });
		expect(add).toBeEnabled();
		fireEvent.click(add);
		choose();
		expect(
			fixture.editor.sources.some((file) => file.path === "chosen.mp4"),
		).toBe(true);
		expect(probeSources()).toHaveLength(MAX_VOD_TIMELINE_SOURCES);
		expect(
			vodInputPreviewSubmissionSchema.safeParse({
				kind: "PROBE",
				sources: probeSources(),
			}).success,
		).toBe(true);
		expect(fixture.editor.sources.find((file) => file.key === "logo")).toEqual(
			logo,
		);
		expect(screen.getByRole("button", { name: "Add source" })).toBeDisabled();
	});
	it("reuses an empty slot for the sixteenth media source without counting the logo", async () => {
		seed([...Array.from({ length: 15 }, (_, n) => media(n)), logo, empty]);
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Add source" }));
		choose();
		expect(fixture.editor.sources).toHaveLength(17);
		expect(
			fixture.editor.sources.find((file) => file.key === "empty"),
		).toMatchObject({ path: "chosen.mp4", inputKey: "shared" });
		expect(probeSources()).toHaveLength(16);
	});
	it("retains the default main keys when loading the first media source", async () => {
		seed([empty]);
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Add source" }));
		choose();
		expect(fixture.editor.sources).toHaveLength(1);
		expect(fixture.editor.sources[0]).toMatchObject({
			key: "empty",
			inputKey: "empty_input",
			credentialId,
			path: "chosen.mp4",
		});
	});
	it("rejects a stale picker selection when the parent has reached sixteen media even with an empty slot", async () => {
		seed([...Array.from({ length: 15 }, (_, n) => media(n)), logo, empty]);
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "Add source" }));
		const full = [...fixture.editor.sources, media(15)];
		const patch = fixture.patchSources;
		if (!patch) throw new Error("Expected real Wizard source patch callback");
		act(() => patch({ inputFiles: full }));
		expect(screen.getByRole("button", { name: "Add source" })).toBeDisabled();
		expect(
			vodInputPreviewSubmissionSchema.safeParse({
				kind: "PROBE",
				sources: [
					...probeSources(),
					{
						key: "seventeenth",
						credentialId,
						bucket: "inputs",
						objectKey: "chosen.mp4",
					},
				],
			}).success,
		).toBe(false);
		choose();
		expect(fixture.editor.sources).toEqual(full);
		expect(probeSources()).toHaveLength(16);
		expect(
			fixture.api.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(false);
	});
});
