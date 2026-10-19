export const FEATURE_IDS = [
	"vod",
	"live",
	"monitoring",
	"jobs",
	"dashboard",
	"quality",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
export type ScreenshotName =
	| "vod-settings"
	| "live-settings"
	| "live-monitoring"
	| "vod-job"
	| "dashboard"
	| "quality";

export type FeatureCopy = {
	title: string;
	paragraphs: string[];
	bullets?: string[];
	note?: string;
	link: string;
};

export type LandingCopy = {
	skip: string;
	navigation: {
		mainLabel: string;
		languageLabel: string;
		features: string;
		guide: string;
		demo: string;
		tourLabel: string;
		tour: Record<FeatureId, string>;
	};
	hero: {
		title: string;
		intro: string;
		demo: string;
		install: string;
		note: string;
	};
	imageLinks: { open: string; fullSize: string; newTab: string };
	screenshots: Record<ScreenshotName, { alt: string; caption: string }>;
	features: Record<FeatureId, FeatureCopy>;
	more: {
		title: string;
		columns: { title: string; body: string }[];
		link: string;
	};
	demo: { title: string; body: string; link: string };
	run: {
		title: string;
		paragraphs: string[];
		install: string;
		coverage: string;
		requirements: string;
		requirementsBody: string;
	};
	footer: {
		license: string;
		navigationLabel: string;
		source: string;
		guide: string;
		issues: string;
	};
};

export const enCopy: LandingCopy = {
	skip: "Skip to content",
	navigation: {
		mainLabel: "Main navigation",
		languageLabel: "Language",
		features: "Features",
		guide: "User guide",
		demo: "Open demo",
		tourLabel: "Feature tour",
		tour: {
			vod: "VOD settings",
			live: "Live settings",
			monitoring: "Live monitoring",
			jobs: "Job details",
			dashboard: "Usage dashboard",
			quality: "Video quality",
		},
	},
	hero: {
		title: "Configure VOD and Live encoding in your browser.",
		intro:
			"bitovp is a self-hosted graphical application for the Bitmovin Encoding API. Build encoding ladders, configure codec parameters, and follow jobs and live broadcasts from the same interface.",
		demo: "Explore the demo",
		install: "Install bitovp",
		note: "No account is needed for the demo. It uses sample data and simulates actions without starting cloud encodings.",
	},
	imageLinks: {
		open: "Open full-size screenshot in a new tab",
		fullSize: "Open full size",
		newTab: " in a new tab",
	},
	screenshots: {
		"vod-settings": {
			alt: "bitovp VOD encoding form with rendition and codec settings",
			caption:
				"The VOD configuration interface, shown with sample settings. Each rendition has its own video or audio controls.",
		},
		"live-settings": {
			alt: "bitovp Live channel form with input and broadcast configuration",
			caption:
				"Live has its own configuration flow for input, encodes, destinations, output groups, run safety, and schedule actions. Sample settings are shown.",
		},
		"live-monitoring": {
			alt: "bitovp Live channel view with delivery observations and heartbeat monitoring",
			caption:
				"An example channel with simulated status and heartbeat data. The demo is not monitoring a real broadcast.",
		},
		"vod-job": {
			alt: "bitovp VOD job detail with an example encoding and its step history",
			caption:
				"A sample job detail view. Demo jobs illustrate the interface and do not represent cloud encoding runs.",
		},
		dashboard: {
			alt: "bitovp usage dashboard with sample VOD and Live statistics",
			caption:
				"The dashboard uses illustrative sample usage. These figures are not measurements of this project or estimates of your costs.",
		},
		quality: {
			alt: "bitovp quality report with rendition summaries and frame score graphs",
			caption:
				"An illustrative quality report with sample scores. It demonstrates report navigation, not measured encoding performance.",
		},
	},
	features: {
		vod: {
			title: "Build the encoding plan, from source to delivery.",
			paragraphs: [
				"Configure video on demand (VOD): stored files encoded for later playback. Choose source tracks, then define the codecs, resolutions, and bitrates of your output renditions. Together, those renditions form an encoding ladder.",
				"The wizard separates source selection, codec settings, packaging, and delivery manifests. Use a fixed ladder or Per-Title encoding, which selects renditions based on the content. Inspect the complete plan before starting work.",
			],
			bullets: [
				"Video, audio, subtitles, filters, and advanced codec controls.",
				"HLS and DASH streaming formats, with configurable packaging.",
				"Saved configurations, samples, and plan JSON import.",
			],
			link: "Try the VOD form",
		},
		live: {
			title: "Configure the input, encodes, and outputs for Live.",
			paragraphs: [
				"Choose RTMP, redundant RTMP, SRT, Zixi, or HLS pull input. Configure video and audio renditions, output destinations, and HLS or DASH manifests. RTMP and SRT receive an incoming stream; HLS pull reads an existing playlist.",
				"Review the playback window, optional recording, maximum run time, and scheduled actions before creating a channel. The form identifies settings that fall outside the supported Live HD configuration. Account eligibility and provider acceptance still apply.",
			],
			note: "In the installed application, creating a Live channel immediately begins provisioning and can incur charges. The demo simulates this action.",
			link: "Try the Live form",
		},
		monitoring: {
			title: "Read live status with the observations behind it.",
			paragraphs: [
				"Inspect encoder state, input connection, HLS output progress, and playback as separate observations. A running encoder alone does not confirm that input is connected or that viewers can play its output.",
				"Heartbeat samples are periodic reports about the live input. The channel view shows their freshness, history, receive rates, and events. Signed push reports are preferred when fresh; provider polling supplies a fallback. Missing monitoring data is shown separately from an input disconnect.",
				"Broadcast history keeps each run distinct. Schedules can dispatch start, stop, and slate insertion actions. A slate is a still image or video inserted into the broadcast.",
			],
			link: "Read the Live guide",
		},
		jobs: {
			title: "Follow a job through its steps and available outputs.",
			paragraphs: [
				"Open a VOD job to inspect its progress, step history, encoding plan, provider resources, and available output references. When a step fails, its place in the sequence helps explain where to investigate.",
				"Copy settings back into the wizard to prepare another job. Review input and output paths before running it. The content library also collects metadata, available playback references, and imported scene analysis for completed content.",
			],
			note: "Encoding completion, media availability, and browser playback are separate checks. A stored output link does not establish that the remote media is still available.",
			link: "Browse the demo jobs",
		},
		dashboard: {
			title: "Keep VOD and Live usage in view.",
			paragraphs: [
				"The dashboard shows usage for the selected Bitmovin account, including encodings created outside bitovp. Choose a date range and inspect VOD and Live statistics separately.",
				"Missing dates are identified rather than treated as zero. Live HD Units and encoded billing minutes remain different measurements; the dashboard does not convert one into the other. Use job and channel details to investigate an individual run.",
			],
			link: "Explore the sample dashboard",
		},
		quality: {
			title: "Inspect video quality beyond an average score.",
			paragraphs: [
				"VMAF (Video Multi-Method Assessment Fusion) compares decoded output video with a reference source. bitovp calculates it with FFmpeg and libvmaf, separately from the Bitmovin Encoding API.",
				"Review rendition summaries, frame scores, and quality against bitrate. Compare compatible reports and export stored measurements. Source identity, alignment, model, and missing results remain part of the report so that scores can be read in context.",
				"Measurement can run locally or through an administrator-configured cloud profile. Live measurements require a known pseudo-live reference and matching output capture.",
			],
			link: "Read about quality measurement",
		},
	},
	more: {
		title: "Alongside encoding",
		columns: [
			{
				title: "Prepare and reuse",
				body: "Browse supported storage, save reusable configurations, and load delivery presets. Watch folders can submit new input files automatically. A pseudo-live feeder sends stored files to a Live encoder at real-time speed.",
			},
			{
				title: "Manage access and operation",
				body: "Use organizations and roles to separate access. Configure accounts, encrypted credentials, API tokens, notifications, and encoding infrastructure from the application. The interface supports English and Japanese.",
			},
		],
		link: "Read about library and administration",
	},
	demo: {
		title: "Try the interface without an account.",
		body: "Browse example jobs and channels, inspect sample monitoring data, and edit VOD and Live configurations. Demo actions change only demo data. They do not call the Bitmovin Encoding API or create cloud resources.",
		link: "Open the demo",
	},
	run: {
		title: "Run bitovp with your own accounts.",
		paragraphs: [
			"The full application runs on your infrastructure. Encoding requires a Bitmovin account and configured input and output access. Starting an encoding or creating a Live channel can incur provider charges.",
			"Broad Encoding API coverage is the goal; complete coverage is not claimed. Available controls and accepted settings depend on the application, your account, and the encoder version.",
		],
		install: "Read the installation guide",
		coverage: "Supported features and limits",
		requirements: "Installation requirements",
		requirementsBody:
			"Use Docker with Docker Compose 2.30.0 or newer. Initial database setup also requires Node.js 24 or newer and pnpm 11. The installation guide covers authentication, database setup, and startup. There are no default sign-in credentials.",
	},
	footer: {
		license: "bitovp is open source under the MIT license.",
		navigationLabel: "Footer navigation",
		source: "Source code",
		guide: "User guide",
		issues: "Report an issue",
	},
};
