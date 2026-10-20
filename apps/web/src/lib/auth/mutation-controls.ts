import type { UserRole } from "@bitovp/db";

export type MutationMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type MutationControlContract = {
	readonly minRole: UserRole;
	/** Production JSX module that binds this id to the actual control. */
	readonly source: `app/${string}.tsx`;
	/** Exact number of RoleAccess/useMutationAccess bindings in that module. */
	readonly bindings: number;
	/** Higher-floor destinations opened by this control, if any. */
	readonly destinations?: readonly `/${string}`[];
	/** Higher-floor reads embedded in a lower-floor page. */
	readonly reads?: readonly {
		readonly source: `app/${string}.tsx`;
		readonly api: `/api/${string}`;
	}[];
};

/**
 * Action-level RBAC contract for mixed read/write pages.
 *
 * Every id is both a production binding and a rendered-test case. Keeping the
 * role here (instead of next to an arbitrary button) makes a wrong floor fail
 * against the proxy's `evaluateRole` table. `mutation-controls.test.tsx` also
 * checks exact source binding counts and the complete set of mixed-page files,
 * so deleting a gate or adding a new write call cannot leave this table green.
 */
export const MUTATION_CONTROLS = {
	"dashboard.statistics-backfill": {
		minRole: "OPERATOR",
		source: "app/dashboard-backfill.tsx",
		bindings: 1,
	},
	"library.source.capture": {
		minRole: "OPERATOR",
		source: "app/library/job-analysis-panel.tsx",
		bindings: 1,
	},
	"library.content.register": {
		minRole: "OPERATOR",
		source: "app/library/content-registration.tsx",
		bindings: 1,
	},
	"library.source.retry": {
		minRole: "OPERATOR",
		source: "app/library/source-panel.tsx",
		bindings: 1,
	},
	"live.channels.create": {
		minRole: "OPERATOR",
		source: "app/live/channels-client.tsx",
		bindings: 1,
		destinations: ["/live/new"],
	},
	"live.channels.delete": {
		minRole: "OPERATOR",
		source: "app/live/channels-client.tsx",
		bindings: 1,
	},
	"live.channel.alerts": {
		minRole: "OPERATOR",
		source: "app/live/[id]/alert-panel.tsx",
		bindings: 2,
	},
	"live.channel.runtime-cap": {
		minRole: "OPERATOR",
		source: "app/live/[id]/runtime-cap-panel.tsx",
		bindings: 1,
	},
	"live.channel.auto-shutdown": {
		minRole: "OPERATOR",
		source: "app/live/[id]/auto-shutdown-panel.tsx",
		bindings: 1,
	},
	"live.channel.cue": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-detail.tsx",
		bindings: 1,
	},
	"live.channel.esam": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-detail.tsx",
		bindings: 1,
	},
	"live.channel.vmaf": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-detail.tsx",
		bindings: 1,
	},
	"live.channel.advanced": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-detail.tsx",
		bindings: 1,
		destinations: ["/live/new"],
	},
	"live.channel.delete": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-detail.tsx",
		bindings: 1,
	},
	"live.channel.lifecycle": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-detail.tsx",
		bindings: 1,
	},
	"live.channel.rtmp-ingest": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-actions.tsx",
		bindings: 1,
	},
	"live.channel.duplicate": {
		minRole: "OPERATOR",
		source: "app/live/[id]/channel-actions.tsx",
		bindings: 1,
		destinations: ["/live/new"],
	},
	"live.channel.dvr-reset": {
		minRole: "OPERATOR",
		source: "app/live/[id]/dvr-panel.tsx",
		bindings: 1,
	},
	"live.channel.slate": {
		minRole: "OPERATOR",
		source: "app/live/[id]/slate-reservations-panel.tsx",
		bindings: 1,
	},
	"live.channel.inserted-content-stop": {
		minRole: "OPERATOR",
		source: "app/live/[id]/insertion-stop-panel.tsx",
		bindings: 1,
	},
	"live.channel.schedule": {
		minRole: "OPERATOR",
		source: "app/live/[id]/schedule-panel.tsx",
		bindings: 2,
	},
	"live.channel.content-insertion": {
		minRole: "OPERATOR",
		source: "app/live/[id]/content-insertion-panel.tsx",
		bindings: 3,
	},
	"live.channel.feeder": {
		minRole: "OPERATOR",
		source: "app/live/[id]/feeder-panel.tsx",
		bindings: 4,
	},
	"live.channel.live-to-vod": {
		minRole: "OPERATOR",
		source: "app/live/[id]/live-to-vod-panel.tsx",
		bindings: 1,
	},
	"live.channel.heartbeat-log": {
		minRole: "OPERATOR",
		source: "app/live/[id]/heartbeat-log-panel.tsx",
		bindings: 1,
		reads: [
			{
				source: "app/live/[id]/provider-diagnostics-panel.tsx",
				api: "/api/live-channels/[id]/runs/[runId]/diagnostics",
			},
			{
				source: "app/live/[id]/heartbeat-log-panel.tsx",
				api: "/api/live-channels/[id]/runs/[runId]/heartbeats",
			},
			{
				source: "app/live/[id]/push-heartbeat-log.tsx",
				api: "/api/live-channels/[id]/runs/[runId]/heartbeat-receipts",
			},
		],
	},
	"live.channel.heartbeat-export": {
		minRole: "ADMIN",
		source: "app/live/[id]/heartbeat-log-panel.tsx",
		bindings: 1,
		reads: [
			{
				source: "app/live/[id]/provider-diagnostics-panel.tsx",
				api: "/api/live-channels/[id]/runs/[runId]/final-heartbeat",
			},
			{
				source: "app/live/[id]/heartbeat-log-panel.tsx",
				api: "/api/live-channels/[id]/runs/[runId]/heartbeats/export",
			},
		],
	},
	"live.feeders.list": {
		minRole: "OPERATOR",
		source: "app/live/feeders/feeders-client.tsx",
		bindings: 2,
	},
	"live.feeder.detail": {
		minRole: "OPERATOR",
		source: "app/live/feeders/[id]/feeder-detail.tsx",
		bindings: 2,
	},
	"vod.jobs.list": {
		minRole: "OPERATOR",
		source: "app/vod/jobs/jobs-client.tsx",
		bindings: 4,
		destinations: ["/vod/new"],
	},
	"vod.new.drm-credentials": {
		minRole: "ADMIN",
		source: "app/vod/new/drm-row-editor.tsx",
		bindings: 4,
	},
	"vod.job.detail": {
		minRole: "OPERATOR",
		source: "app/vod/jobs/[id]/job-detail.tsx",
		bindings: 4,
	},
	"vod.job.input-inspect": {
		minRole: "OPERATOR",
		source: "app/vod/jobs/[id]/input-files-panel.tsx",
		bindings: 2,
	},
	"vod.job.per-title": {
		minRole: "OPERATOR",
		source: "app/vod/jobs/[id]/per-title-results-panel.tsx",
		bindings: 1,
	},
	"vod.job.qc": {
		minRole: "OPERATOR",
		source: "app/vod/jobs/[id]/qc-gate-panel.tsx",
		bindings: 1,
	},
	"qc.jobs": {
		minRole: "OPERATOR",
		source: "app/qc/vmaf-lab-client.tsx",
		bindings: 3,
	},
	"qc.report.delete": {
		minRole: "OPERATOR",
		source: "app/qc/[id]/vmaf-report.tsx",
		bindings: 1,
	},
	"presets.delivery": {
		minRole: "OPERATOR",
		source: "app/presets/delivery-gallery.tsx",
		bindings: 1,
		destinations: ["/vod/new"],
	},
	"presets.user": {
		minRole: "OPERATOR",
		source: "app/presets/my-presets.tsx",
		bindings: 1,
		destinations: ["/vod/new"],
	},
	"presets.samples": {
		minRole: "OPERATOR",
		source: "app/presets/preset-gallery.tsx",
		bindings: 1,
		destinations: ["/vod/new"],
	},
	"live.new.template": {
		minRole: "OPERATOR",
		source: "app/live/new/live-wizard.tsx",
		bindings: 2,
	},
	"templates.manage": {
		minRole: "OPERATOR",
		source: "app/templates/templates-client.tsx",
		bindings: 3,
		destinations: ["/vod/new", "/live/new"],
	},
	"settings.bitmovin": {
		minRole: "ADMIN",
		source: "app/settings/bitmovin/bitmovin-client.tsx",
		bindings: 4,
	},
	"settings.credentials": {
		minRole: "ADMIN",
		source: "app/settings/credentials/credentials-client.tsx",
		bindings: 5,
	},
	"settings.features": {
		minRole: "ADMIN",
		source: "app/settings/features/features-client.tsx",
		bindings: 1,
	},
	"settings.branding": {
		minRole: "ADMIN",
		source: "app/settings/branding/branding-client.tsx",
		bindings: 1,
	},
	"settings.player": {
		minRole: "ADMIN",
		source: "app/settings/player/player-client.tsx",
		bindings: 1,
	},
	"settings.infrastructure.cloud-connect": {
		minRole: "OPERATOR",
		source: "app/settings/infrastructure/cloud-connect-panel.tsx",
		bindings: 3,
	},
	"settings.infrastructure.regions": {
		minRole: "OPERATOR",
		source: "app/settings/infrastructure/region-settings-editor.tsx",
		bindings: 2,
	},
	"settings.infrastructure.prewarmed-pools": {
		minRole: "ADMIN",
		source: "app/settings/infrastructure/prewarmed-pools-panel.tsx",
		bindings: 6,
	},
	"settings.infrastructure.static-ips": {
		minRole: "OPERATOR",
		source: "app/settings/infrastructure/static-ips-panel.tsx",
		bindings: 3,
	},
	"settings.live.alerts": {
		minRole: "OPERATOR",
		source: "app/settings/live/alerts-panel.tsx",
		bindings: 2,
	},
	"settings.live.dns": {
		minRole: "OPERATOR",
		source: "app/settings/live/dns-mappings-settings-panel.tsx",
		bindings: 3,
	},
	"settings.live.standby-pools": {
		minRole: "ADMIN",
		source: "app/settings/live/standby-pools-panel.tsx",
		bindings: 6,
	},
	"settings.live.startup-probes": {
		minRole: "ADMIN",
		source: "app/settings/live/startup-profiles-panel.tsx",
		bindings: 2,
	},
	"settings.live.heartbeat-webhook": {
		minRole: "ADMIN",
		source: "app/settings/live/heartbeat-webhook-panel.tsx",
		bindings: 1,
	},
	"settings.live.stream-keys": {
		minRole: "OPERATOR",
		source: "app/settings/live/stream-keys-panel.tsx",
		bindings: 3,
		reads: [
			{
				source: "app/settings/live/stream-keys-panel.tsx",
				api: "/api/live/stream-keys/key-1",
			},
		],
	},
	"settings.notifications": {
		minRole: "OPERATOR",
		source: "app/settings/notifications/notifications-client.tsx",
		bindings: 2,
	},
	"settings.watch-folders": {
		minRole: "OPERATOR",
		source: "app/settings/watch-folders/watch-folders-client.tsx",
		bindings: 4,
	},
	"settings.webhook-registration": {
		minRole: "OPERATOR",
		source: "app/settings/webhooks/registration-panel.tsx",
		bindings: 1,
	},
	"settings.webhook-audit": {
		minRole: "ADMIN",
		source: "app/settings/webhooks/webhooks-client.tsx",
		bindings: 1,
		reads: [
			{
				source: "app/settings/webhooks/webhooks-client.tsx",
				api: "/api/audit-logs",
			},
		],
	},
} as const satisfies Record<string, MutationControlContract>;

