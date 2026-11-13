import type {
	VodInputFavoriteWire,
	VodInputPreviewSubmission,
} from "@bitovp/core/vod-input-timeline";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { projectWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { FILE_OUTPUT_DEFAULT_STATE } from "./file-output";
import {
	clipA,
	credentialId,
	facts,
	organizationId,
	previewTask,
	sequenceId,
} from "./input-timeline/test-fixtures";
import { VodWizard } from "./wizard";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
// Only the browser's draft offer is replaced. Wizard, Editor, task validation,
// readiness callback, buildPlan and the Start/Update template gates remain real.
let seed: WizardState;
vi.mock("@/lib/wizard-draft-hook", async () => {
	const { useState } = await import("react");
	return {
		useWizardDraft: ({
			onRestore,
		}: {
			onRestore: (draft: unknown) => void;
		}) => {
			const [available, setAvailable] = useState(true);
			return {
				available,
				restore: () => {
					onRestore({ value: projectWizardDraft("vod", seed), step: 1 });
					setAvailable(false);
				},
				discard: vi.fn(),
				clear: vi.fn(),
			};
		},
	};
});

const accountId = "30000000-0000-4000-8000-000000000001";
const templateId = "30000000-0000-4000-8000-000000000004";
const favorite = (kind: "IMAGE" | "AUDIO"): VodInputFavoriteWire => ({
	id:
		kind === "IMAGE"
			? "30000000-0000-4000-8000-000000000002"
			: "30000000-0000-4000-8000-000000000003",
	credentialId,
	bucket: "sources",
	objectKey: kind === "IMAGE" ? "logo.png" : "voice.wav",
	label: kind === "IMAGE" ? "Test logo" : "Test audio",
	kind,
	availability: "AVAILABLE",
	inputKind: "S3",
});
let holdProbes = false;
let heldProbes: Array<() => void> = [];
const submissions = () =>
	apiFetch.mock.calls
		.filter(
			([url, init]) =>
				url === "/api/vod/input-previews" && init?.method === "POST",
		)
		.map(([, init]) => JSON.parse(init.body) as VodInputPreviewSubmission);
const probes = () =>
	submissions().filter((request) => request.kind === "PROBE");

beforeEach(() => {
	vi.clearAllMocks();
	holdProbes = false;
	heldProbes = [];
	seed = {
		...DEFAULT_WIZARD_STATE,
		name: "Timeline logo readiness",
		accountId,
		inputFiles: [
			{
				key: "a",
				inputKey: "a",
				kind: "S3",
				credentialId,
				bucket: "sources",
				path: "a.mp4",
			},
		],
		inputTimeline: {
			schemaVersion: 1,
			id: sequenceId,
			audioEnabled: true,
			clips: [{ id: clipA, sourceKey: "a", inMs: 0, outMs: 8_000 }],
		},
		output: {
			...DEFAULT_WIZARD_STATE.output,
			credentialId,
			bucket: "output",
			basePath: "test-only",
		},
	};
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "/api/auth/session")
			return {
				configured: false,
				authenticated: true,
				mode: "none",
				organizationId,
			};
		if (url === "/api/credentials")
			return [{ id: credentialId, label: "Synthetic S3", provider: "AWS_S3" }];
		if (url === "/api/bitmovin-accounts")
			return [
				{ id: accountId, label: "Synthetic account", internalHevcV2: false },
			];
		if (url === `/api/presets/${templateId}`)
			return {
				name: "Synthetic timeline template",
				body: buildPlan(seed),
				updatedAt: "2026-11-13T00:00:00.000Z",
			};
		if (url === "/api/vod/input-favorites")
			return { favorites: [favorite("IMAGE"), favorite("AUDIO")] };
		if (url === "/api/vod/input-previews" && init?.method === "POST") {
			const request = JSON.parse(
				String(init.body),
			) as VodInputPreviewSubmission;
			if (request.kind === "PROBE") {
				const response = {
					task: previewTask({
						kind: "PROBE",
						result: {
							sources: request.sources.map((source) => ({
								...facts[0],
								key: source.key,
							})),
						},
					}),
				};
				if (holdProbes)
					return new Promise((resolve) =>
						heldProbes.push(() => resolve(response)),
					);
				return response;
			}
			if (request.kind === "PREVIEW")
				return {
					task: previewTask({
						result: {
							preview: { ...request.range, size: 1024, sha256: "b".repeat(64) },
						},
					}),
				};
		}
		if (init?.method && init.method !== "GET" && init.method !== "DELETE")
			throw new Error(`Unexpected write: ${url}`);
		return [];
	});
});
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

