import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/lib/api";
import { messagesFor } from "@/lib/i18n";
import type {
	ResetPostAvailableResponse,
	ResetPreviewResponse,
} from "@/lib/reset-customer-contract";
import {
	DEFAULT_RESET_CATEGORIES,
	RESET_CATEGORIES,
} from "@/lib/reset-selection";
import { renderWithQuery } from "@/test/render";
import { ResetClient } from "./reset-client";

/**
 * review-265 130-B1/130-B2, on the screen.
 *
 * Both findings were about the operator being TOLD: a kept table that loses
 * rows to a foreign key, and a row that still names an encoder this app cannot
 * stop. Neither is a fact the API alone delivers — if the dialog does not
 * render it, the reset is still the silent thing it was.
 */
const preview: ResetPreviewResponse = {
	active: {
		vodJobs: [],
		liveChannels: [],
		pseudoLiveFeeds: [],
		vmafMeasurements: [],
		providerResourcesToCheck: [],
		totals: {
			vodJobs: 0,
			liveChannels: 0,
			pseudoLiveFeeds: 0,
			vmafMeasurements: 0,
			providerResourcesToCheck: 0,
		},
	},
	cleanupUnconfirmed: false,
	blocked: false,
	aisaSnapshotRequiredJobHref: null,
	deleteCounts: [
		{ category: "vodJobs", count: 4 },
		{ category: "liveChannels", count: 2 },
	],
	channelAlertsToDelete: 3,
	watchFoldersToDisable: 2,
	confirmation: "RESET",
} satisfies ResetPreviewResponse;

const postResult: ResetPostAvailableResponse = {
	reportStatus: "available",
	queueCleanupIncomplete: false,
	temporaryStreamKeyCleanupUnconfirmed: false,
	providerResources: {
		pointers: [],
		total: 0,
		truncated: false,
	},
	auditRecorded: true,
	disabledWatchFolders: [],
} satisfies ResetPostAvailableResponse;

let postError: Error | null = null;
let previewResponse: unknown = preview;
let postResponse: unknown = postResult;

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		apiFetch: vi.fn(async (_url: string, init?: { method?: string }) => {
			if (init?.method === "POST" && postError) {
				throw postError;
			}
			return init?.method === "POST" ? postResponse : previewResponse;
		}),
	};
});

const mount = (locale: "en" | "ja" = "en") =>
	renderWithQuery(<ResetClient />, locale);

// review-3: this file mutates a SHARED preview object and had no reset, so
// every test inherited its predecessor's state. The C2 pin passed because an
// earlier test had emptied `vodJobs`/`liveChannels` and set `blocked` —
// run alone it failed, and inserting a test that sets `vodJobs` between
// the two would have left it green while pinning nothing. Its route-side twin
// already deep-resets per test; this file was the one out of step.
beforeEach(() => {
	vi.clearAllMocks();
	delete preview.selectionBlocked;
	delete postResult.deletedCounts;
	delete postResult.requiresSetup;
	preview.blocked = false;
	preview.aisaSnapshotRequiredJobHref = null;
	preview.active.vodJobs = [];
	preview.active.liveChannels = [];
	preview.active.pseudoLiveFeeds = [];
	preview.active.vmafMeasurements = [];
	preview.active.providerResourcesToCheck = [];
	preview.cleanupUnconfirmed = false;
	preview.channelAlertsToDelete = 3;
	preview.watchFoldersToDisable = 2;
	postResult.auditRecorded = true;
	postResult.disabledWatchFolders = [];
	postResult.queueCleanupIncomplete = false;
	postResult.temporaryStreamKeyCleanupUnconfirmed = false;
	postResult.providerResources = {
		pointers: [],
		total: 0,
		truncated: false,
	};
	postError = null;
	previewResponse = preview;
	postResponse = postResult;
});

