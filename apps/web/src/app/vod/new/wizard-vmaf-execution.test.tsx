import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
// Replace only the browser storage offer; restore still goes through the wizard's
// real merge, editing, buildPlan, preview and submit paths.
let initialDraft: unknown;
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
					onRestore({ value: initialDraft, step: 5 });
					setAvailable(false);
				},
				discard: vi.fn(),
				clear: vi.fn(),
			};
		},
	};
});

import {
	buildPlan,
	DEFAULT_WIZARD_QC,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { VodWizard } from "./wizard";

const profile = {
	id: "gcp-test",
	label: "GCP test",
	region: "asia-northeast1",
};
beforeEach(() => {
	vi.clearAllMocks();
	const credentialId = "44444444-4444-4444-8444-444444444444";
	initialDraft = {
		...DEFAULT_WIZARD_STATE,
		name: "cloud-qc",
		accountId: "33333333-3333-4333-8333-333333333333",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId,
				bucket: "source",
				path: "film.mp4",
			},
		],
		output: {
			...DEFAULT_WIZARD_STATE.output,
			kind: "S3",
			credentialId,
			bucket: "output",
			basePath: "cloud-qc",
		},
		qc: {
			...DEFAULT_WIZARD_QC,
			vmaf: true,
			execution: { backend: "CLOUD", profileId: profile.id, budgetUsd: 12 },
		},
	};
	apiFetch.mockImplementation(
		async (url: string, options?: { method?: string }) => {
			if (options?.method === "POST") return { id: "created" };
			if (url === "/api/vmaf-compute-profiles") return { items: [profile] };
			if (url.startsWith("/api/infrastructure/")) return { items: [] };
			if (url === "/api/credentials")
				return [{ id: credentialId, label: "Test S3", provider: "AWS_S3" }];
			return [];
		},
	);
});
async function mount() {
	const result = renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf: true }}>
			<VodWizard />
		</FeatureFlagsProvider>,
	);
	await userEvent.click(screen.getByRole("button", { name: "Restore" }));
	return result;
}
async function review() {
	await userEvent.click(
		within(screen.getByRole("navigation", { name: /wizard steps/i })).getByRole(
			"button",
			{ name: /review/i },
		),
	);
	return screen.getByRole("button", { name: "Start encoding" });
}
it("blocks the restored CLOUD selection after its profile disappears", async () => {
	const { client } = await mount();
	await screen.findByRole("option", { name: "GCP test · asia-northeast1" });
	const submit = await review();
	await waitFor(() => expect(submit).toBeEnabled());
	act(() => client.setQueryData(["vmaf-compute-profiles"], { items: [] }));
	await waitFor(() => expect(submit).toBeDisabled());
	expect(
		await screen.findByText(
			"The selected cloud profile is no longer available. Choose another execution target.",
		),
	).toBeInTheDocument();
	await userEvent.click(submit);
	expect(
		apiFetch.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
});
it("blocks a cleared budget before encoding and submits the repaired cloud selection", async () => {
	await mount();
	await screen.findByRole("option", { name: "GCP test · asia-northeast1" });
	fireEvent.change(screen.getByLabelText("Budget (USD)"), {
		target: { value: "" },
	});
	const submit = await review();
	expect(submit).toBeDisabled();
	expect(
		apiFetch.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
	await userEvent.click(
		within(screen.getByRole("navigation", { name: /wizard steps/i })).getByRole(
			"button",
			{ name: /^6\. Encoding/ },
		),
	);
	fireEvent.change(screen.getByLabelText("Budget (USD)"), {
		target: { value: "5.25" },
	});
	await review();
	await userEvent.click(screen.getByRole("button", { name: "Start encoding" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/encoding-jobs",
			expect.objectContaining({ method: "POST" }),
		),
	);
	const call = apiFetch.mock.calls.find(
		([url, options]) =>
			url === "/api/encoding-jobs" && options?.method === "POST",
	);
	expect(JSON.parse(call?.[1].body).plan.qc.execution).toEqual({
		backend: "CLOUD",
		profileId: "gcp-test",
		budgetUsd: 5.25,
	});
});

it("blocks a CLOUD plan loaded into the wizard when its profile becomes unavailable", async () => {
	const { client } = await mount();
	await screen.findByRole("option", { name: "GCP test · asia-northeast1" });
	await userEvent.click(
		screen.getByRole("button", { name: /Import plan JSON/ }),
	);
	fireEvent.change(screen.getByRole("textbox", { name: /Import plan JSON/ }), {
		target: { value: JSON.stringify(buildPlan(initialDraft as WizardState)) },
	});
	await userEvent.click(
		screen.getByRole("button", { name: /Validate.*load/i }),
	);
	await userEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	const submit = screen.getByRole("button", { name: "Start encoding" });
	await waitFor(() => expect(submit).toBeEnabled());
	act(() => client.setQueryData(["vmaf-compute-profiles"], { items: [] }));
	await waitFor(() => expect(submit).toBeDisabled());
	await userEvent.click(submit);
	expect(
		apiFetch.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
});
