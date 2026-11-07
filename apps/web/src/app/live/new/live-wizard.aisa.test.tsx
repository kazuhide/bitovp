import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
const push = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";
import { LiveWizard } from "./live-wizard";

beforeEach(() => {
	apiFetch.mockReset();
	push.mockReset();
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/auth/session"
			? {
					mode: "users",
					configured: true,
					authenticated: true,
					role: "OPERATOR",
					effectiveUserId: "user",
					organizationId: "org",
					isImpersonating: false,
				}
			: url === "/api/bitmovin-accounts"
				? [
						{
							id: "00000000-0000-4000-8000-000000000011",
							label: "Sports account",
						},
					]
				: url === "/api/live-channels"
					? { id: "00000000-0000-4000-8000-000000000015" }
					: [],
	);
	localStorage.clear();
	sessionStorage.clear();
});

function steps() {
	return within(
		screen.getByRole("navigation", { name: "Wizard steps" }),
	).getAllByRole("button");
}
async function showStep(index: number) {
	const button = steps()[index];
	if (!button) throw new Error(`Missing step ${index}`);
	await userEvent.click(button);
}
function input(id: string) {
	const node = document.getElementById(id);
	if (!(node instanceof HTMLInputElement)) throw new Error(`Missing ${id}`);
	return node;
}

it("keeps the standard wizard when Preview is disabled", () => {
	renderWithQuery(<LiveWizard />);
	expect(
		screen.queryByLabelText("Detect key moments automatically"),
	).toBeNull();
	expect(steps()).toHaveLength(9);
});

it("uses the same nine steps and preserves the custom normal graph across Preview toggles", async () => {
	renderWithQuery(<LiveWizard aisaPreviewEnabled />);
	await showStep(2);
	fireEvent.change(input("lw-v-0-height"), { target: { value: "1080" } });
	await showStep(0);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	expect(
		screen.getByText(/soccer \(football\), tennis, and American football/),
	).toBeVisible();
	expect(
		screen.getByText(/Select the Preview delivery configuration/),
	).toBeVisible();
	await userEvent.click(
		screen.getByLabelText("Use this Preview delivery configuration"),
	);
	await showStep(2);
	expect(
		screen.getByRole("heading", { name: "Preview delivery configuration" }),
	).toBeVisible();
	expect(document.getElementById("lw-v-0-height")).toBeNull();
	await showStep(0);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await showStep(2);
	expect(input("lw-v-0-height")).toHaveValue(1080);
	expect(steps()).toHaveLength(9);
});

it("places Preview output and start settings in the existing Output and Encoding steps", async () => {
	renderWithQuery(<LiveWizard aisaPreviewEnabled initialAisaEnabled />);
	await showStep(1);
	const select = screen.getByLabelText("Input kind");
	await userEvent.selectOptions(select, "RTMP");
	expect(within(select).getByRole("option", { name: "SRT" })).toBeDisabled();
	await showStep(3);
	expect(screen.getByLabelText("Encoding Output ID")).toBeVisible();
	expect(screen.getByLabelText("Recording path")).toBeVisible();
	expect(screen.getByLabelText("Analysis results path")).toBeVisible();
	expect(document.getElementById("lw-out-cred")).toBeNull();
	await showStep(5);
	expect(screen.getByLabelText("Stream key")).toBeVisible();
	expect(
		screen.getByLabelText("Encoding Resource Service version"),
	).toBeVisible();
	expect(document.getElementById("lw-ar-segmentsWrittenTimeout")).toBeNull();
});

it("retains configured safety settings until the explicit clear action", async () => {
	renderWithQuery(<LiveWizard aisaPreviewEnabled />);
	await showStep(5);
	fireEvent.change(input("lw-ar-segmentsWrittenTimeout"), {
		target: { value: "60" },
	});
	await showStep(0);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	expect(
		screen.getByText(/Preview does not support custom ladders/),
	).toBeVisible();
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await showStep(5);
	expect(input("lw-ar-segmentsWrittenTimeout")).toHaveValue(60);
	await showStep(0);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Clear unsupported Preview settings" }),
	);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await showStep(5);
	expect(input("lw-ar-segmentsWrittenTimeout")).toHaveValue(null);
});

