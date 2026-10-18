import type {
	EncodingJobStatus,
	FeederStatus,
	LiveChannelStatus,
	VmafStatus,
} from "@bitovp/db";
import { z } from "zod";
import type { MessageKey } from "@/lib/i18n";
import {
	RESET_CATEGORIES,
	type ResetCategory,
	requiredResetCategories,
} from "./reset-selection";

/** Stable customer categories; none is a Prisma model or worker identifier. */
export const RESET_DELETE_CATEGORIES = RESET_CATEGORIES;
export type ResetDeleteCategory = ResetCategory;

export const RESET_DELETE_CATEGORY_MESSAGE_KEYS = {
	vodJobs: "settingsX.resetDeleteVodJobs",
	liveChannels: "settingsX.resetDeleteLiveChannels",
	liveSchedules: "settingsX.resetDeleteLiveSchedules",
	pseudoLiveFeeds: "settingsX.resetDeletePseudoLiveFeeds",
	vmafMeasurements: "settingsX.resetDeleteVmafMeasurements",
	storageChecks: "settingsX.resetDeleteStorageChecks",
	watchFolderHistory: "settingsX.resetDeleteWatchFolderHistory",
	alertHistory: "settingsX.resetDeleteAlertHistory",
	webhookHistory: "settingsX.resetDeleteWebhookHistory",
	auditHistory: "settingsX.resetDeleteAuditHistory",
	contentLibrary: "settingsX.resetDeleteContentLibrary",
	channelAlertRules: "settingsX.resetDeleteChannelAlertRules",
	alertRules: "settingsX.resetDeleteAlertRules",
	webhookRegistrations: "settingsX.resetDeleteWebhookRegistrations",
	verificationHistory: "settingsX.resetDeleteVerificationHistory",
	watchFolders: "settingsX.resetDeleteWatchFolders",
	notificationRules: "settingsX.resetDeleteNotificationRules",
	notificationChannels: "settingsX.resetDeleteNotificationChannels",
	storagePresets: "settingsX.resetDeleteStoragePresets",
	presets: "settingsX.resetDeletePresets",
	usageStatistics: "settingsX.resetDeleteUsageStatistics",
	bitmovinAccounts: "settingsX.resetDeleteBitmovinAccounts",
	credentials: "settingsX.resetDeleteCredentials",
	apiTokens: "settingsX.resetDeleteApiTokens",
	applicationSettings: "settingsX.resetDeleteApplicationSettings",
} as const satisfies Record<ResetDeleteCategory, MessageKey>;

export const RESET_RESOURCE_TYPE_MESSAGE_KEYS = {
	vodJob: "settingsX.resetResourceVodJob",
	liveChannel: "settingsX.resetResourceLiveChannel",
} as const satisfies Record<string, MessageKey>;

export type ResetResourceType = keyof typeof RESET_RESOURCE_TYPE_MESSAGE_KEYS;

export const RESET_VOD_JOB_STATUSES = [
	"DRAFT",
	"QUEUED",
	"RUNNING",
	"AWAITING_QC",
	"FINISHED",
	"ERROR",
	"CANCELED",
	"QC_FAILED",
] as const;
export const RESET_LIVE_CHANNEL_STATUSES = [
	"CREATED",
	"PROVISIONING",
	"RUNNING",
	"STOPPING",
	"STOPPED",
	"ERROR",
] as const;
export const RESET_FEEDER_STATUSES = [
	"CREATED",
	"DOWNLOADING",
	"PUSHING",
	"STOPPED",
	"ERROR",
] as const;
export const RESET_VMAF_STATUSES = [
	"PENDING",
	"RUNNING",
	"FINISHED",
	"ERROR",
] as const;

export type ResetVodJobStatus = (typeof RESET_VOD_JOB_STATUSES)[number];
export type ResetLiveChannelStatus =
	(typeof RESET_LIVE_CHANNEL_STATUSES)[number];
export type ResetFeederStatus = (typeof RESET_FEEDER_STATUSES)[number];
export type ResetVmafStatus = (typeof RESET_VMAF_STATUSES)[number];

// Compile-time two-way fences: a new database state cannot silently cross the
// customer boundary without a localized domain mapping and runtime schema.
const _vodSubset: ResetVodJobStatus extends EncodingJobStatus ? true : never =
	true;
const _vodComplete: EncodingJobStatus extends ResetVodJobStatus ? true : never =
	true;
const _liveSubset: ResetLiveChannelStatus extends LiveChannelStatus
	? true
	: never = true;
const _liveComplete: LiveChannelStatus extends ResetLiveChannelStatus
	? true
	: never = true;