describe("selected reset categories", () => {
	it.each([
		"en",
		"ja",
	] as const)("explains the new reset receipt only when operation history is selected (%s)", async (locale) => {
		const user = userEvent.setup();
		mount(locale);
		const note =
			locale === "ja"
				? "過去の操作履歴は削除し、今回のリセット記録を新たに残します。"
				: "Existing operation history is deleted; a new record of this reset is kept.";
		expect(await screen.findByText(note)).toBeInTheDocument();
		await user.click(
			screen.getByRole("checkbox", {
				name: locale === "ja" ? "操作履歴" : "Operation history",
			}),
		);
		expect(screen.queryByText(note)).not.toBeInTheDocument();
	});
	it("counts only checked categories and selects all categories on demand", async () => {
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("checkbox", {
				name: "VOD jobs and manifest records",
			}),
		);
		expect(
			await screen.findByText("Selected for deletion: 2 records"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Select all" }));
		for (const checkbox of screen.getAllByRole("checkbox"))
			expect(checkbox).toBeChecked();
		expect(
			screen.queryByText(
				/Configuration is kept|System records required for safe operation are kept/,
			),
		).not.toBeInTheDocument();
	});
	it("refuses execution while a changed selection preview is pending", async () => {
		const { apiFetch } = await import("@/lib/api");
		const user = userEvent.setup();
		mount();
		await screen.findByLabelText(/RESET/);
		vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(() => {}));
		await user.click(screen.getByRole("checkbox", { name: "API tokens" }));
		await user.type(screen.getByLabelText(/RESET/), "RESET");
		expect(screen.getByRole("button", { name: "Reset data" })).toBeDisabled();
	});
	it.each([
		"en",
		"ja",
	] as const)("permits confirmed selected deletion despite every historical blocker (%s)", async (locale) => {
		preview.selectionBlocked = true;
		preview.blocked = true;
		preview.cleanupUnconfirmed = true;
		preview.aisaSnapshotRequiredJobHref = "/vod/jobs/aisa-job";
		preview.active.vodJobs = [
			{ name: "active job", status: "RUNNING", href: "/vod/jobs/job" },
		];
		preview.active.providerResourcesToCheck = [
			{
				resourceType: "vodJob",
				name: "old failed job",
				status: "ERROR",
				bitmovinEncodingId: "enc-abc",
			},
		];
		const user = userEvent.setup();
		mount(locale);
		await user.type(await screen.findByLabelText(/RESET/), "RESET");
		const action = screen.getByRole("button", {
			name: locale === "ja" ? "リセットする" : "Reset data",
		});
		expect(action).toBeEnabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(
			/enc-abc|Check with Bitmovin|使用中|関連する処理を完了/,
		);
		await user.click(action);
		expect(
			await screen.findByText(
				locale === "ja" ? "リセットが完了しました。" : "Reset complete.",
			),
		).toBeInTheDocument();
		const { apiFetch } = await import("@/lib/api");
		expect(
			vi
				.mocked(apiFetch)
				.mock.calls.some(
					([url, init]) =>
						url === "/api/admin/reset" && init?.method === "POST",
				),
		).toBe(true);
	});
	it.each([
		"en",
		"ja",
	] as const)("offers every category including empty ones in %s", async (locale) => {
		mount(locale);
		await screen.findByLabelText(/RESET/);
		expect(screen.getAllByRole("checkbox")).toHaveLength(
			RESET_CATEGORIES.length,
		);
		expect(
			screen
				.getAllByRole("checkbox")
				.filter((checkbox) => (checkbox as HTMLInputElement).checked),
		).toHaveLength(DEFAULT_RESET_CATEGORIES.length);
		expect(
			screen.getByRole("checkbox", {
				name: locale === "ja" ? "コンテンツライブラリ" : "Content library",
			}),
		).toBeChecked();
	});
	it("submits exactly the selected library category and clears confirmation when selection changes", async () => {
		const user = userEvent.setup();
		mount();
		await user.type(await screen.findByLabelText(/RESET/), "RESET");
		await user.click(screen.getByRole("button", { name: "Select none" }));
		expect(await screen.findByLabelText(/RESET/)).toHaveValue("");
		expect(screen.getByRole("button", { name: "Reset data" })).toBeDisabled();
		await user.click(screen.getByRole("checkbox", { name: "Content library" }));
		await user.type(await screen.findByLabelText(/RESET/), "RESET");
		await user.click(screen.getByRole("button", { name: "Reset data" }));
		const { apiFetch } = await import("@/lib/api");
		await waitFor(() =>
			expect(
				vi.mocked(apiFetch).mock.calls.some(
					([url, init]) =>
						url === "/api/admin/reset" &&
						init?.body ===
							JSON.stringify({
								confirm: "RESET",
								categories: ["contentLibrary"],
							}),
				),
			).toBe(true),
		);
	});
	it("shows dependency selection and removes dependent parents when a required category is unchecked", async () => {
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", { name: "Select none" }),
		);
		await user.click(
			screen.getByRole("checkbox", { name: "Application settings" }),
		);
		expect(
			await screen.findByRole("checkbox", { name: "Webhook registrations" }),
		).toBeChecked();
		expect(screen.getByRole("status")).toHaveTextContent(
			/Webhook registrations/,
		);
		await user.click(
			screen.getByRole("checkbox", { name: "Webhook registrations" }),
		);
		expect(
			await screen.findByRole("checkbox", { name: "Application settings" }),
		).not.toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "Webhook registrations" }),
		).not.toBeChecked();
		expect(screen.getByRole("status")).toHaveTextContent(
			/Application settings/,
		);
	});
	it.each([
		"en",
		"ja",
	] as const)("keeps global identities outside organization reset in %s", async (locale) => {
		postResult.requiresSetup = false;
		postResult.deletedCounts = [{ category: "auditHistory", count: 3 }];
		const user = userEvent.setup();
		mount(locale);
		expect(
			await screen.findByText(
				messagesFor(locale).settingsX.resetOrganizationOnly,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", {
				name: locale === "ja" ? "ユーザー" : "Users",
			}),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", {
				name: locale === "ja" ? "セットアップコード" : "Setup codes",
			}),
		).not.toBeInTheDocument();
		await user.type(await screen.findByLabelText(/RESET/), "RESET");
		await user.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "リセットする" : "Reset data",
			}),
		);
		expect(
			await screen.findByText(
				locale === "ja" ? "操作履歴: 3" : "Operation history: 3",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /Open setup|セットアップ/ }),
		).not.toBeInTheDocument();
	});
});

