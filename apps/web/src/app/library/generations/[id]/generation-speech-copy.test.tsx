import { screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { GenerationProgress } from "./generation-progress";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: api,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => true,
}));
const id = "44444444-4444-4444-8444-444444444444",
	projectId = "55555555-5555-4555-8555-555555555555";
function task(
	state: string,
	error: string | null = null,
	result: unknown = null,
) {
	return {
		taskId: id,
		kind: "GENERATE",
		state,
		phase:
			state === "RUNNING"
				? "REFINING_SELECTION"
				: state === "SUCCEEDED"
					? "COMPLETE"
					: "FAILED",
		mediaVersionId: "22222222-2222-4222-8222-222222222222",
		analysisRevisionId: "33333333-3333-4333-8333-333333333333",
		parentTaskId: null,
		progress: null,
		result,
		error,
		attempts: 1,
		cached: false,
		createdAt: "2026-11-02T00:00:00.000Z",
		finishedAt: null,
	};
}
beforeEach(() => api.mockReset());
it.each([
	["en", "Checking speech boundaries"],
	["ja", "発話の切れ目を確認しています"],
] as const)("names the measured boundary phase in %s", async (locale, text) => {
	api.mockResolvedValue(task("RUNNING"));
	renderWithQuery(<GenerationProgress id={id} />, locale);
	await screen.findByText(text);
	expect(screen.getByRole("status")).toHaveTextContent(text);
});
it.each([
	["en", "NO_SPEECH_SAFE_WINDOW", /Increase the desired length/],
	["ja", "NO_SPEECH_SAFE_WINDOW", /希望尺を増やすか/],
	[
		"en",
		"NORMALIZATION_EVIDENCE_UNVERIFIED",
		/Prepare a new version from the original/,
	],
	[
		"ja",
		"NORMALIZATION_EVIDENCE_UNVERIFIED",
		/元ファイルから新しい映像版を準備/,
	],
	[
		"en",
		"SPEECH_SELECTION_POLICY_CHANGED",
		/Speech-aware selection was updated/,
	],
	[
		"ja",
		"SPEECH_SELECTION_POLICY_CHANGED",
		/発話を使う選定処理が更新されました/,
	],
] as const)("gives a concrete next action for %s %s", async (locale, code, text) => {
	api.mockResolvedValue(task("ERROR", code));
	renderWithQuery(<GenerationProgress id={id} />, locale);
	expect(await screen.findByText(text)).toBeVisible();
	expect(
		screen.getByRole("button", {
			name:
				locale === "ja" ? "新しいタスクとして再試行" : "Retry as a new task",
		}),
	).toBeEnabled();
	expect(screen.queryByText(code)).not.toBeInTheDocument();
});
it.each([
	"en",
	"ja",
] as const)("explains the observed-range fallback without claiming speech safety in %s", async (locale) => {
	api.mockResolvedValue(
		task("SUCCEEDED", null, {
			projectId,
			projectIds: [projectId],
			requestedFrames: 450,
			actualFrames: 420,
			warnings: ["SPEECH_SELECTION_FALLBACK", "SPEECH_CONTEXT_LIMIT"],
			policyVersion: "aisa-scene-cohesion-v2",
			presetIds: ["portrait-clean"],
			metrics: {},
			cacheable: false,
		}),
	);
	renderWithQuery(<GenerationProgress id={id} />, locale);
	expect(
		await screen.findByText(
			locale === "ja"
				? /発話の切れ目を確認できず、場面情報を使って選びました/
				: /Speech boundaries could not be verified/,
		),
	).toBeVisible();
	expect(
		screen.getByText(
			locale === "ja"
				? /範囲外の発話は判定していません/
				: /Audio beyond that range was not evaluated/,
		),
	).toBeVisible();
});