const _feederSubset: ResetFeederStatus extends FeederStatus ? true : never =
	true;
const _feederComplete: FeederStatus extends ResetFeederStatus ? true : never =
	true;
const _vmafSubset: ResetVmafStatus extends VmafStatus ? true : never = true;
const _vmafComplete: VmafStatus extends ResetVmafStatus ? true : never = true;
void [
	_vodSubset,
	_vodComplete,
	_liveSubset,
	_liveComplete,
	_feederSubset,
	_feederComplete,
	_vmafSubset,
	_vmafComplete,
];

/** Customer words for stored states; raw database enums never render. */
export const RESET_VOD_STATUS_MESSAGE_KEYS = {
	DRAFT: "settingsX.resetStatusDraft",
	QUEUED: "settingsX.resetStatusQueued",
	RUNNING: "settingsX.resetStatusEncoding",
	AWAITING_QC: "settingsX.resetStatusAwaitingQuality",
	FINISHED: "settingsX.resetStatusCompleted",
	ERROR: "settingsX.resetStatusError",
	CANCELED: "settingsX.resetStatusCanceled",
	QC_FAILED: "settingsX.resetStatusQualityFailed",
} as const satisfies Record<ResetVodJobStatus, MessageKey>;

export const RESET_LIVE_STATUS_MESSAGE_KEYS = {
	CREATED: "settingsX.resetStatusCreated",
	PROVISIONING: "settingsX.resetStatusPreparing",
	RUNNING: "settingsX.resetStatusLive",
	STOPPING: "settingsX.resetStatusStopping",
	STOPPED: "settingsX.resetStatusStopped",
	ERROR: "settingsX.resetStatusError",
} as const satisfies Record<ResetLiveChannelStatus, MessageKey>;

export const RESET_FEEDER_STATUS_MESSAGE_KEYS = {
	CREATED: "settingsX.resetStatusCreated",
	DOWNLOADING: "settingsX.resetStatusDownloading",
	PUSHING: "settingsX.resetStatusSending",
	STOPPED: "settingsX.resetStatusStopped",
	ERROR: "settingsX.resetStatusError",
} as const satisfies Record<ResetFeederStatus, MessageKey>;

export const RESET_VMAF_STATUS_MESSAGE_KEYS = {
	PENDING: "settingsX.resetStatusQueued",
	RUNNING: "settingsX.resetStatusMeasuring",
	FINISHED: "settingsX.resetStatusCompleted",
	ERROR: "settingsX.resetStatusError",
} as const satisfies Record<ResetVmafStatus, MessageKey>;

const resetVodJobStatusSchema = z.enum(RESET_VOD_JOB_STATUSES);
const resetLiveChannelStatusSchema = z.enum(RESET_LIVE_CHANNEL_STATUSES);
const resetFeederStatusSchema = z.enum(RESET_FEEDER_STATUSES);
const resetVmafStatusSchema = z.enum(RESET_VMAF_STATUSES);
const resetDeleteCategorySchema = z.enum(RESET_DELETE_CATEGORIES);
const customerHrefSchema = z
	.string()
	.regex(/^\/(?:vod\/jobs|live|live\/feeders|qc)\/[^/]+$/);

export const resetProviderResourceSchema = z.discriminatedUnion(
	"resourceType",
	[
		z
			.object({
				resourceType: z.literal("vodJob"),
				name: z.string().nullable(),
				status: resetVodJobStatusSchema,
				bitmovinEncodingId: z.string().min(1),
			})
			.strict(),
		z
			.object({
				resourceType: z.literal("liveChannel"),
				name: z.string().nullable(),
				status: resetLiveChannelStatusSchema,
				bitmovinEncodingId: z.string().min(1),
			})
			.strict(),
	],
);

const resetActiveSchema = z
	.object({
		vodJobs: z.array(
			z
				.object({
					name: z.string().min(1),
					status: resetVodJobStatusSchema,
					href: customerHrefSchema,
				})
				.strict(),
		),
		liveChannels: z.array(
			z
				.object({
					name: z.string().min(1),
					status: resetLiveChannelStatusSchema,
					href: customerHrefSchema,
				})
				.strict(),
		),
		pseudoLiveFeeds: z.array(
			z
				.object({
					channelName: z.string().min(1),
					sourceName: z.string().min(1),
					status: resetFeederStatusSchema,
					createdAt: z.iso.datetime(),
					href: customerHrefSchema,
				})
				.strict(),
		),
		vmafMeasurements: z.array(
			z
				.object({
					encodingName: z.string().min(1).nullable(),
					mode: z.enum(["VOD", "LIVE"]),
					status: resetVmafStatusSchema,
					createdAt: z.iso.datetime(),
					href: customerHrefSchema,
				})
				.strict(),
		),
		providerResourcesToCheck: z.array(resetProviderResourceSchema),
		totals: z
			.object({
				vodJobs: z.number().int().nonnegative(),
				liveChannels: z.number().int().nonnegative(),
				pseudoLiveFeeds: z.number().int().nonnegative(),
				vmafMeasurements: z.number().int().nonnegative(),
				providerResourcesToCheck: z.number().int().nonnegative(),
			})
			.strict(),
	})
	.strict();

