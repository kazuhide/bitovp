/** Organization-owned reset choices. Global identities are managed separately. */
export const RESET_GLOBAL_MODELS = [
	"user",
	"setupCode",
	"organization",
	"membership",
	"platformSetting",
] as const;

/** Recovery ownership must outlive deleted customer rows. */
export const RESET_INTERNAL_MODELS = [
	"resetCleanupTask",
	"vmafComputeTask",
] as const;

export const RESET_CATALOG = [
	{
		category: "contentLibrary",
		models: [
			"contentRevision",
			"content",
			"sceneAnalysisRevision",
			"librarySource",
		],
	},
	{ category: "webhookHistory", models: ["webhookEvent"] },
	{ category: "auditHistory", models: ["auditLog", "accessEvent"] },
	{ category: "storageChecks", models: ["storageInspection"] },
	{ category: "watchFolderHistory", models: ["watchedObject"] },
	{ category: "alertHistory", models: ["alertEvent"] },
	{
		category: "channelAlertRules",
		models: ["alertRule"],
		where: { liveChannelId: { not: null } },
	},
	{
		category: "alertRules",
		models: ["alertRule"],
		where: { liveChannelId: null },
	},
	{
		category: "liveSchedules",
		models: ["slateNormalization", "liveSchedule", "liveEffectClaim"],
	},
	{ category: "pseudoLiveFeeds", models: ["feederSession"] },
	{ category: "vmafMeasurements", models: ["vmafResult", "vmafJob"] },
	{ category: "webhookRegistrations", models: ["webhookRegistration"] },
	{
		category: "verificationHistory",
		models: [
			"feederPushAttempt",
			"verificationLiveEvidence",
			"verificationResourceIntentEvent",
			"verificationResourceIntent",
			"verificationRun",
		],
	},
	{
		category: "liveChannels",
		models: ["liveHeartbeat", "startupSample", "liveChannelRun", "liveChannel"],
	},
	{ category: "vodJobs", models: ["manifestJob", "encodingJob"] },
	{ category: "watchFolders", models: ["watchRule"] },
	{ category: "notificationRules", models: ["notificationRule"] },
	{ category: "notificationChannels", models: ["notificationChannel"] },
	{ category: "storagePresets", models: ["storageLocationPreset"] },
	{ category: "presets", models: ["preset"] },
	{
		category: "usageStatistics",
		models: ["usageDailyStatistic", "usageSweepCursor"],
	},
	{ category: "bitmovinAccounts", models: ["bitmovinAccount"] },
	{ category: "credentials", models: ["credential", "vmafComputeCredential"] },
	{ category: "apiTokens", models: ["apiToken"] },
	{
		category: "applicationSettings",
		models: ["appSetting", "vmafExecutionProfile"],
	},
] as const;

export type ResetCategory = (typeof RESET_CATALOG)[number]["category"];
export type ResetTable = (typeof RESET_CATALOG)[number]["models"][number];
export const RESET_CATEGORIES = RESET_CATALOG.map((entry) => entry.category);

/** Selected parents must never silently cascade/delete unselected children. */
export const RESET_DEPENDENCIES: Partial<
	Record<ResetCategory, readonly ResetCategory[]>
> = {
	liveChannels: [
		"liveSchedules",
		"pseudoLiveFeeds",
		"channelAlertRules",
		"alertHistory",
	],
	channelAlertRules: ["alertHistory"],
	alertRules: ["alertHistory"],
	watchFolders: ["watchFolderHistory"],
	notificationChannels: ["notificationRules"],
	presets: ["watchFolders"],
	credentials: [
		"storageChecks",
		"storagePresets",
		"notificationChannels",
		"watchFolders",
		"presets",
		"vodJobs",
		"liveChannels",
		"contentLibrary",
	],
	bitmovinAccounts: [
		"usageStatistics",
		"vodJobs",
		"liveChannels",
		"contentLibrary",
		"webhookRegistrations",
		"verificationHistory",
	],
	applicationSettings: ["webhookRegistrations"],
};

export function requiredResetCategories(
	selected: readonly ResetCategory[],
): ResetCategory[] {
	const result = new Set(selected);
	for (const category of result) {
		for (const dependency of RESET_DEPENDENCIES[category] ?? [])
			result.add(dependency);
	}
	return RESET_CATEGORIES.filter((category) => result.has(category));
}

export const DEFAULT_RESET_CATEGORIES: ResetCategory[] = [
	"contentLibrary",
	"vodJobs",
	"liveChannels",
	"liveSchedules",
	"pseudoLiveFeeds",
	"vmafMeasurements",
	"storageChecks",
	"watchFolderHistory",
	"alertHistory",
	"webhookHistory",
	"auditHistory",
	"channelAlertRules",
];
