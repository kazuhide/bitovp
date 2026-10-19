import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import { LiveWizard } from "@/app/live/new/live-wizard";
import { buildPlan, DEFAULT_WIZARD_STATE } from "@/app/vod/new/build-plan";
import { VodWizard } from "@/app/vod/new/wizard";
import { renderWithQuery } from "@/test/render";
import {
	draftFingerprint,
	draftKey,
	readWizardDraft,
	writeWizardDraft,
} from "./wizard-draft";

const { apiFetch, push, replace } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("./auth/use-session", async (original) => ({
	...(await original<Record<string, unknown>>()),
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
const vod = {
	...DEFAULT_WIZARD_STATE,
	name: "Saved VOD",
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
	sessionStorage.clear();
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/credentials"
			? [{ id: credentialId, label: "Storage", provider: "AWS_S3" }]
			: url === "/api/bitmovin-accounts"
				? [{ id: accountId, name: "Account" }]
				: [],
	);
});
it("VOD restores manually, retains failed submissions, and clears on success before a pending save", async () => {
	const key = draftKey(["org", "user"], "vod", "new");
	writeWizardDraft(key, "vod", vod, 7);
	let succeed!: (job: { id: string }) => void;
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (init?.method === "POST") throw new Error("failed submission");
		return url === "/api/credentials"
			? [{ id: credentialId, label: "Storage", provider: "AWS_S3" }]
			: url === "/api/bitmovin-accounts"
				? [{ id: accountId, name: "Account" }]
				: [];
	});
	renderWithQuery(<VodWizard />);
	expect(screen.getByLabelText(/job name/i)).toHaveValue("");
	fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
	const submit = await screen.findByRole("button", {
		name: /^Start encoding$/i,
	});
	await waitFor(() => expect(submit).toBeEnabled());
	fireEvent.click(submit);
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true),
	);
	expect(readWizardDraft(key, "vod")?.value.name).toBe("Saved VOD");
	const firstPost = apiFetch.mock.calls.find(
		([, init]) => init?.method === "POST",
	);
	const firstRequestKey = new Headers(firstPost?.[1].headers).get(
		"Idempotency-Key",
	);
	expect(firstRequestKey).toMatch(/^[A-Za-z0-9._:-]{1,200}$/);
	await waitFor(() => expect(submit).toBeEnabled());
	apiFetch.mockImplementation((_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? new Promise((resolve) => {
					succeed = resolve;
				})
			: Promise.resolve([]),
	);
	fireEvent.click(submit);
	await waitFor(() => expect(succeed).toBeTypeOf("function"));
	const retriedPost = apiFetch.mock.calls
		.filter(([, init]) => init?.method === "POST")
		.at(-1);
	expect(new Headers(retriedPost?.[1].headers).get("Idempotency-Key")).toBe(
		firstRequestKey,
	);
	await act(async () =>
		succeed({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" }),
	);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(
			"/vod/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
		),
	);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
	expect(localStorage.getItem(key)).toBeNull();
});
it("preserves source hydration and manual edits, and refuses an edit draft from a different CAS version", async () => {
	const id = "55555555-5555-4555-8555-555555555555";
	const plan = buildPlan(vod);
	const oldKey = draftKey(["org", "user"], "vod", `edit:${id}:A`);
	writeWizardDraft(oldKey, "vod", { ...vod, name: "Old A" }, 0);
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/presets/${id}`
			? { name: "Template B", body: plan, updatedAt: "B" }
			: [],
	);
	const view = renderWithQuery(<VodWizard editPresetId={id} />);
	const name = await screen.findByLabelText(/job name/i);
	expect(name).toHaveValue("Saved VOD");
	expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
	fireEvent.change(name, { target: { value: "Edited B" } });
	await act(async () => {
		view.client.setQueryData(["user-preset", id], {
			name: "Refresh",
			body: { ...plan, name: "Refresh" },
			updatedAt: "C",
		});
	});
	expect(name).toHaveValue("Edited B");
	expect(replace).not.toHaveBeenCalled();
	view.unmount();
	const copyKey = draftKey(
		["org", "user"],
		"vod",
		`job:${id}:${draftFingerprint(plan)}`,
	);
	writeWizardDraft(copyKey, "vod", { ...vod, name: "Edited copy" }, 0);
	renderWithQuery(<VodWizard copiedJob={{ id, plan }} />);
	fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
	expect(screen.getByLabelText(/job name/i)).toHaveValue("Edited copy");
});
it("Live restores safe fields and step, requires its secret again, retains failure and clears successful creation", async () => {
	const key = draftKey(["org", "user"], "live", "new");
	writeWizardDraft(
		key,
		"live",
		{
			...DEFAULT_LIVE_WIZARD_STATE,
			name: "Saved live",
			accountId,
			inputKind: "RTMP",
			output: {
				...DEFAULT_LIVE_WIZARD_STATE.output,
				credentialId,
				bucket: "synthetic",
			},
			start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "SECRET" },
		},
		5,
	);
	renderWithQuery(<LiveWizard />);
	expect(screen.getByRole("textbox", { name: /channel name/i })).toHaveValue(
		"",
	);
	await act(async () =>
		fireEvent.click(await screen.findByRole("button", { name: "Restore" })),
	);
	expect(screen.getByLabelText(/^Stream key$/i)).toHaveValue("");
	expect(localStorage.getItem(key)).not.toContain("SECRET");
	fireEvent.change(screen.getByLabelText(/^Stream key$/i), {
		target: { value: "reentered" },
	});
	await act(async () =>
		fireEvent.click(screen.getByRole("button", { name: /^1\. Basics$/i })),
	);
	expect(screen.getByRole("textbox", { name: /channel name/i })).toHaveValue(
		"Saved live",
	);
	await act(async () =>
		fireEvent.click(screen.getByRole("button", { name: /^8\. Review$/i })),
	);
	const submit = screen.getByRole("button", { name: /^Create live channel$/i });
	await waitFor(() => expect(submit).toBeEnabled());
	const readResponse = apiFetch.getMockImplementation();
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "/api/live-channels" && init?.method === "POST")
			throw new Error("failed create");
		return readResponse?.(url, init);
	});
	fireEvent.click(submit);
	await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
	const firstLivePost = apiFetch.mock.calls.find(
		([url, init]) => url === "/api/live-channels" && init?.method === "POST",
	);
	const firstLiveKey = new Headers(firstLivePost?.[1].headers).get(
		"Idempotency-Key",
	);
	expect(firstLiveKey).toMatch(/^[a-f0-9]{64}$/);
	expect(readWizardDraft(key, "live")?.value.name).toBe("Saved live");
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
		url === "/api/live-channels" && init?.method === "POST"
			? { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea" }
			: readResponse?.(url, init),
	);
	fireEvent.click(submit);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(
			"/live/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea",
		),
	);
	const retriedLivePost = apiFetch.mock.calls
		.filter(
			([url, init]) => url === "/api/live-channels" && init?.method === "POST",
		)
		.at(-1);
	expect(new Headers(retriedLivePost?.[1].headers).get("Idempotency-Key")).toBe(
		firstLiveKey,
	);
	expect(retriedLivePost?.[1].body).toBe(firstLivePost?.[1].body);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
	expect(localStorage.getItem(key)).toBeNull();
});
it("keeps a cleared timeout cleared after saving and returning to the same Live copy context", async () => {
	const id = "55555555-5555-4555-8555-555555555555";
	const plan = buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "Copied live",
		accountId,
		inputKind: "RTMP",
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId,
			bucket: "synthetic",
		},
		start: {
			...DEFAULT_LIVE_WIZARD_STATE.start,
			streamKey: "fresh",
			autoShutdown: { streamTimeoutMinutes: 5 },
		},
	});
	apiFetch.mockImplementation(async (url: string) =>
		url === `/api/live-channels/${id}` ? { name: "Copied live", plan } : [],
	);
	const first = renderWithQuery(<LiveWizard duplicateFrom={id} />);
	await screen.findByRole("textbox", { name: /channel name/i });
	await act(async () =>
		fireEvent.click(screen.getByRole("button", { name: /^6\./i })),
	);
	const timeout = screen.getByRole("spinbutton", { name: /^Stream timeout/i });
	expect(timeout).toHaveValue(5);
	fireEvent.change(timeout, { target: { value: "" } });
	await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
	expect(
		localStorage.getItem(
			draftKey(["org", "user"], "live", `from:${id}:${draftFingerprint(plan)}`),
		),
	).not.toBeNull();
	first.unmount();
	renderWithQuery(<LiveWizard duplicateFrom={id} />);
	const restore = await screen.findByRole("button", { name: "Restore" });
	await act(async () => fireEvent.click(restore));
	expect(
		screen.getByRole("spinbutton", { name: /^Stream timeout/i }),
	).toHaveValue(null);
});