export const resetPreviewResponseSchema = z
	.object({
		active: resetActiveSchema,
		cleanupUnconfirmed: z.boolean(),
		blocked: z.boolean(),
		/** First missing snapshot; repeated previews lead through the remaining jobs. */
		aisaSnapshotRequiredJobHref: customerHrefSchema.nullable().default(null),
		deleteCounts: z.array(
			z
				.object({
					category: resetDeleteCategorySchema,
					count: z.number().int().nonnegative(),
				})
				.strict(),
		),
		channelAlertsToDelete: z.number().int().nonnegative(),
		watchFoldersToDisable: z.number().int().nonnegative(),
		confirmation: z.literal("RESET"),
		selectionBlocked: z.boolean().optional(),
	})
	.strict();

export const resetSelectionSchema = z
	.array(resetDeleteCategorySchema)
	.min(1)
	.max(RESET_CATEGORIES.length)
	.refine(
		(selected) => new Set(selected).size === selected.length,
		"Duplicate selection",
	)
	.refine(
		(selected) =>
			requiredResetCategories(selected).every((category) =>
				selected.includes(category),
			),
		"Select dependent data categories too",
	);
export const resetRequestSchema = z
	.object({ confirm: z.string(), categories: resetSelectionSchema.optional() })
	.strict();

const resetProviderResourceReportSchema = z
	.object({
		pointers: z.array(resetProviderResourceSchema),
		total: z.number().int().nonnegative(),
		truncated: z.boolean(),
	})
	.strict()
	.superRefine((report, context) => {
		const omitted = report.total > report.pointers.length;
		if (report.total < report.pointers.length || report.truncated !== omitted) {
			context.addIssue({
				code: "custom",
				message: "provider resource total and truncation flag disagree",
			});
		}
	});

export const resetPostAvailableResponseSchema = z
	.object({
		reportStatus: z.literal("available"),
		deletedCounts: z
			.array(
				z
					.object({
						category: resetDeleteCategorySchema,
						count: z.number().int().nonnegative(),
					})
					.strict(),
			)
			.optional(),
		requiresSetup: z.literal(false).optional(),
		queueCleanupIncomplete: z.boolean(),
		temporaryStreamKeyCleanupUnconfirmed: z.boolean(),
		providerResources: resetProviderResourceReportSchema,
		auditRecorded: z.union([z.boolean(), z.literal("unknown")]),
		disabledWatchFolders: z.array(
			z.object({ name: z.string().min(1) }).strict(),
		),
	})
	.strict();

const resetPostUnconfirmedResponseSchema = z
	.object({ reportStatus: z.literal("unconfirmed") })
	.strict();

export const resetPostResponseSchema = z.discriminatedUnion("reportStatus", [
	resetPostAvailableResponseSchema,
	resetPostUnconfirmedResponseSchema,
]);

export type ResetPreviewResponse = z.infer<typeof resetPreviewResponseSchema>;
export type ResetPostResponse = z.infer<typeof resetPostResponseSchema>;
export type ResetPostAvailableResponse = z.infer<
	typeof resetPostAvailableResponseSchema
>;
export type ResetRequest = z.infer<typeof resetRequestSchema>;
export type ResetProviderResource = z.infer<typeof resetProviderResourceSchema>;

/** : what `POST /api/admin/reset/reconcile` answers. */
const resetReconcilePointerSchema = z
	.object({
		resourceType: z.enum(["vodJob", "liveChannel"]),
		id: z.string(),
		name: z.string().nullable(),
		status: z.string(),
		bitmovinEncodingId: z.string(),
	})
	.strict();
export const resetReconcileResponseSchema = z
	.object({
		confirmed: z.array(resetReconcilePointerSchema),
		running: z.array(
			resetReconcilePointerSchema.extend({ providerStatus: z.string() }),
		),
		unverified: z.array(
			resetReconcilePointerSchema.extend({ message: z.string() }),
		),
	})
	.strict();
export type ResetReconcileResponse = z.infer<
	typeof resetReconcileResponseSchema
>;
