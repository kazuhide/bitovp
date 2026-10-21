import { DELIVERY_SPECS, type UsageSeries } from "@bitovp/core";
import { SAMPLE_PRESET_FAMILIES, SAMPLE_PRESETS } from "@bitovp/core/presets";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { LOCALES, type Locale, messagesFor } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";
import {
	CATALOGUE_ALLOWLIST,
	catalogueLeaves,
	FORBIDDEN_CUSTOMER_TERMS,
	findForbiddenTerms,
	scanCatalogue,
	scanDom,
} from "./customer-copy-registry";

/* Scan mounted operator-facing surfaces for internal evidence language. Test both successful and unavailable states, with a narrow allowlist for legitimate technical names. */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
	useSearchParams: () => searchParams,
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/",
}));

// Fixed-size ResponsiveContainer so chart-bearing screens mount under jsdom
// (jsdom reports 0×0) — the same workaround the qc chart tests use.
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: ReactNode }) =>
			isValidElement(children)
				? cloneElement(
						children as ReactElement<{ width?: number; height?: number }>,
						{ width: 800, height: 320 },
					)
				: children,
	};
});

import { DashboardHome } from "@/app/dashboard-home";
import { DashboardUsage } from "@/app/dashboard-usage";
import { ChannelLifecycleActions } from "@/app/live/[id]/channel-actions";
import { ContentInsertionPanel } from "@/app/live/[id]/content-insertion-panel";
import { EsamPanel } from "@/app/live/[id]/esam-panel";
import { ChannelsClient } from "@/app/live/channels-client";
import { FeedersClient } from "@/app/live/feeders/feeders-client";
import type {
	LiveChannelHealthDigest,
	LiveChannelListItem,
} from "@/app/live/live-shared";
import { DeliveryGallery } from "@/app/presets/delivery-gallery";
import { MyPresets } from "@/app/presets/my-presets";
import { PresetGallery } from "@/app/presets/preset-gallery";
import { CompareClient } from "@/app/qc/compare/compare-client";
import { VmafLabClient } from "@/app/qc/vmaf-lab-client";
import type { VmafJobListItem } from "@/app/qc/vmaf-shared";
import { SettingsAreas } from "@/app/settings/settings-areas";
import { StorageClient } from "@/app/storage/storage-client";
import { type JobListItem, JobsClient } from "@/app/vod/jobs/jobs-client";
import { ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// (a) the catalogue arm
// ---------------------------------------------------------------------------

describe("customer copy gate — catalogue arm", () => {
	it("uses the agreed Japanese audio and encoder spelling throughout the catalogue", () => {
		const mixedTerms = [...catalogueLeaves(messagesFor("ja"))]
			.filter(([, value]) => /エンコーダー|オーディオ/.test(value))
			.map(([key]) => key);
		expect(mixedTerms).toEqual([]);
	});

	it("preserves Live output-group labels and action-oriented English buttons", () => {
		const ja = messagesFor("ja");
		const en = messagesFor("en");
		expect(ja.liveArchive.audio).toBe("AAC 音声");
		expect(ja.ingest.encoderIp).toBe("エンコーダ IP");
		expect(ja.liveWizard.stepOutputGroups).toBe("出力グループ・マニフェスト");
		expect(en.liveWizard.stepOutputGroups).toBe("Output groups and manifests");
		expect(en.common.save).toBe("Save");
		expect(en.common.cancel).toBe("Cancel");
		expect(en.common.delete).toBe("Delete");
	});

	for (const locale of LOCALES) {
		it(`${locale}: no customer-facing catalogue value carries a forbidden term`, () => {
			const hits = scanCatalogue(messagesFor(locale)).map(
				(h) => `${h.key} [${h.id}] «${h.match}» — ${h.value.slice(0, 90)}`,
			);
			expect(hits).toEqual([]);
		});
	}

	it("every registry pattern matches its own planted example (a loosened regex cannot pass silently)", () => {
		const planted: Record<string, string> = {
			"status-number": "Health is not tracked yet (STATUS #36).",
			"task-number": "Re-run the census (task #27).",
			"task-number-ja": "センサスを再走してください(タスク #27)。",
			ledger: "the full census lives in docs/ (ledger #164).",
			"ledger-ja": "完全なセンサスは docs/(台帳 #164)。",
			readme: "see the README",
			bitovp: "bitovp's own read of the origin",
			"live-channel": "provisioned by the live-channel worker",
			orchestrator: "executed by the orchestrator",
			"orchestrator-ja": "オーケストレータが実行する",
			worker: "the worker retries",
			"worker-ja": "ワーカーが実行中",
			redis: "Redis unreachable",
			broker: "Cannot reach the broker",
			sdk: "Installed SDK",
			"sdk-object": "StartEncodingRequest.tweaks is forwarded as-is",
			openapi: "OpenAPI-driven variant",
			"raw-encoding-mode": "Start this encode with THREE_PASS",
			ffmpeg: "our ffmpeg + libvmaf pipeline",
			pid: "PID 4242",
			sigterm: "SIGTERM → 5s grace",
			sigkill: "then SIGKILL",
			"auth-mode": "AUTH_MODE=none",
			"stream-loop": "(-re -stream_loop -1)",
			"seed-vmaf": "apps/web/scripts/seed-vmaf.ts",
			"python-sample": "One preset per encoding examples script",
			golden: "the encoding examples golden plans",
			fixture: "the acceptance fixtures behind",
			"roadmap-ja": "OIDC は今後対応します。",
			"admin-diagnostics": "Administrator diagnostics",
			"internal-implementation":
				"Internal implementation status and verification results.",
			"release-evidence": "Internal implementation status and release evidence",
			"endpoint-implementation":
				"Encoding-API support status — implementation state per endpoint and per parameter.",
			"phase-badge": "lands with P1",
			"constraint-code": "resolved only after the run (C4 placeholders)",
			"issue-number": "OIDC single-sign-on (#31) is still to come.",
		};
		for (const term of FORBIDDEN_CUSTOMER_TERMS) {
			const example = planted[term.id];
			expect(example, `planted example for ${term.id}`).toBeDefined();
			expect(
				findForbiddenTerms(example as string).map((h) => h.id),
				term.id,
			).toContain(term.id);
		}
		// And every planted example names a term that still exists.
		expect(Object.keys(planted).sort()).toEqual(
			FORBIDDEN_CUSTOMER_TERMS.map((t) => t.id).sort(),
		);
	});

	it("percentiles are not phase badges, and a Dolby Vision profile IS one — the allowlist is load-bearing, not the regex", () => {
		expect(findForbiddenTerms("P90 起動時間 + 余裕").map((h) => h.id)).toEqual(
			[],
		);
		expect(findForbiddenTerms("P50/P90 のない行").map((h) => h.id)).toEqual([]);
		expect(findForbiddenTerms("DV P5 三重ラダー").map((h) => h.id)).toEqual([
			"phase-badge",
		]);
		expect(findForbiddenTerms("DV P8.1 + SDR").map((h) => h.id)).toEqual([
			"phase-badge",
		]);
	});

	it("allowlists only keys that exist, and every allowlisted key still needs its exemption", () => {
		for (const entry of CATALOGUE_ALLOWLIST) {
			for (const locale of LOCALES) {
				const value = catalogueLeaves(messagesFor(locale)).get(entry.key);
				expect(value, `${locale}.${entry.key}`).toBeDefined();
			}
			// A stale entry (its key no longer hits any of its terms in EITHER
			// locale) would silently hide a successor's leak; the Dolby titles
			// hit in both, the census page's EN/JA halves each hit their own
			// spelling of the term.
			const stillHits = LOCALES.some((locale) =>
				findForbiddenTerms(
					catalogueLeaves(messagesFor(locale)).get(entry.key) as string,
				).some((h) => entry.terms.includes(h.id)),
			);
			expect(stillHits, `${entry.key} still needs its allowlist entry`).toBe(
				true,
			);
		}
	});

	it("pins the customer wording for QC, storage and sample-preset onboarding", () => {
		const ja = messagesFor("ja");
		const en = messagesFor("en");
		expect(ja.subtitles.vmafLab).toBe(
			"VMAFとPSNRによる品質レポート。レンディションごとに平均・下位1%・パーセンタイル・フレームごとの時系列を表示します。",
		);
		expect(ja.uiX.libvmafModelTooltip).toBe(
			"比較するレポートでは同じモデルを使用してください。通常は標準視聴条件（推奨）を選択します。",
		);
		expect(en.uiX.libvmafModelTooltip).toBe(
			"Use the same model for reports you compare. The standard viewing condition is recommended for most comparisons.",
		);
		expect(ja.prose.presetGalleryIntro).toContain(
			"認証情報、入力パス、保存先を確認して使用してください。",
		);
		expect(en.prose.presetGalleryIntro).toContain(
			"check the credentials, input paths and destinations",
		);
		expect(ja.storage.notBrowsableSuffix).toBe(
			"（この画面から参照できません）",
		);
	});
});

// ---------------------------------------------------------------------------
// (b) the render arm
// ---------------------------------------------------------------------------

type Session = {
	mode: string;
	configured: boolean;
	authenticated: boolean;
	loginKind: string;
	role?: string;
};
const CUSTOMER: Session = {
	mode: "users",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
	role: "VIEWER",
};
const OPERATOR: Session = { ...CUSTOMER, role: "OPERATOR" };

const USAGE_ZERO = {
	bytesEncoded: 0,
	timeEncodedS: 0,
	bytesEgress: 0,
	billableEncodingMinutes: 0,
	billableFeatureMinutes: 0,
	billableTransmuxingMinutes: 0,
	billableMinutes: 0,
};
const USAGE: UsageSeries = {
	from: "2026-09-04",
	to: "2026-09-06",
	days: [
		{ date: "2026-09-04", VOD: USAGE_ZERO, LIVE: USAGE_ZERO },
		{
			date: "2026-09-05",
			VOD: {
				bytesEncoded: 10,
				timeEncodedS: 7200,
				bytesEgress: 2048,
				billableEncodingMinutes: 12.5,
				billableFeatureMinutes: 0,
				billableTransmuxingMinutes: 0,
				billableMinutes: 12.5,
			},
			LIVE: {
				bytesEncoded: 5,
				timeEncodedS: 3600,
				bytesEgress: 1024,
				billableEncodingMinutes: 60,
				billableFeatureMinutes: 0,
				billableTransmuxingMinutes: 0,
				billableMinutes: 60,
			},
		},
		{ date: "2026-09-06", VOD: USAGE_ZERO, LIVE: USAGE_ZERO },
	],
	totals: {
		VOD: {
			bytesEncoded: 10,
			timeEncodedS: 7200,
			bytesEgress: 2048,
			billableEncodingMinutes: 12.5,
			billableFeatureMinutes: 0,
			billableTransmuxingMinutes: 0,
			billableMinutes: 12.5,
		},
		LIVE: {
			bytesEncoded: 5,
			timeEncodedS: 3600,
			bytesEgress: 1024,
			billableEncodingMinutes: 60,
			billableFeatureMinutes: 0,
			billableTransmuxingMinutes: 0,
			billableMinutes: 60,
		},
	},
	breakdown: {
		buckets: {
			VOD: { SD: 0, HD: 12.5, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
			LIVE: { SD: 0, HD: 60, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
		},
		codecResolution: [
			{
				kind: "VOD",
				codec: "H264",
				resolution: "1920x1080",
				billableMinutes: 12.5,
				encodedSeconds: 7200,
			},
		],
		egress: [{ category: "ENCODING", region: "EU", bytes: 3072 }],
	},
	accounts: [
		{ id: "acc-1", label: "Primary" },
		{ id: "acc-2", label: "Secondary" },
	],
	refreshedAt: "2026-09-06T01:00:00.000Z",
	pendingDays: 1,
};

function job(over: Partial<JobListItem> = {}): JobListItem {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		name: "Sample job",
		labels: [],
		status: "FINISHED",
		region: "us-east-1",
		doneSteps: 5,
		totalSteps: 5,
		error: null,
		bitmovinEncodingId: "bm-1",
		qcVerdict: null,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:02:30.000Z",
		finishedAt: "2026-06-18T00:02:30.000Z",
		...over,
	};
}

const NOW = "2026-08-29T12:00:00.000Z";
const nowMs = Date.parse(NOW);

function health(over: Partial<LiveChannelHealthDigest> = {}) {
	return {
		heartbeat: null,
		openAlerts: 0,
		activeFeeders: 0,
		erroredFeeders: 0,
		origin: null,
		runningSince: null,
		endedAt: null,
		maxRunMinutes: null,
		...over,
	} satisfies LiveChannelHealthDigest;
}

function channel(over: Partial<LiveChannelListItem> = {}): LiveChannelListItem {
	return {
		id: "00000000-0000-4000-8000-0000000000c1",
		name: "Channel A",
		status: "STOPPED",
		error: null,
		bitmovinEncodingId: "bm-1",
		bitmovinAccountId: null,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:00:00.000Z",
		health: health(),
		...over,
	};
}

function vmafItem(over: Partial<VmafJobListItem> = {}): VmafJobListItem {
	return {
		id: "00000000-0000-4000-8000-0000000000a5",
		encodingJobId: null,
		encodingName: null,
		mode: "VOD",
		model: "vmaf_v0.6.1",
		scoringVersion: 2,
		status: "FINISHED",
		error: null,
		createdAt: "2026-06-18T00:00:00.000Z",
		renditionMeans: [{ label: "360p", mean: 84.2 }],
		...over,
	};
}

/** The DOM's copy must be clean; on failure the message names the term. */
function expectClean(locale: Locale) {
	const hits = scanDom(document.body, messagesFor(locale)).map(
		(h) => `[${h.id}] «${h.match}»`,
	);
	expect(hits, `${locale} DOM`).toEqual([]);
}

function withFlags(node: ReactNode, locale: Locale) {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf: true }}>
			{node}
		</FeatureFlagsProvider>,
		locale,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	searchParams = new URLSearchParams();
});