describe("the reset dialog tells the operator what it is about to cost", () => {
	it.each([
		"en",
		"ja",
	] as const)("localizes an AISA conflict after the preview in %s", async (locale) => {
		postError = new ApiError(409, "private raw error", {
			code: "RESET_AISA_SNAPSHOT_REQUIRED",
		});
		const user = userEvent.setup();
		mount(locale);
		await user.type(await screen.findByLabelText(/RESET/), "RESET");
		await user.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "リセットする" : "Reset data",
			}),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/AI Scene Analysis/,
		);
		expect(document.body.textContent).not.toContain("private raw error");
	});
	it("uses natural customer guidance in both locales", () => {
		expect(messagesFor("en").settingsX.resetPreserves).toBe(
			"System records required for safe operation are kept and are not included in the deletion count.",
		);
		expect(messagesFor("ja").settingsX.resetPreserves).toBe(
			"安全な運用に必要なシステム記録は保持され、削除件数には含まれません。",
		);
		expect(messagesFor("en").settingsX.resetBlockedVerification).toBe(
			"Data cannot be reset because cleanup of delivery resources from an earlier operation could not be confirmed. Contact your system administrator or support team.",
		);
		expect(messagesFor("ja").settingsX.resetBlockedVerification).toBe(
			"以前の処理で作成された配信リソースの後処理を確認できないため、データをリセットできません。システム管理者またはサポート窓口にお問い合わせください。",
		);
	});

	it.each([
		[
			"en",
			"A VMAF measurement or pseudo-live feed is still active. Finish or stop it from its page, then try the data reset again.",
		],
		[
			"ja",
			"VMAF 測定または疑似ライブ配信が実行中です。それぞれの画面で完了を待つか停止してから、データのリセットを再実行してください。",
		],
	] as const)("maps a post-preview %s conflict to locale-owned copy", async (locale, expected) => {
		postError = new ApiError(
			409,
			"Work is still running INSIDE this app; a stranded row needs the worker",
			{ code: "RESET_LOCAL_WORK_ACTIVE" },
		);
		const user = userEvent.setup();
		mount(locale);
		await waitFor(() =>
			expect(screen.getByLabelText(/RESET/)).toBeInTheDocument(),
		);
		await user.type(screen.getByLabelText(/RESET/), "RESET");
		await user.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "リセットする" : "Reset data",
			}),
		);
		await screen.findByText(expected);
		expect(document.body.textContent).not.toMatch(
			/INSIDE this app|stranded row|worker/i,
		);
	});

	it("uses localized domain labels for every deletion category and no internal model labels", async () => {
		preview.channelAlertsToDelete = 3;
		preview.active.providerResourcesToCheck = [];
		preview.blocked = false;
		preview.aisaSnapshotRequiredJobHref = null;
		mount();
		await waitFor(() =>
			expect(
				screen.getByText("VOD jobs and manifest records"),
			).toBeInTheDocument(),
		);
		expect(
			screen.getByText("Live channels and run history"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "Channel-specific alert rules" }),
		).toBeChecked();
		expect(document.body.textContent).not.toMatch(
			/encodingJob|liveChannelRun|alertRule|watchRule|verificationResourceIntent|verificationRun/,
		);
	});

	it.each([
		"ja",
		"en",
	] as const)("does not warn about zero-count side effects in %s", async (locale) => {
		preview.watchFoldersToDisable = 0;
		preview.channelAlertsToDelete = 0;
		mount(locale);
		await screen.findByLabelText(/RESET/);
		expect(document.body.textContent).not.toMatch(
			/監視ルール 0|アラートルール 0|0 watch|0 channel-specific alert/i,
		);
	});

	it.each([
		[0, 3],
		[2, 0],
	])("shows only applicable side effects: watch %i, alerts %i", async (watch, alerts) => {
		preview.watchFoldersToDisable = watch;
		preview.channelAlertsToDelete = alerts;
		mount();
		await screen.findByLabelText(/RESET/);
		expect(
			screen.queryByText(/watch rules will be switched off/) !== null,
		).toBe(watch > 0);
		expect(
			screen.queryByText(/channel-specific alert rules will also be deleted/),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/Unchecked categories are kept/),
		).toBeInTheDocument();
	});

	it("fails the preview closed when the API payload violates the shared boundary contract", async () => {
		previewResponse = { ...preview, confirmation: 42 };
		mount();
		await screen.findByText("Could not load what a reset would delete.");
		expect(screen.queryByLabelText(/RESET/)).not.toBeInTheDocument();
	});
});