it("creates through the normal Live endpoint with only the accepted managed plan", async () => {
	renderWithQuery(<LiveWizard aisaPreviewEnabled />);
	fireEvent.change(input("lw-name"), { target: { value: "Tennis match" } });
	await screen.findByRole("option", { name: "Sports account" });
	await userEvent.selectOptions(
		await screen.findByLabelText("Bitmovin account"),
		"00000000-0000-4000-8000-000000000011",
	);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await userEvent.click(
		screen.getByLabelText("Use this Preview delivery configuration"),
	);
	await showStep(1);
	await userEvent.selectOptions(screen.getByLabelText("Input kind"), "RTMP");
	await showStep(3);
	for (const [key, value] of [
		["outputId", "00000000-0000-4000-8000-000000000012"],
		["recordingPath", "match/recording"],
		["analysisPath", "match/analysis"],
	]) {
		fireEvent.change(input(`lw-aisa-${key}`), { target: { value } });
	}
	await showStep(5);
	fireEvent.change(input("lw-streamkey"), { target: { value: "TennisMatch" } });
	await showStep(8);
	const create = screen.getByRole("button", { name: "Create live channel" });
	await waitFor(() => expect(create).toBeEnabled());
	await userEvent.click(create);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(
			"/live/00000000-0000-4000-8000-000000000015",
		),
	);
	const posts = apiFetch.mock.calls.filter(
		([, init]) => init?.method === "POST",
	);
	expect(posts).toHaveLength(1);
	expect(posts[0]?.[0]).toBe("/api/live-channels");
	const body = JSON.parse(posts[0]?.[1].body);
	expect(body.plan.start.aiSceneAnalysisLive).toMatchObject({
		preset: "AISA_PREVIEW_MANAGED",
		outputId: "00000000-0000-4000-8000-000000000012",
	});
	expect(body.plan.outputs).toEqual([]);
	expect(body.plan.renditions).toEqual([]);
	expect(body.schedule).toBeUndefined();
});

it("keeps an imported Preview plan explicit and blocked when the server flag is off", async () => {
	const source = {
		...structuredClone(DEFAULT_LIVE_WIZARD_STATE),
		name: "Imported AISA",
		accountId: "00000000-0000-4000-8000-000000000011",
		inputKind: "RTMP" as const,
		start: {
			...structuredClone(DEFAULT_LIVE_WIZARD_STATE.start),
			streamKey: "TennisMatch",
		},
		aisaLive: {
			enabled: true,
			useManagedGraph: true,
			outputId: "00000000-0000-4000-8000-000000000012",
			recordingPath: "r",
			analysisPath: "a",
			esVersion: "",
			aicaVersion: "",
		},
	};
	renderWithQuery(<LiveWizard />);
	await userEvent.click(
		screen.getByRole("button", { name: /Import plan JSON/ }),
	);
	fireEvent.change(screen.getByLabelText("Live channel plan JSON"), {
		target: { value: JSON.stringify(buildLiveChannelPlan(source)) },
	});
	await userEvent.click(screen.getByRole("button", { name: "Load plan" }));
	expect(
		screen.getByLabelText("Detect key moments automatically"),
	).toBeChecked();
	expect(
		screen.getAllByText(
			/Key moment detection Preview is disabled on this server/,
		)[0],
	).toBeVisible();
	await showStep(8);
	expect(
		screen.getByRole("button", { name: "Create live channel" }),
	).toBeDisabled();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

it("requires explicitly disabling an existing schedule for Preview", async () => {
	renderWithQuery(<LiveWizard aisaPreviewEnabled />);
	await showStep(7);
	await userEvent.click(
		screen.getByLabelText("Set the planned input feed, program and stop times"),
	);
	await showStep(0);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await showStep(7);
	await userEvent.click(
		screen.getByRole("button", { name: "Disable schedule" }),
	);
	expect(screen.queryByRole("button", { name: "Disable schedule" })).toBeNull();
	await showStep(0);
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await showStep(7);
	expect(
		screen.getByLabelText("Set the planned input feed, program and stop times"),
	).not.toBeChecked();
});

it("places key moments after normal basics and requests configuration consent only once", async () => {
	renderWithQuery(<LiveWizard aisaPreviewEnabled />);
	const group = screen.getByRole("heading", { name: "Additional features" });
	expect(
		input("lw-name").compareDocumentPosition(group) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	await userEvent.click(
		screen.getByLabelText("Detect key moments automatically"),
	);
	await userEvent.click(
		screen.getByLabelText("Use this Preview delivery configuration"),
	);
	for (const step of [2, 4, 6]) {
		await showStep(step);
		expect(
			screen.getByRole("heading", { name: "Preview delivery configuration" }),
		).toBeVisible();
		expect(
			screen.queryByLabelText("Use this Preview delivery configuration"),
		).toBeNull();
	}
});
