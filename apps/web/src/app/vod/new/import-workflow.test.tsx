import { encodingPlanSchema } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { VodWizard } from "./wizard";

const draftContexts = vi.hoisted(() => [] as (string | null)[]);
vi.mock("@/lib/wizard-draft-hook", async (original) => {
	const actual = await original<typeof import("@/lib/wizard-draft-hook")>();
	return {
		...actual,
		useWizardDraft: (options: Parameters<typeof actual.useWizardDraft>[0]) => {
			draftContexts.push(options.context);
			return actual.useWizardDraft(options);
		},
	};
});
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const plan = buildPlan({
	...DEFAULT_WIZARD_STATE,
	name: "imported-job",
	accountId: "33333333-3333-4333-8333-333333333333",
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "44444444-4444-4444-8444-444444444444",
			bucket: "synthetic",
			path: "input.mp4",
		},
	],
	output: {
		...DEFAULT_WIZARD_STATE.output,
		credentialId: "44444444-4444-4444-8444-444444444444",
		bucket: "synthetic",
		basePath: "encoded/imported-job",
	},
});
beforeEach(() => {
	vi.clearAllMocks();
	draftContexts.length = 0;
	apiFetch.mockResolvedValue([]);
});
function importJson(raw: unknown) {
	fireEvent.click(screen.getByRole("button", { name: /Import plan JSON/ }));
	fireEvent.change(screen.getByRole("textbox", { name: /Import plan JSON/ }), {
		target: { value: JSON.stringify(raw) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Validate.*load/i }));
}
it("opens imported JSON in the editable wizard and saves the reviewed plan as a template without starting encoding", async () => {
	renderWithQuery(<VodWizard />);
	importJson(plan);
	const name = screen.getByRole("textbox", { name: /job name/i });
	expect(name).toHaveValue("imported-job");
	expect(draftContexts.at(-1)).toBeNull();
	expect(
		screen.queryByRole("button", { name: /Start encoding \(imported plan\)/ }),
	).toBeNull();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
	fireEvent.change(name, { target: { value: "edited-job" } });
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	fireEvent.change(screen.getByRole("textbox", { name: /Preset name/i }), {
		target: { value: "Reusable template" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save as preset" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/presets",
			expect.objectContaining({ method: "POST" }),
		),
	);
	const call = apiFetch.mock.calls.find(
		([url, init]) => url === "/api/presets" && init?.method === "POST",
	);
	const saved = encodingPlanSchema.parse(JSON.parse(call?.[1].body).plan);
	const expected = structuredClone(encodingPlanSchema.parse(plan));
	expected.name = "edited-job";
	for (const manifest of expected.manifests ?? [])
		manifest.destination.path = manifest.destination.path.replace(
			"imported-job",
			"edited-job",
		);
	for (const muxing of expected.muxings) {
		if (!muxing.destination) throw new Error("Expected a muxing destination");
		muxing.destination.path = muxing.destination.path.replace(
			"imported-job",
			"edited-job",
		);
	}
	expect(saved).toEqual(expected);
	expect(
		apiFetch.mock.calls.some(
			([url, init]) => url === "/api/encoding-jobs" && init?.method === "POST",
		),
	).toBe(false);
});
it("keeps unsupported wizard settings verbatim, explains the limitation and allows JSON editing and template saving", async () => {
	renderWithQuery(<VodWizard />);
	const raw = structuredClone(plan);
	if (!raw.outputs[0]) throw new Error("Expected the origin output");
	raw.outputs[0].key = "custom-origin";
	for (const entry of [...(raw.manifests ?? []), ...raw.muxings]) {
		if (!entry.destination) throw new Error("Expected a destination");
		entry.destination.outputKey = "custom-origin";
	}
	importJson(raw);
	expect(
		screen.getByRole("textbox", { name: /job name/i }).closest("div.mt-6"),
	).toHaveClass("hidden");
	expect(
		screen.getByText(/wizard cannot preserve every setting/i),
	).toBeInTheDocument();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
	fireEvent.change(screen.getByRole("textbox", { name: /Preset name/i }), {
		target: { value: "Advanced template" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save as preset" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/presets",
			expect.objectContaining({ method: "POST" }),
		),
	);
	const call = apiFetch.mock.calls.find(
		([url, init]) => url === "/api/presets" && init?.method === "POST",
	);
	expect(encodingPlanSchema.parse(JSON.parse(call?.[1].body).plan)).toEqual(
		encodingPlanSchema.parse(raw),
	);
	fireEvent.click(screen.getByRole("button", { name: "Edit JSON" }));
	expect(
		(
			screen.getByRole("textbox", {
				name: /Import plan JSON/,
			}) as HTMLTextAreaElement
		).value,
	).toContain("custom-origin");
	expect(
		apiFetch.mock.calls.some(
			([url, init]) => url === "/api/encoding-jobs" && init?.method === "POST",
		),
	).toBe(false);
});

it("opens an uploaded plan in the same wizard without submitting it", async () => {
	renderWithQuery(<VodWizard />);
	fireEvent.click(screen.getByRole("button", { name: /Import plan JSON/ }));
	const file = new File([JSON.stringify(plan)], "plan.json", {
		type: "application/json",
	});
	Object.defineProperty(file, "text", {
		value: async () => JSON.stringify(plan),
	});
	fireEvent.change(screen.getByLabelText("Load file…"), {
		target: { files: [file] },
	});
	await waitFor(() =>
		expect(screen.getByRole("textbox", { name: /job name/i })).toHaveValue(
			"imported-job",
		),
	);
	expect(screen.getByText(/Plan loaded into the wizard/)).toBeInTheDocument();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});
