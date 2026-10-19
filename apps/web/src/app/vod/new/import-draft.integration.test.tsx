import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { draftKey, writeWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { VodWizard } from "./wizard";

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
const state = {
	...DEFAULT_WIZARD_STATE,
	name: "Imported plan",
	accountId,
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3" as const,
			credentialId,
			bucket: "synthetic",
			path: "input.mp4",
		},
	],
	output: {
		...DEFAULT_WIZARD_STATE.output,
		credentialId,
		bucket: "synthetic",
		basePath: "output",
	},
};
beforeEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
		init?.method === "POST"
			? { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8" }
			: url === "/api/credentials"
				? [{ id: credentialId, label: "Storage", provider: "AWS_S3" }]
				: url === "/api/bitmovin-accounts"
					? [{ id: accountId, name: "Account" }]
					: [],
	);
});
it.each([
	"mapped",
	"raw",
	"mapped-raw-discard",
] as const)("successful imported VOD creation preserves the unrelated draft (%s)", async (mode) => {
	const rawFallback = mode === "raw";
	const key = draftKey(["org", "user"], "vod", "new");
	writeWizardDraft(key, "vod", { ...state, name: "Unrelated saved draft" }, 0);
	const saved = localStorage.getItem(key);
	renderWithQuery(<VodWizard />);
	await screen.findByRole("button", { name: "Restore" });
	const plan = buildPlan(state);
	if (rawFallback) {
		if (!plan.outputs[0]) throw new Error("Expected output");
		plan.outputs[0].key = "custom-origin";
		for (const entry of [...(plan.manifests ?? []), ...plan.muxings]) {
			if (!entry.destination) throw new Error("Expected destination");
			entry.destination.outputKey = "custom-origin";
		}
	}
	fireEvent.click(screen.getByRole("button", { name: /Import plan JSON/ }));
	fireEvent.change(screen.getByRole("textbox", { name: /Import plan JSON/ }), {
		target: { value: JSON.stringify(plan) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Validate.*load/i }));
	expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
	if (mode === "mapped-raw-discard") {
		fireEvent.click(screen.getByRole("button", { name: /Import plan JSON/ }));
		fireEvent.change(
			screen.getByRole("textbox", { name: /Import plan JSON/ }),
			{
				target: {
					value: JSON.stringify({ ...plan, customData: "unsupported" }),
				},
			},
		);
		fireEvent.click(screen.getByRole("button", { name: /Validate.*load/i }));
		fireEvent.click(screen.getByRole("button", { name: "Discard import" }));
		expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
	}
	if (!rawFallback)
		fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
	const start = screen.getByRole("button", {
		name: rawFallback ? "Start encoding (imported plan)" : "Start encoding",
	});
	await waitFor(() => expect(start).toBeEnabled());
	fireEvent.click(start);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(
			"/vod/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8",
		),
	);
	expect(localStorage.getItem(key)).toBe(saved);
});