describe("what the rest of the app sees afterwards (ledger #136)", () => {
	it("invalidates EVERY cached query, not just its own preview", async () => {
		// The owner's report: the database was empty and the dashboard chart
		// still drew the deleted world. The charts hold a 5-minute
		// refetchInterval AND staleTime, and refetchOnWindowFocus is off
		// globally, so nothing pulled them until five minutes had passed —
		// which reads as "the reset did nothing".
		const user = userEvent.setup();
		const { client } = mount();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		await waitFor(() =>
			expect(screen.getByLabelText(/RESET/)).toBeInTheDocument(),
		);
		await user.type(screen.getByLabelText(/RESET/), "RESET");
		await user.click(screen.getByRole("button", { name: /Reset data/ }));
		await screen.findByText(/Reset complete/);
		// No filter: the operation deleted every operational row, so every
		// cached query is stale. A curated key list would drift the moment a
		// screen was added.
		expect(invalidate).toHaveBeenCalled();
		expect(invalidate.mock.calls[0]?.[0]).toBeUndefined();
	});
});

describe("the success panel reports what the server measured (review-2 N1/N4)", () => {
	async function runReset(locale: "en" | "ja" = "en") {
		const user = userEvent.setup();
		mount(locale);
		await waitFor(() =>
			expect(screen.getByLabelText(/RESET/)).toBeInTheDocument(),
		);
		await user.type(screen.getByLabelText(/RESET/), "RESET");
		await user.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "リセットする" : "Reset data",
			}),
		);
		await screen.findByText(
			locale === "ja" ? "リセットが完了しました。" : "Reset complete.",
		);
	}

	it("an UNCONFIRMED audit row says so — truthiness renders nothing for 'unknown'", async () => {
		preview.blocked = false;
		preview.aisaSnapshotRequiredJobHref = null;
		preview.active.providerResourcesToCheck = [];
		postResult.auditRecorded = "unknown";
		postResult.disabledWatchFolders = [];
		await runReset();
		// `!"unknown"` is false, so the two-state version showed an unqualified
		// green "Reset complete." in exactly the case this sentence exists for.
		expect(screen.getByText(/could not be confirmed/)).toBeInTheDocument();
		expect(screen.queryByText(/could not be saved/)).not.toBeInTheDocument();
	});

	it("a FAILED history write gets the other sentence — the two are different facts", async () => {
		postResult.auditRecorded = false;
		postResult.disabledWatchFolders = [];
		await runReset();
		expect(screen.getByText(/could not be saved/)).toBeInTheDocument();
		expect(
			screen.queryByText(/could not be confirmed/),
		).not.toBeInTheDocument();
	});

	it.each([
		false,
		"unknown",
	] as const)("shows every returned provider pointer when the audit result is %s and never calls it recorded", async (auditRecorded) => {
		postResult.auditRecorded = auditRecorded;
		postResult.providerResources = {
			pointers: [
				{
					resourceType: "vodJob",
					name: "Nightly",
					status: "FINISHED",
					bitmovinEncodingId: "enc-save-1",
				},
				{
					resourceType: "liveChannel",
					name: "News",
					status: "STOPPED",
					bitmovinEncodingId: "enc-save-2",
				},
			],
			total: 2,
			truncated: false,
		};

		await runReset();

		expect(
			screen.getByText(
				"Save these Bitmovin encoding IDs before leaving this page:",
			),
		).toBeInTheDocument();
		expect(screen.getByText(/enc-save-1/)).toBeInTheDocument();
		expect(screen.getByText(/enc-save-2/)).toBeInTheDocument();
		expect(screen.queryByText(/were recorded in the audit trail/)).toBeNull();
	});

	it("states localized truncation when an unrecorded provider list is incomplete", async () => {
		postResult.auditRecorded = false;
		postResult.providerResources = {
			pointers: [
				{
					resourceType: "vodJob",
					name: "夜間 VOD",
					status: "FINISHED",
					bitmovinEncodingId: "enc-first",
				},
			],
			total: 54,
			truncated: true,
		};

		await runReset("ja");

		expect(
			screen.getByText(
				"54 件中 1 件のエンコーディング ID を表示しています。残りの ID は監査証跡に保存されていません。システム管理者またはサポート窓口へお問い合わせください。",
			),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("FINISHED");
		expect(document.body.textContent).toContain("完了");
	});

	it("uses recorded copy only when the audit read-back is true", async () => {
		postResult.auditRecorded = true;
		postResult.providerResources = {
			pointers: [
				{
					resourceType: "vodJob",
					name: "Nightly",
					status: "FINISHED",
					bitmovinEncodingId: "enc-recorded",
				},
			],
			total: 1,
			truncated: false,
		};

		await runReset();

		expect(
			screen.getByText(
				/1 Bitmovin encoding ids were recorded in the audit trail/,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/enc-recorded/)).toBeNull();
		expect(screen.queryByText(/Save these Bitmovin/)).toBeNull();
	});

	it.each([
		[
			"en",
			"Recorded 1 of 54 Bitmovin encoding IDs in the audit trail. The remaining 53 IDs were not saved. Contact your system administrator or support team.",
		],
		[
			"ja",
			"Bitmovin のエンコーディング ID 54 件中 1 件を監査証跡に記録しました。残り 53 件は保存されていません。システム管理者またはサポート窓口へお問い合わせください。",
		],
	] as const)("does not claim omitted provider IDs were recorded when the %s audit list was truncated", async (locale, expected) => {
		postResult.auditRecorded = true;
		postResult.providerResources = {
			pointers: [
				{
					resourceType: "vodJob",
					name: "Nightly",
					status: "FINISHED",
					bitmovinEncodingId: "enc-recorded-first",
				},
			],
			total: 54,
			truncated: true,
		};

		await runReset(locale);

		expect(screen.getByText(expected)).toBeInTheDocument();
		expect(
			screen.queryByText(
				/54 Bitmovin encoding ids were recorded in the audit trail/,
			),
		).toBeNull();
	});

	it("names the watch rules it switched off, so re-enabling is actionable", async () => {
		postResult.auditRecorded = true;
		postResult.disabledWatchFolders = [
			{ name: "masters" },
			{ name: "dailies" },
		];
		await runReset();
		// The audit row is the only other copy — and it is the artefact the
		// line above says may be missing.
		expect(screen.getByText(/masters, dailies/)).toBeInTheDocument();
	});

	it.each([
		[
			"en",
			"The data reset completed, but some pending processing could not be cleared. Contact your system administrator or support team before starting new work.",
		],
		[
			"ja",
			"データのリセットは完了しましたが、待機中の処理を一部消去できませんでした。新しい処理を開始する前に、システム管理者またはサポート窓口へお問い合わせください。",
		],
	] as const)("shows natural %s guidance for incomplete queued-work cleanup", async (locale, expected) => {
		postResult.queueCleanupIncomplete = true;
		await runReset(locale);
		expect(screen.getByText(expected)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(
			/orchestrator|vmafRunner|feederManager|storageInspect|notify/i,
		);
	});

	it.each([
		[
			"en",
			"The data reset completed, but cleanup of temporary live stream keys could not be confirmed. Review temporary stream keys in Bitmovin before starting a new live channel.",
		],
		[
			"ja",
			"データのリセットは完了しましたが、一時ライブストリームキーの後処理を確認できませんでした。新しいライブチャンネルを開始する前に、Bitmovin で一時ストリームキーを確認してください。",
		],
	] as const)("shows natural %s guidance when temporary stream-key cleanup is unconfirmed", async (locale, expected) => {
		postResult.temporaryStreamKeyCleanupUnconfirmed = true;
		await runReset(locale);
		expect(screen.getByText(expected)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(
			/released|skippedNoAccount|accountErrors/,
		);
	});

	it.each([
		[
			"en",
			"The reset request may have completed, but its result report could not be confirmed. Check the current data and Bitmovin resources before taking further action. Contact your system administrator or support team before running the reset again.",
		],
		[
			"ja",
			"データのリセットは完了した可能性がありますが、結果レポートを確認できませんでした。次の操作を行う前に、現在のデータと Bitmovin のリソースを確認してください。システム管理者またはサポート窓口へ連絡し、確認が終わるまでリセットを再実行しないでください。",
		],
	] as const)("treats a malformed POST 2xx as an unconfirmed %s result without inviting a blind retry", async (locale, expected) => {
		postResponse = { queueCleanupIncomplete: false };
		const user = userEvent.setup();
		mount(locale);
		await waitFor(() =>
			expect(screen.getByLabelText(/RESET/)).toBeInTheDocument(),
		);
		await user.type(screen.getByLabelText(/RESET/), "RESET");
		await user.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "リセットする" : "Reset data",
			}),
		);
		await screen.findByText(expected);
		expect(document.body.textContent).not.toContain(
			locale === "ja" ? "リセットが完了しました。" : "Reset complete.",
		);
		expect(
			screen.queryByText("Request failed. Try again."),
		).not.toBeInTheDocument();
	});

	it("rejects a provider total that claims omitted pointers without marking truncation", async () => {
		postResponse = {
			...postResult,
			providerResources: { pointers: [], total: 1, truncated: false },
		};
		const user = userEvent.setup();
		mount();
		await waitFor(() =>
			expect(screen.getByLabelText(/RESET/)).toBeInTheDocument(),
		);
		await user.type(screen.getByLabelText(/RESET/), "RESET");
		await user.click(screen.getByRole("button", { name: /Reset data/ }));
		await screen.findByText(
			"The reset request may have completed, but its result report could not be confirmed. Check the current data and Bitmovin resources before taking further action. Contact your system administrator or support team before running the reset again.",
		);
		expect(screen.queryByText("Reset complete.")).not.toBeInTheDocument();
	});

	it("a clean run says none of it", async () => {
		postResult.auditRecorded = true;
		postResult.disabledWatchFolders = [];
		await runReset();
		expect(screen.queryByText(/could not be/)).not.toBeInTheDocument();
		expect(screen.queryByText(/masters/)).not.toBeInTheDocument();
	});
});

it("retries a failed reset preview without submitting a reset", async () => {
	vi.mocked(apiFetch).mockRejectedValueOnce(new Error("offline"));
	mount();
	await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
	await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
	expect(
		vi.mocked(apiFetch).mock.calls.some(([, opts]) => opts?.method === "POST"),
	).toBe(false);
});