async function step(name: RegExp) {
	await userEvent.click(
		within(screen.getByRole("navigation", { name: "Wizard steps" })).getByRole(
			"button",
			{ name },
		),
	);
}
type Action = "Start encoding" | "Update template";
async function review(action: Action = "Start encoding") {
	await step(/^8\. Review$/);
	return screen.getByRole("button", { name: action });
}
async function mountReady(action: Action = "Start encoding") {
	renderWithQuery(
		<DocumentOrganizationContext.Provider value={organizationId}>
			<VodWizard
				editPresetId={action === "Update template" ? templateId : undefined}
			/>
		</DocumentOrganizationContext.Provider>,
	);
	await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
	await screen.findByText("Preview ready");
	expect(await review(action)).toBeEnabled();
	await step(/^2\./);
	await screen.findByText("Preview ready");
}

it.each<Action>([
	"Start encoding",
	"Update template",
])("keeps %s eligible after applying an output logo without remounting or probing AV again", async (action) => {
	await mountReady(action);
	const editor = screen.getByRole("region", {
		name: "Input timeline",
	});
	const preview = screen.getByLabelText("Input timeline preview", {
		exact: true,
	});
	const probeCount = probes().length;
	await userEvent.click(
		screen.getByRole("button", { name: "Use Test logo as an output logo" }),
	);
	await screen.findByText(/Input previews do not display them/);
	expect(screen.getByRole("region", { name: "Input timeline" })).toBe(editor);
	expect(screen.getByLabelText("Input timeline preview", { exact: true })).toBe(
		preview,
	);
	expect(probes()).toHaveLength(probeCount);
	expect(
		probes().every((request) =>
			request.sources.every((source) => source.objectKey !== "logo.png"),
		),
	).toBe(true);
	// Go directly to Review once. Returning to the editor first would re-PROBE
	// and hide a stale readiness signature held by the parent wizard.
	expect(await review(action)).toBeEnabled();
	expect(probes()).toHaveLength(probeCount);
});

it("opens all settings when an output logo is applied in the simple view of the file flow, where the Ladder step shows it", async () => {
	seed = {
		...FILE_OUTPUT_DEFAULT_STATE,
		name: seed.name,
		accountId,
		inputFiles: seed.inputFiles,
		inputTimeline: seed.inputTimeline,
		output: {
			...FILE_OUTPUT_DEFAULT_STATE.output,
			credentialId,
			bucket: "output",
			basePath: "test-only",
		},
	};
	renderWithQuery(
		<DocumentOrganizationContext.Provider value={organizationId}>
			<VodWizard flow="file" />
		</DocumentOrganizationContext.Provider>,
	);
	await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
	await screen.findByText("Preview ready");
	const steps = () =>
		within(
			screen.getByRole("navigation", { name: "Wizard steps" }),
		).getAllByRole("button");
	expect(steps()).toHaveLength(6);
	// A source is no setting of a step this view leaves out, and keeps it.
	await userEvent.click(
		screen.getByRole("button", { name: "Add Test audio to sources" }),
	);
	expect(steps()).toHaveLength(6);
	await userEvent.click(
		screen.getByRole("button", { name: "Use Test logo as an output logo" }),
	);
	await screen.findByText(/Input previews do not display them/);
	expect(steps()).toHaveLength(8);
	const back = screen.getByRole("button", { name: "Back to simple view" });
	expect(back).toBeDisabled();
	expect(back).toHaveAccessibleDescription(
		"Settings the simple view does not show are in use in: Ladder.",
	);
});

it("invalidates actual AV source changes until the real editor completes a fresh probe", async () => {
	await mountReady();
	holdProbes = true;
	const probeCount = probes().length;
	await userEvent.click(
		screen.getByRole("button", { name: "Add Test audio to sources" }),
	);
	await waitFor(() => expect(heldProbes).toHaveLength(1));
	expect(probes()).toHaveLength(probeCount + 1);
	expect(await review()).toBeDisabled();
	await step(/^2\./);
	await waitFor(() => expect(heldProbes).toHaveLength(2));
	await act(async () => {
		for (const resolve of heldProbes) resolve();
	});
	await screen.findByText("Preview ready");
	expect(
		probes()
			.at(-1)
			?.sources.some((source) => source.objectKey === "voice.wav"),
	).toBe(true);
	expect(await review()).toBeEnabled();
});
