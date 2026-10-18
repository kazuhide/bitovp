import { describe, expect, it } from "vitest";
import {
	canaryCompletionError,
	createPostCreateResponseLossCanary,
	noteCanaryAdoption,
	noteCanaryCreatePost,
	postCreateResponseLossEvidence,
	shouldInjectPostCreateResponseLoss,
	validatePostCreateResponseLossCanary,
} from "./response-loss-canary";

describe("post-CREATE response-loss canary rails", () => {
	it("is inert unless explicitly enabled", () => {
		expect(() =>
			validatePostCreateResponseLossCanary({ enabled: false }),
		).not.toThrow();
	});

	it.each([
		[
			"exactly one --only scenario",
			{ enabled: true, only: ["vod-a", "vod-b"], maxSubmits: 1 },
		],
		["exactly one --only scenario", { enabled: true, only: [], maxSubmits: 1 }],
		["--max-submits 1", { enabled: true, only: ["vod-a"], maxSubmits: 2 }],
		[
			"without --dry-run",
			{ enabled: true, only: ["vod-a"], maxSubmits: 1, dryRun: true },
		],
		[
			"without --resume-from",
			{
				enabled: true,
				only: ["vod-a"],
				maxSubmits: 1,
				resumeFrom: "old/report.json",
			},
		],
	] as const)("refuses an unsafe invocation: %s", (message, input) => {
		expect(() => validatePostCreateResponseLossCanary(input)).toThrow(message);
	});

	it("cannot inject before an actual fresh CREATE success, injects once, and requires exact adoption", () => {
		const state = createPostCreateResponseLossCanary("vod-a");
		noteCanaryCreatePost(state, "VOD_JOB", "vod-a");

		expect(
			shouldInjectPostCreateResponseLoss(state, {
				resourceKind: "VOD_JOB",
				scenario: "vod-a",
				localId: "job-existing",
				replayed: true,
			}),
		).toBe(false);
		expect(state.injected).toBe(false);
		expect(canaryCompletionError(state)).toMatch(
			/fresh successful product HTTP CREATE/,
		);

		expect(
			shouldInjectPostCreateResponseLoss(state, {
				resourceKind: "VOD_JOB",
				scenario: "vod-a",
				localId: "job-new",
				replayed: false,
			}),
		).toBe(true);
		expect(
			shouldInjectPostCreateResponseLoss(state, {
				resourceKind: "VOD_JOB",
				scenario: "vod-a",
				localId: "job-other",
				replayed: false,
			}),
		).toBe(false);

		noteCanaryAdoption(state, "job-new");
		expect(canaryCompletionError(state)).toBeUndefined();
		expect(postCreateResponseLossEvidence(state)).toMatchObject({
			type: "PRODUCT_HTTP_CREATE_RESPONSE_LOSS",
			boundary: "VERIFICATION_CLIENT_TO_PRODUCT_API",
			trigger: "AFTER_SUCCESSFUL_FRESH_PRODUCT_HTTP_CREATE",
			providerSdkResponseLossProven: false,
			scenario: "vod-a",
			resourceKind: "VOD_JOB",
			createPosts: 1,
			successfulCreates: 1,
			injected: true,
			createdLocalId: "job-new",
			adoptedLocalId: "job-new",
		});
	});

	it("refuses a second CREATE before it can be posted", () => {
		const state = createPostCreateResponseLossCanary("live-a");
		noteCanaryCreatePost(state, "LIVE_CHANNEL", "live-a");
		expect(() => noteCanaryCreatePost(state, "LIVE_CHANNEL", "live-a")).toThrow(
			/second CREATE POST/,
		);
		expect(state.createPosts).toBe(1);
	});
});