export type MutationControlId = keyof typeof MUTATION_CONTROLS;

export type MutationSourceContract = {
	readonly writeCalls: number;
	readonly controls: readonly MutationControlId[];
	/** Exported mutation components whose callers, rather than this file, own the panel gate. */
	readonly delegatedExports?: readonly {
		readonly name: string;
		readonly controls: readonly MutationControlId[];
	}[];
};

/**
 * Exact production-source census for write calls on VIEWER-readable pages.
 * Child components name the gate in their parent when the whole child panel
 * is hidden (for example CaptureVmafPanel -> live.channel.vmaf).
 */
export const MUTATION_SOURCE_CENSUS = {
	"app/dashboard-backfill.tsx": {
		writeCalls: 1,
		controls: ["dashboard.statistics-backfill"],
	},
	"app/library/job-analysis-panel.tsx": {
		writeCalls: 1,
		controls: ["library.source.capture"],
	},
	"app/library/content-registration.tsx": {
		writeCalls: 1,
		controls: ["library.content.register"],
	},
	"app/library/source-panel.tsx": {
		writeCalls: 1,
		controls: ["library.source.retry"],
	},
	"app/live/[id]/alert-panel.tsx": {
		writeCalls: 2,
		controls: ["live.channel.alerts"],
	},
	"app/live/[id]/auto-shutdown-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.auto-shutdown"],
	},
	"app/live/[id]/capture-vmaf-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.vmaf"],
		delegatedExports: [
			{ name: "CaptureVmafPanel", controls: ["live.channel.vmaf"] },
		],
	},
	"app/live/[id]/channel-actions.tsx": {
		// Startup cancellation has its own POST, inside the lifecycle OPERATOR gate.
		writeCalls: 5,
		controls: [
			"live.channel.rtmp-ingest",
			"live.channel.lifecycle",
			"live.channel.cue",
			"live.channel.delete",
		],
		delegatedExports: [
			{ name: "ChannelLifecycleActions", controls: ["live.channel.lifecycle"] },
			{ name: "ChannelCueForm", controls: ["live.channel.cue"] },
			{ name: "ChannelDangerZone", controls: ["live.channel.delete"] },
		],
	},
	"app/live/[id]/content-insertion-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.content-insertion"],
	},
	// C36 (WP-A1): registration moved into its own form — the preflight POST
	// and the register POST — rendered by the panel inside the SAME
	// content-insertion gate (the esam-panel delegation shape).
	"app/live/[id]/slate-register-form.tsx": {
		writeCalls: 2,
		controls: ["live.channel.content-insertion"],
		delegatedExports: [
			{
				name: "SlateRegisterForm",
				controls: ["live.channel.content-insertion"],
			},
		],
	},
	"app/live/[id]/dvr-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.dvr-reset"],
	},
	"app/live/[id]/esam-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.esam"],
		delegatedExports: [{ name: "EsamPanel", controls: ["live.channel.esam"] }],
	},
	"app/live/[id]/feeder-panel.tsx": {
		writeCalls: 2,
		controls: ["live.channel.feeder"],
	},
	"app/live/[id]/live-to-vod-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.live-to-vod"],
	},
	"app/live/[id]/runtime-cap-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.runtime-cap"],
	},
	"app/live/[id]/schedule-panel.tsx": {
		writeCalls: 2,
		controls: ["live.channel.schedule"],
	},
	"app/live/[id]/insertion-stop-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.inserted-content-stop"],
	},
	"app/live/[id]/slate-reservations-panel.tsx": {
		writeCalls: 1,
		controls: ["live.channel.slate"],
	},
	"app/live/channels-client.tsx": {
		writeCalls: 1,
		controls: ["live.channels.delete"],
	},
	"app/live/feeders/[id]/feeder-detail.tsx": {
		writeCalls: 2,
		controls: ["live.feeder.detail"],
	},
	"app/live/feeders/feeders-client.tsx": {
		writeCalls: 1,
		controls: ["live.feeders.list"],
	},
	"app/presets/delivery-gallery.tsx": {
		writeCalls: 1,
		controls: ["presets.delivery"],
	},
	"app/presets/my-presets.tsx": {
		writeCalls: 1,
		controls: ["presets.user"],
	},
	"app/qc/[id]/vmaf-report.tsx": {
		writeCalls: 2,
		controls: ["qc.report.delete", "qc.jobs"],
	},
	"app/qc/vmaf-lab-client.tsx": {
		writeCalls: 3,
		controls: ["qc.jobs"],
	},
	"app/settings/bitmovin/bitmovin-client.tsx": {
		writeCalls: 4,
		controls: ["settings.bitmovin"],
	},
	"app/settings/credentials/credentials-client.tsx": {
		writeCalls: 3,
		controls: ["settings.credentials"],
	},
	"app/settings/features/features-client.tsx": {
		writeCalls: 1,
		controls: ["settings.features"],
	},
	"app/settings/infrastructure/cloud-connect-panel.tsx": {
		writeCalls: 2,
		controls: ["settings.infrastructure.cloud-connect"],
	},
	"app/settings/infrastructure/prewarmed-pools-panel.tsx": {
		writeCalls: 5,
		controls: ["settings.infrastructure.prewarmed-pools"],
	},
	"app/settings/infrastructure/region-settings-editor.tsx": {
		writeCalls: 2,
		controls: ["settings.infrastructure.regions"],
	},
	"app/settings/infrastructure/static-ips-panel.tsx": {
		writeCalls: 2,
		controls: ["settings.infrastructure.static-ips"],
	},
	"app/settings/live/alerts-panel.tsx": {
		writeCalls: 3,
		controls: ["settings.live.alerts"],
	},
	"app/settings/live/dns-mappings-settings-panel.tsx": {
		writeCalls: 2,
		controls: ["settings.live.dns"],
	},
	"app/settings/live/standby-pools-panel.tsx": {
		writeCalls: 4,
		controls: ["settings.live.standby-pools"],
	},
	"app/settings/live/startup-profiles-panel.tsx": {
		writeCalls: 2,
		controls: ["settings.live.startup-probes"],
	},
	"app/settings/live/heartbeat-webhook-panel.tsx": {
		writeCalls: 2,
		controls: ["settings.live.heartbeat-webhook"],
	},
	"app/settings/live/stream-keys-panel.tsx": {
		writeCalls: 3,
		controls: ["settings.live.stream-keys"],
	},
	"app/settings/notifications/notifications-client.tsx": {
		writeCalls: 3,
		controls: ["settings.notifications"],
	},
	"app/settings/branding/branding-client.tsx": {
		writeCalls: 1,
		controls: ["settings.branding"],
	},
	"app/settings/player/player-client.tsx": {
		writeCalls: 1,
		controls: ["settings.player"],
	},
	"app/settings/watch-folders/watch-folders-client.tsx": {
		writeCalls: 4,
		controls: ["settings.watch-folders"],
	},
	"app/settings/webhooks/registration-panel.tsx": {
		writeCalls: 2,
		controls: ["settings.webhook-registration"],
	},
	"app/templates/launch-dialog.tsx": {
		writeCalls: 1,
		controls: ["templates.manage"],
		delegatedExports: [
			{ name: "LaunchDialog", controls: ["templates.manage"] },
		],
	},
	"app/templates/live-launch-dialog.tsx": {
		writeCalls: 1,
		controls: ["templates.manage"],
		delegatedExports: [
			{ name: "LiveLaunchDialog", controls: ["templates.manage"] },
		],
	},
	"app/templates/templates-client.tsx": {
		writeCalls: 1,
		controls: ["templates.manage"],
	},
	"app/vod/jobs/[id]/job-detail.tsx": {
		writeCalls: 5,
		controls: ["vod.job.detail"],
	},
	"app/vod/jobs/[id]/per-title-results-panel.tsx": {
		writeCalls: 1,
		controls: ["vod.job.per-title"],
	},
	"app/vod/jobs/[id]/qc-gate-panel.tsx": {
		writeCalls: 1,
		controls: ["vod.job.qc"],
	},
	"app/vod/jobs/jobs-client.tsx": {
		writeCalls: 4,
		controls: ["vod.jobs.list"],
	},
	"app/vod/new/drm-row-editor.tsx": {
		writeCalls: 1,
		controls: ["vod.new.drm-credentials"],
	},
	"components/save-as-template.tsx": {
		writeCalls: 1,
		controls: ["live.channel.advanced", "vod.job.detail", "live.new.template"],
		delegatedExports: [
			{
				name: "SaveAsTemplateButton",
				controls: [
					"live.channel.advanced",
					"vod.job.detail",
					"live.new.template",
				],
			},
		],
	},
} as const satisfies Record<string, MutationSourceContract>;