afterEach(() => {
	window.localStorage.clear();
});

describe("customer copy gate — render arm", () => {
	for (const locale of LOCALES) {
		describe(locale, () => {
			const m = messagesFor(locale);

			it("dashboard usage: a loaded series with pending days", async () => {
				apiFetch.mockImplementation(async (url: string) =>
					url === "/api/auth/session" ? CUSTOMER : USAGE,
				);
				withFlags(<DashboardUsage data={USAGE} />, locale);
				await screen.findByText(m.usage.retentionNote, { exact: false });
				expectClean(locale);
			});

			it("dashboard usage: nothing stored yet, then a load failure", async () => {
				apiFetch.mockImplementation(async (url: string) =>
					url === "/api/auth/session"
						? CUSTOMER
						: { ...USAGE, refreshedAt: null, pendingDays: 0 },
				);
				const blank = withFlags(
					<DashboardUsage
						data={{ ...USAGE, refreshedAt: null, pendingDays: 0 }}
					/>,
					locale,
				);
				await screen.findByText(m.usage.neverRefreshed, { exact: false });
				expectClean(locale);
				blank.unmount();

				apiFetch.mockImplementation(async (url: string) => {
					if (url === "/api/auth/session") return CUSTOMER;
					if (url === "/api/bitmovin-accounts")
						return [{ id: "account", label: "Account" }];
					if (url.includes("/backfill")) return { job: null };
					throw new Error("upstream 502");
				});
				withFlags(<DashboardHome />, locale);
				expect(
					(await screen.findAllByText(new RegExp(m.usage.loadFailed))).length,
				).toBeGreaterThan(0);
				expectClean(locale);
			});

			it("settings landing: users-mode VIEWER and the single-owner install", async () => {
				apiFetch.mockResolvedValue(CUSTOMER);
				const viewer = renderWithQuery(<SettingsAreas />, locale);
				await screen.findByText(m.settings.storageCredentials);
				expect(screen.queryByText(m.settingsX.groupAccess)).toBeNull();
				expectClean(locale);
				viewer.unmount();

				apiFetch.mockResolvedValue({
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				});
				renderWithQuery(<SettingsAreas />, locale);
				await screen.findByText(m.settingsX.groupAccess);
				expect(screen.queryByText(m.settingsX.groupDiagnostics)).toBeNull();
				expect(document.querySelector('a[href="/verification"]')).toBeNull();
				expectClean(locale);
			});

			it("presets: sample gallery, delivery specs and an empty / failed saved delivery list", async () => {
				apiFetch.mockResolvedValue([]);
				const empty = withFlags(
					<>
						<MyPresets />
						<DeliveryGallery specs={[...DELIVERY_SPECS]} />
						<PresetGallery
							families={SAMPLE_PRESET_FAMILIES}
							presets={SAMPLE_PRESETS}
						/>
					</>,
					locale,
				);
				await screen.findByText(m.templates.emptyDelivery);
				expectClean(locale);
				empty.unmount();

				apiFetch.mockRejectedValue(new Error("boom"));
				withFlags(<MyPresets />, locale);
				await screen.findByText(m.templates.loadDeliveryFailed);
				expectClean(locale);
			});

			it("storage: a credential this screen cannot browse, and a failed credential read", async () => {
				apiFetch.mockImplementation(async (url: string) => {
					if (url === "/api/credentials") {
						return [
							{ id: "az-1", label: "My Azure", provider: "AZURE_BLOB" },
							{ id: "drm-1", label: "Widevine keys", provider: "DRM_CENC" },
						];
					}
					if (url === "/api/storage-presets") {
						return [];
					}
					return { buckets: [] };
				});
				const loaded = renderWithQuery(<StorageClient />, locale);
				const expectedName = `Widevine keys${m.storage.notBrowsableSuffix}`;
				const option = await screen.findByRole("option", {
					// A function, not a RegExp: the EN suffix carries parentheses.
					name: (name) => name.trim() === expectedName.trim(),
				});
				expect(option).toBeDisabled();
				expectClean(locale);
				loaded.unmount();

				apiFetch.mockImplementation(async (url: string) => {
					if (url === "/api/credentials") {
						throw new Error("boom");
					}
					return [];
				});
				renderWithQuery(<StorageClient />, locale);
				await screen.findByRole("alert");
				expectClean(locale);
			});

			it("VOD list: empty, then a failed job with a raw provider error", async () => {
				apiFetch.mockResolvedValue({ items: [] });
				const empty = withFlags(<JobsClient />, locale);
				expect(
					screen.getByRole("heading", { level: 1, name: m.jobs.title }),
				).toBeInTheDocument();
				expect(screen.queryByText(m.subtitles.vodJobs)).not.toBeInTheDocument();
				expectClean(locale);
				empty.unmount();

				apiFetch.mockResolvedValue({
					items: [
						job({
							status: "ERROR",
							error: "POST /encoding/encodings/x/start 400 (upstream)",
						}),
						job({
							id: "00000000-0000-4000-8000-000000000002",
							status: "QUEUED",
						}),
					],
				});
				withFlags(<JobsClient />, locale);
				expect(
					screen.getByRole("heading", { level: 1, name: m.jobs.title }),
				).toBeInTheDocument();
				expect(screen.queryByText(m.subtitles.vodJobs)).not.toBeInTheDocument();
				await waitFor(() =>
					expect(screen.getAllByText("Sample job").length).toBeGreaterThan(0),
				);
				expectClean(locale);
			});

			it("Live list: empty, then a running, a stale and an errored channel", async () => {
				apiFetch.mockImplementation(async (url: string) =>
					url === "/api/bitmovin-accounts" ? [] : { items: [], serverNow: NOW },
				);
				const empty = renderWithQuery(<ChannelsClient />, locale);
				expect(
					screen.getByRole("heading", { level: 1, name: m.live.title }),
				).toBeInTheDocument();
				expect(
					screen.queryByText(m.subtitles.liveChannels),
				).not.toBeInTheDocument();
				expectClean(locale);
				empty.unmount();

				apiFetch.mockImplementation(async (url: string) =>
					url === "/api/bitmovin-accounts"
						? []
						: {
								serverNow: NOW,
								items: [
									channel({
										id: "00000000-0000-4000-8000-000000000001",
										name: "Bravo healthy",
										status: "RUNNING",
										health: health({
											heartbeat: {
												at: new Date(nowMs - 12_000).toISOString(),
												raw: { ingest: { status: "CONNECTED", healthy: true } },
											},
											runningSince: new Date(nowMs - 3_600_000).toISOString(),
										}),
									}),
									channel({
										id: "00000000-0000-4000-8000-000000000002",
										name: "Delta stale",
										status: "RUNNING",
										health: health({
											heartbeat: {
												at: new Date(nowMs - 600_000).toISOString(),
												raw: { ingest: { status: "CONNECTED", healthy: true } },
											},
										}),
									}),
									channel({
										id: "00000000-0000-4000-8000-000000000003",
										name: "Foxtrot errored",
										status: "ERROR",
										error: "NoSuchKey (upstream 404)",
									}),
								],
							},
				);
				renderWithQuery(<ChannelsClient />, locale);
				expect(
					screen.getByRole("heading", { level: 1, name: m.live.title }),
				).toBeInTheDocument();
				expect(
					screen.queryByText(m.subtitles.liveChannels),
				).not.toBeInTheDocument();
				await screen.findByText("Foxtrot errored");
				expectClean(locale);
			});

			it("Live action errors cannot expose an internal registry reference", async () => {
				const privatePointer = "led" + "ger #108";
				apiFetch.mockImplementation(async (url: string) => {
					if (url === "/api/auth/session") return CUSTOMER;
					throw new ApiError(
						409,
						`Restart refused — provider state is terminal (${privatePointer})`,
					);
				});
				renderWithQuery(
					<ChannelLifecycleActions
						channelId="ch-1"
						status="RUNNING"
						hasEncoding
					/>,
					locale,
				);
				const user = userEvent.setup();
				await user.click(screen.getByRole("button", { name: m.live.restart }));
				await user.click(screen.getByRole("button", { name: m.live.restart }));
				await screen.findByRole("alert");
				expectClean(locale);
			});

			it("file input list: internal process failures stay out of the customer DOM", async () => {
				apiFetch.mockImplementation(async (url: string) => {
					if (url === "/api/auth/session") return CUSTOMER;
					if (url === "/api/feeder-sessions") {
						return {
							items: [
								{
									id: "00000000-0000-4000-8000-0000000000f1",
									liveChannelId: "00000000-0000-4000-8000-0000000000c1",
									status: "ERROR",
									protocol: "RTMP",
									sourceBucket: "media",
									sourceKey: "clip.mp4",
									pid: null,
									processGoneAt: null,
									publisherClaimedAt: null,
									publisherReleasedAt: null,
									startedAt: null,
									stoppedAt: "2026-08-31T00:00:00.000Z",
									error:
										"worker lost ffmpeg PID 4242 while -stream_loop remained active",
									createdAt: "2026-08-31T00:00:00.000Z",
									updatedAt: "2026-08-31T00:00:00.000Z",
								},
							],
						};
					}
					return { items: [] };
				});
				const rendered = renderWithQuery(<FeedersClient />, locale);
				await screen.findByText(m.feeder.title);
				expectClean(locale);
				rendered.unmount();
			});

			it("QC list: a report still scoring shows a translated pending cell", async () => {
				apiFetch.mockResolvedValue({
					items: [
						vmafItem({ status: "RUNNING", renditionMeans: [] }),
						vmafItem({ id: "00000000-0000-4000-8000-0000000000a6" }),
					],
				});
				withFlags(<VmafLabClient />, locale);
				expect(await screen.findByText(m.qc.pendingScore)).toBeInTheDocument();
				expectClean(locale);
			});

			it("QC compare: every requested report gone", async () => {
				searchParams = new URLSearchParams(
					"jobs=00000000-0000-4000-8000-0000000000d1,00000000-0000-4000-8000-0000000000d2",
				);
				apiFetch.mockRejectedValue(new Error("404"));
				renderWithQuery(<CompareClient />, locale);
				await screen.findByText(new RegExp(m.prose.noReportsLoaded));
				expect(
					screen.getByText(new RegExp(m.qc.mayHaveBeenDeleted.trim())),
				).toBeInTheDocument();
				expectClean(locale);
			});

			it("content insertion: an unparseable run time is refused in the page's language", async () => {
				apiFetch.mockImplementation(async (url: string) =>
					url === "/api/auth/session"
						? OPERATOR
						: {
								items: [
									{
										id: "ic-1",
										name: "slate",
										status: "READY",
										inputs: [{ inputPath: "/slates/a.mp4" }],
									},
								],
							},
				);
				renderWithQuery(
					<ContentInsertionPanel
						channelId="ch-1"
						status="RUNNING"
						bitmovinAccountId="acct-1"
					/>,
					locale,
				);
				const user = userEvent.setup();
				await user.click(
					await screen.findByRole("button", {
						name: m.contentInsertion.schedule,
					}),
				);
				// A six-digit year is a valid datetime-local string for the browser
				// and NaN for ECMAScript's Date — the branch the guard exists for.
				fireEvent.change(screen.getByLabelText(m.contentInsertion.runAt), {
					target: { value: "275760-09-13T00:01" },
				});
				await user.click(
					screen.getByRole("button", { name: m.common.confirm }),
				);
				expect(
					await screen.findByText(m.contentInsertion.runAtInvalid),
				).toBeInTheDocument();
				expectClean(locale);
			});

			it("ESAM: an unparseable match time is refused in the page's language", async () => {
				renderWithQuery(
					<EsamPanel
						channelId="ch-1"
						status="RUNNING"
						bitmovinAccountId="acct-1"
					/>,
					locale,
				);
				fireEvent.change(screen.getByLabelText(m.esam.matchTime), {
					target: { value: "275760-09-13T00:01" },
				});
				await userEvent
					.setup()
					.click(screen.getByRole("button", { name: m.esam.insert }));
				const alert = await screen.findByRole("alert");
				expect(
					within(alert).getByText(m.esam.matchTimeInvalid),
				).toBeInTheDocument();
				expectClean(locale);
			});
		});
	}
});