export type MutationWriteFamily = {
	readonly write: `${Exclude<MutationMethod, "GET">} /api/${string}`;
	readonly controls: readonly MutationControlId[];
};

/**
 * Exact endpoint families invoked by every mixed-page write source.
 *
 * This is intentionally independent from the route-floor table: substituting
 * some other endpoint with the same OPERATOR/ADMIN floor must still fail the
 * source contract. Navigation-only controls remain in `destinations`; they are
 * never used as surrogate evidence for a write.
 */
export const MUTATION_WRITE_FAMILIES = {
	"app/dashboard-backfill.tsx": [
		{
			write: "POST /api/dashboard/usage/backfill",
			controls: ["dashboard.statistics-backfill"],
		},
	],
	"app/library/job-analysis-panel.tsx": [
		{
			write: "POST /api/encoding-jobs/x/analysis",
			controls: ["library.source.capture"],
		},
	],
	"app/library/content-registration.tsx": [
		{ write: "POST /api/library", controls: ["library.content.register"] },
	],
	"app/library/source-panel.tsx": [
		{
			write: "POST /api/library/sources/x/retry",
			controls: ["library.source.retry"],
		},
	],
	"app/live/[id]/alert-panel.tsx": [
		{
			write: "PATCH /api/live-channels/x/alerts/x",
			controls: ["live.channel.alerts"],
		},
		{ write: "POST /api/alert-rules", controls: ["live.channel.alerts"] },
	],
	"app/live/[id]/auto-shutdown-panel.tsx": [
		{
			write: "POST /api/live-channels/x/auto-shutdown",
			controls: ["live.channel.auto-shutdown"],
		},
	],
	"app/live/[id]/capture-vmaf-panel.tsx": [
		{
			write: "POST /api/live-channels/x/capture-vmaf",
			controls: ["live.channel.vmaf"],
		},
	],
	"app/live/[id]/channel-actions.tsx": [
		{
			write: "POST /api/live-channels/x/actions",
			controls: ["live.channel.rtmp-ingest"],
		},
		{
			write: "POST /api/live-channels/x/actions",
			controls: ["live.channel.lifecycle"],
		},
		{
			// cancel-start is independent of the pending Start mutation.
			write: "POST /api/live-channels/x/actions",
			controls: ["live.channel.lifecycle"],
		},
		{
			write: "POST /api/live-channels/x/actions",
			controls: ["live.channel.cue"],
		},
		{ write: "DELETE /api/live-channels/x", controls: ["live.channel.delete"] },
	],
	"app/live/[id]/content-insertion-panel.tsx": [
		{
			write: "POST /api/live-channels/x/insertable-content/schedule",
			controls: ["live.channel.content-insertion"],
		},
	],
	"app/live/[id]/slate-register-form.tsx": [
		{
			write: "POST /api/live-channels/x/insertable-content",
			controls: ["live.channel.content-insertion"],
		},
		{
			// The compatibility check creates nothing at the provider, but it
			// starts a bounded read of customer storage — an OPERATOR write.
			write: "POST /api/live-channels/x/insertable-content/preflight",
			controls: ["live.channel.content-insertion"],
		},
	],
	"app/live/[id]/dvr-panel.tsx": [
		{
			write: "POST /api/live-channels/x/actions",
			controls: ["live.channel.dvr-reset"],
		},
	],
	"app/live/[id]/esam-panel.tsx": [
		{
			write: "POST /api/live-channels/x/esam-media-point",
			controls: ["live.channel.esam"],
		},
	],
	"app/live/[id]/feeder-panel.tsx": [
		{ write: "POST /api/feeder-sessions", controls: ["live.channel.feeder"] },
		{
			write: "POST /api/feeder-sessions/x/actions",
			controls: ["live.channel.feeder"],
		},
	],
	"app/live/[id]/live-to-vod-panel.tsx": [
		{
			write: "POST /api/live-channels/x/live-to-vod",
			controls: ["live.channel.live-to-vod"],
		},
	],
	"app/live/[id]/runtime-cap-panel.tsx": [
		{
			write: "PATCH /api/live-channels/x",
			controls: ["live.channel.runtime-cap"],
		},
	],
	"app/live/[id]/schedule-panel.tsx": [
		{
			write: "POST /api/live-channels/x/schedules",
			controls: ["live.channel.schedule"],
		},
		{
			write: "DELETE /api/live-channels/x/schedules/x",
			controls: ["live.channel.schedule"],
		},
	],
	"app/live/[id]/insertion-stop-panel.tsx": [
		{
			write: "POST /api/live-channels/x/insertable-content/stop",
			controls: ["live.channel.inserted-content-stop"],
		},
	],
	"app/live/[id]/slate-reservations-panel.tsx": [
		{
			write: "DELETE /api/live-channels/x/insertable-content/schedule/x",
			controls: ["live.channel.slate"],
		},
	],
	"app/live/channels-client.tsx": [
		{
			write: "DELETE /api/live-channels/x",
			controls: ["live.channels.delete"],
		},
	],
	"app/live/feeders/[id]/feeder-detail.tsx": [
		{
			write: "POST /api/feeder-sessions/x/actions",
			controls: ["live.feeder.detail"],
		},
		{
			write: "DELETE /api/feeder-sessions/x",
			controls: ["live.feeder.detail"],
		},
	],
	"app/live/feeders/feeders-client.tsx": [
		{ write: "DELETE /api/feeder-sessions/x", controls: ["live.feeders.list"] },
	],
	"app/presets/delivery-gallery.tsx": [
		{ write: "POST /api/presets", controls: ["presets.delivery"] },
	],
	"app/presets/my-presets.tsx": [
		{ write: "DELETE /api/presets/x", controls: ["presets.user"] },
	],
	"app/qc/[id]/vmaf-report.tsx": [
		{ write: "DELETE /api/vmaf-jobs/x", controls: ["qc.report.delete"] },
		{ write: "POST /api/vmaf-jobs/x/cancel", controls: ["qc.jobs"] },
	],
	"app/qc/vmaf-lab-client.tsx": [
		{ write: "DELETE /api/vmaf-jobs/x", controls: ["qc.jobs"] },
		{ write: "POST /api/vmaf-jobs/bulk-delete", controls: ["qc.jobs"] },
		{ write: "POST /api/vmaf-jobs", controls: ["qc.jobs"] },
	],
	"app/settings/bitmovin/bitmovin-client.tsx": [
		{ write: "POST /api/bitmovin-accounts", controls: ["settings.bitmovin"] },
		{
			write: "PATCH /api/bitmovin-accounts/x",
			controls: ["settings.bitmovin"],
		},
		{
			write: "DELETE /api/bitmovin-accounts/x",
			controls: ["settings.bitmovin"],
		},
		{
			write: "POST /api/bitmovin-accounts/x/test",
			controls: ["settings.bitmovin"],
		},
	],
	"app/settings/credentials/credentials-client.tsx": [
		{ write: "POST /api/credentials", controls: ["settings.credentials"] },
		{ write: "PATCH /api/credentials/x", controls: ["settings.credentials"] },
		{ write: "DELETE /api/credentials/x", controls: ["settings.credentials"] },
	],
	"app/settings/features/features-client.tsx": [
		{ write: "PATCH /api/settings/features", controls: ["settings.features"] },
	],
	"app/settings/infrastructure/cloud-connect-panel.tsx": [
		{
			write: "POST /api/infrastructure/cloud-connect/x",
			controls: ["settings.infrastructure.cloud-connect"],
		},
		{
			write: "DELETE /api/infrastructure/cloud-connect/x/x",
			controls: ["settings.infrastructure.cloud-connect"],
		},
	],
	"app/settings/infrastructure/prewarmed-pools-panel.tsx": [
		{
			write: "POST /api/infrastructure/prewarmed-pools",
			controls: ["settings.infrastructure.prewarmed-pools"],
		},
		{
			write: "DELETE /api/infrastructure/prewarmed-pools/x",
			controls: ["settings.infrastructure.prewarmed-pools"],
		},
		{
			write: "POST /api/infrastructure/prewarmed-pools/x/actions",
			controls: ["settings.infrastructure.prewarmed-pools"],
		},
		{
			write: "POST /api/infrastructure/prewarmed-pools/x/schedules",
			controls: ["settings.infrastructure.prewarmed-pools"],
		},
		{
			write: "DELETE /api/infrastructure/prewarmed-pools/x/schedules/x",
			controls: ["settings.infrastructure.prewarmed-pools"],
		},
	],
	"app/settings/infrastructure/region-settings-editor.tsx": [
		{
			write: "POST /api/infrastructure/cloud-connect/x/x/regions",
			controls: ["settings.infrastructure.regions"],
		},
		{
			write: "DELETE /api/infrastructure/cloud-connect/x/x/regions/x",
			controls: ["settings.infrastructure.regions"],
		},
	],
	"app/settings/infrastructure/static-ips-panel.tsx": [
		{
			write: "POST /api/infrastructure/static-ips",
			controls: ["settings.infrastructure.static-ips"],
		},
		{
			write: "DELETE /api/infrastructure/static-ips/x",
			controls: ["settings.infrastructure.static-ips"],
		},
	],
	"app/settings/live/alerts-panel.tsx": [
		{ write: "POST /api/alert-rules", controls: ["settings.live.alerts"] },
		{ write: "PATCH /api/alert-rules/x", controls: ["settings.live.alerts"] },
		{ write: "DELETE /api/alert-rules/x", controls: ["settings.live.alerts"] },
	],
	"app/settings/live/dns-mappings-settings-panel.tsx": [
		{ write: "POST /api/live/dns-mappings", controls: ["settings.live.dns"] },
		{
			write: "DELETE /api/live/dns-mappings/x",
			controls: ["settings.live.dns"],
		},
	],
	"app/settings/live/standby-pools-panel.tsx": [
		{
			write: "POST /api/live/standby-pools",
			controls: ["settings.live.standby-pools"],
		},
		{
			write: "DELETE /api/live/standby-pools/x",
			controls: ["settings.live.standby-pools"],
		},
		{
			write: "POST /api/live/standby-pools/x/actions",
			controls: ["settings.live.standby-pools"],
		},
		{
			write: "DELETE /api/live/standby-pools/x/encodings/x",
			controls: ["settings.live.standby-pools"],
		},
	],
	"app/settings/live/startup-profiles-panel.tsx": [
		{
			write: "PUT /api/settings/startup-probes",
			controls: ["settings.live.startup-probes"],
		},
		{
			write: "POST /api/settings/startup-probes/run",
			controls: ["settings.live.startup-probes"],
		},
	],
	"app/settings/live/heartbeat-webhook-panel.tsx": [
		{
			write: "PUT /api/settings/live-heartbeat",
			controls: ["settings.live.heartbeat-webhook"],
		},
		{
			write: "DELETE /api/settings/live-heartbeat",
			controls: ["settings.live.heartbeat-webhook"],
		},
	],
	"app/settings/live/stream-keys-panel.tsx": [
		{
			write: "POST /api/live/stream-keys",
			controls: ["settings.live.stream-keys"],
		},
		{
			write: "DELETE /api/live/stream-keys/x",
			controls: ["settings.live.stream-keys"],
		},
		{
			write: "POST /api/live/stream-keys/unassign",
			controls: ["settings.live.stream-keys"],
		},
	],
	"app/settings/notifications/notifications-client.tsx": [
		{
			write: "POST /api/notifications/channels",
			controls: ["settings.notifications"],
		},
		{
			write: "PATCH /api/notifications/channels/x",
			controls: ["settings.notifications"],
		},
		{
			write: "DELETE /api/notifications/channels/x",
			controls: ["settings.notifications"],
		},
	],
	"app/settings/branding/branding-client.tsx": [
		{ write: "PATCH /api/settings/branding", controls: ["settings.branding"] },
	],
	"app/settings/player/player-client.tsx": [
		{ write: "PATCH /api/settings/player", controls: ["settings.player"] },
	],
	"app/settings/watch-folders/watch-folders-client.tsx": [
		{ write: "POST /api/watch-rules", controls: ["settings.watch-folders"] },
		{ write: "PATCH /api/watch-rules/x", controls: ["settings.watch-folders"] },
		{
			write: "DELETE /api/watch-rules/x",
			controls: ["settings.watch-folders"],
		},
		{
			write: "POST /api/watch-rules/x/re-arm",
			controls: ["settings.watch-folders"],
		},
	],
	"app/settings/webhooks/registration-panel.tsx": [
		// WP-G G-2: "re-register now" (a request the worker's registrar honours)
		// replaced the account-level standard-set POST.
		{
			write: "POST /api/webhook-registrations/reconcile",
			controls: ["settings.webhook-registration"],
		},
		{
			write: "DELETE /api/webhook-registration",
			controls: ["settings.webhook-registration"],
		},
	],
	"app/templates/launch-dialog.tsx": [
		{ write: "POST /api/encoding-jobs", controls: ["templates.manage"] },
	],
	"app/templates/live-launch-dialog.tsx": [
		{ write: "POST /api/live-channels", controls: ["templates.manage"] },
	],
	"app/templates/templates-client.tsx": [
		{ write: "DELETE /api/presets/x", controls: ["templates.manage"] },
	],
	"app/vod/jobs/[id]/job-detail.tsx": [
		{ write: "POST /api/vmaf-jobs/x/retry", controls: ["vod.job.detail"] },
		{ write: "POST /api/vmaf-jobs", controls: ["vod.job.detail"] },
		{
			write: "POST /api/encoding-jobs/x/re-run-as-new",
			controls: ["vod.job.detail"],
		},
		{ write: "POST /api/encoding-jobs/x/cancel", controls: ["vod.job.detail"] },
		{ write: "DELETE /api/encoding-jobs/x", controls: ["vod.job.detail"] },
	],
	"app/vod/jobs/[id]/per-title-results-panel.tsx": [
		{
			write: "POST /api/encoding-jobs/x/capture-per-title-results",
			controls: ["vod.job.per-title"],
		},
	],
	"app/vod/jobs/[id]/qc-gate-panel.tsx": [
		{
			write: "POST /api/encoding-jobs/x/qc-override",
			controls: ["vod.job.qc"],
		},
	],
	"app/vod/jobs/jobs-client.tsx": [
		{
			write: "POST /api/encoding-jobs/bulk-re-run",
			controls: ["vod.jobs.list"],
		},
		{ write: "DELETE /api/encoding-jobs/x", controls: ["vod.jobs.list"] },
		{
			write: "POST /api/encoding-jobs/bulk-cancel",
			controls: ["vod.jobs.list"],
		},
		{
			write: "POST /api/encoding-jobs/bulk-delete",
			controls: ["vod.jobs.list"],
		},
	],
	"app/vod/new/drm-row-editor.tsx": [
		{ write: "POST /api/credentials", controls: ["vod.new.drm-credentials"] },
	],
	"components/save-as-template.tsx": [
		{
			write: "POST /api/presets",
			controls: [
				"live.channel.advanced",
				"vod.job.detail",
				"live.new.template",
			],
		},
	],
} as const satisfies Record<
	keyof typeof MUTATION_SOURCE_CENSUS,
	readonly MutationWriteFamily[]
>;

export function mutationControl(
	id: MutationControlId,
): MutationControlContract {
	return MUTATION_CONTROLS[id];
}
