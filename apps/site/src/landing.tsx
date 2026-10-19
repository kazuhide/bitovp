import type { ReactNode } from "react";
import { SITE_BASE } from "./site-config";

const repository = "https://github.com/kazuhide/bitovp";
const guide = `${repository}/blob/main/docs/USER-GUIDE.md`;
const userGuide = `${repository}/blob/main/docs/user-guide`;

function Screenshot({
	file,
	alt,
	children,
	priority = false,
}: {
	file: string;
	alt: string;
	children: ReactNode;
	priority?: boolean;
}) {
	const src = `${SITE_BASE}screenshots/${file}.png`;
	return (
		<figure
			className={
				priority
					? "landing-screenshot landing-hero-screenshot"
					: "landing-screenshot"
			}
		>
			<a
				href={src}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={`Open full-size screenshot in a new tab: ${alt}`}
			>
				<img
					src={src}
					alt={alt}
					width="1680"
					height="1120"
					loading={priority ? "eager" : "lazy"}
					fetchPriority={priority ? "high" : "auto"}
					decoding="async"
				/>
			</a>
			<figcaption>
				<span>{children}</span>
				<a href={src} target="_blank" rel="noopener noreferrer">
					Open full size<span className="landing-sr-only"> in a new tab</span>
				</a>
			</figcaption>
		</figure>
	);
}

function FeatureTour({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="landing-tour" aria-labelledby={id}>
			<div className="landing-tour-heading">
				<h2 id={id} tabIndex={-1}>
					{title}
				</h2>
				<div className="landing-tour-copy">{children}</div>
			</div>
		</section>
	);
}

export function LandingPage() {
	return (
		<div className="site-landing">
			<a className="landing-skip" href="#landing-main">
				Skip to content
			</a>
			<header className="landing-header">
				<div className="landing-container landing-header-inner">
					<a className="landing-brand" href={SITE_BASE}>
						Bitovp
					</a>
					<nav aria-label="Main navigation" className="landing-header-nav">
						<a href="#vod">Features</a>
						<a href={guide}>User guide</a>
						<a href={repository}>GitHub</a>
						<a className="landing-button landing-button-small" href="#/demo">
							Open demo
						</a>
					</nav>
				</div>
			</header>

			<main id="landing-main" tabIndex={-1} className="landing-container">
				<div className="landing-intro">
					<h1>Configure VOD and Live encoding in your browser.</h1>
					<p className="landing-lead">
						Bitovp is a self-hosted graphical application for the Bitmovin
						Encoding API. Build encoding ladders, configure codec parameters,
						and follow jobs and live broadcasts from the same interface.
					</p>
					<div className="landing-actions">
						<a className="landing-button" href="#/demo">
							Explore the demo
						</a>
						<a
							className="landing-text-link"
							href={`${userGuide}/INSTALLATION.md`}
						>
							Install Bitovp
						</a>
					</div>
					<p className="landing-intro-note">
						No account is needed for the demo. It uses sample data and simulates
						actions without starting cloud encodings.
					</p>
				</div>

				<Screenshot
					file="vod-settings"
					alt="Bitovp VOD encoding form with rendition and codec settings"
					priority
				>
					The VOD configuration interface, shown with sample settings. Each
					rendition has its own video or audio controls.
				</Screenshot>

				<nav aria-label="Feature tour" className="landing-tour-nav">
					<a href="#vod">VOD settings</a>
					<a href="#live">Live settings</a>
					<a href="#monitoring">Live monitoring</a>
					<a href="#jobs">Job details</a>
					<a href="#dashboard">Usage dashboard</a>
					<a href="#quality">Video quality</a>
				</nav>

				<FeatureTour
					id="vod"
					title="Build the encoding plan, from source to delivery."
				>
					<p>
						Configure video on demand (VOD): stored files encoded for later
						playback. Choose source tracks, then define the codecs, resolutions,
						and bitrates of your output renditions. Together, those renditions
						form an encoding ladder.
					</p>
					<p>
						The wizard separates source selection, codec settings, packaging,
						and delivery manifests. Use a fixed ladder or Per-Title encoding,
						which selects renditions based on the content. Inspect the complete
						plan before starting work.
					</p>
					<ul>
						<li>
							Video, audio, subtitles, filters, and advanced codec controls.
						</li>
						<li>
							HLS and DASH streaming formats, with configurable packaging.
						</li>
						<li>Saved configurations, samples, and plan JSON import.</li>
					</ul>
					<a className="landing-text-link" href="#/demo/vod/new">
						Try the VOD form
					</a>
				</FeatureTour>
				<FeatureTour
					id="live"
					title="Configure the input, encodes, and outputs for Live."
				>
					<p>
						Choose RTMP, redundant RTMP, SRT, Zixi, or HLS pull input. Configure
						video and audio renditions, output destinations, and HLS or DASH
						manifests. RTMP and SRT receive an incoming stream; HLS pull reads
						an existing playlist.
					</p>
					<p>
						Review the playback window, optional recording, maximum run time,
						and scheduled actions before creating a channel. The form identifies
						settings that fall outside the supported Live HD configuration.
						Account eligibility and provider acceptance still apply.
					</p>
					<p className="landing-context-note">
						In the installed application, creating a Live channel immediately
						begins provisioning and can incur charges. The demo simulates this
						action.
					</p>
					<a className="landing-text-link" href="#/demo/live/new">
						Try the Live form
					</a>
				</FeatureTour>
				<Screenshot
					file="live-settings"
					alt="Bitovp Live channel form with input and broadcast configuration"
				>
					Live has its own configuration flow for input, encodes, destinations,
					output groups, run safety, and schedule actions. Sample settings are
					shown.
				</Screenshot>

				<FeatureTour
					id="monitoring"
					title="Read live status with the observations behind it."
				>
					<p>
						Inspect encoder state, input connection, HLS output progress, and
						playback as separate observations. A running encoder alone does not
						confirm that input is connected or that viewers can play its output.
					</p>
					<p>
						Heartbeat samples are periodic reports about the live input. The
						channel view shows their freshness, history, receive rates, and
						events. Signed push reports are preferred when fresh; provider
						polling supplies a fallback. Missing monitoring data is shown
						separately from an input disconnect.
					</p>
					<p>
						Broadcast history keeps each run distinct. Schedules can dispatch
						start, stop, and slate insertion actions. A slate is a still image
						or video inserted into the broadcast.
					</p>
					<a className="landing-text-link" href={`${userGuide}/LIVE.md`}>
						Read the Live guide
					</a>
				</FeatureTour>
				<Screenshot
					file="live-monitoring"
					alt="Bitovp Live channel view with delivery observations and heartbeat monitoring"
				>
					An example channel with simulated status and heartbeat data. The demo
					is not monitoring a real broadcast.
				</Screenshot>

				<FeatureTour
					id="jobs"
					title="Follow a job through its steps and available outputs."
				>
					<p>
						Open a VOD job to inspect its progress, step history, encoding plan,
						provider resources, and available output references. When a step
						fails, its place in the sequence helps explain where to investigate.
					</p>
					<p>
						Copy settings back into the wizard to prepare another job. Review
						input and output paths before running it. The content library also
						collects metadata, available playback references, and imported scene
						analysis for completed content.
					</p>
					<p className="landing-context-note">
						Encoding completion, media availability, and browser playback are
						separate checks. A stored output link does not establish that the
						remote media is still available.
					</p>
					<a className="landing-text-link" href="#/demo/vod/jobs">
						Browse the demo jobs
					</a>
				</FeatureTour>
				<Screenshot
					file="vod-job"
					alt="Bitovp VOD job detail with an example encoding and its step history"
				>
					A sample job detail view. Demo jobs illustrate the interface and do
					not represent cloud encoding runs.
				</Screenshot>

				<FeatureTour id="dashboard" title="Keep VOD and Live usage in view.">
					<p>
						The dashboard shows usage for the selected Bitmovin account,
						including encodings created outside Bitovp. Choose a date range and
						inspect VOD and Live statistics separately.
					</p>
					<p>
						Missing dates are identified rather than treated as zero. Live HD
						Units and encoded billing minutes remain different measurements; the
						dashboard does not convert one into the other. Use job and channel
						details to investigate an individual run.
					</p>
					<a className="landing-text-link" href="#/demo">
						Explore the sample dashboard
					</a>
				</FeatureTour>
				<Screenshot
					file="dashboard"
					alt="Bitovp usage dashboard with sample VOD and Live statistics"
				>
					The dashboard uses illustrative sample usage. These figures are not
					measurements of this project or estimates of your costs.
				</Screenshot>

				<FeatureTour
					id="quality"
					title="Inspect video quality beyond an average score."
				>
					<p>
						VMAF (Video Multi-Method Assessment Fusion) compares decoded output
						video with a reference source. Bitovp calculates it with FFmpeg and
						libvmaf, separately from the Bitmovin Encoding API.
					</p>
					<p>
						Review rendition summaries, frame scores, and quality against
						bitrate. Compare compatible reports and export stored measurements.
						Source identity, alignment, model, and missing results remain part
						of the report so that scores can be read in context.
					</p>
					<p>
						Measurement can run locally or through an administrator-configured
						cloud profile. Live measurements require a known pseudo-live
						reference and matching output capture.
					</p>
					<a
						className="landing-text-link"
						href={`${userGuide}/QUALITY-AND-MONITORING.md`}
					>
						Read about quality measurement
					</a>
				</FeatureTour>
				<Screenshot
					file="quality"
					alt="Bitovp quality report with rendition summaries and frame score graphs"
				>
					An illustrative quality report with sample scores. It demonstrates
					report navigation, not measured encoding performance.
				</Screenshot>

				<section className="landing-more" aria-labelledby="more-features">
					<h2 id="more-features">Alongside encoding</h2>
					<div className="landing-more-columns">
						<div>
							<h3>Prepare and reuse</h3>
							<p>
								Browse supported storage, save reusable configurations, and load
								delivery presets. Watch folders can submit new input files
								automatically. A pseudo-live feeder sends stored files to a Live
								encoder at real-time speed.
							</p>
						</div>
						<div>
							<h3>Manage access and operation</h3>
							<p>
								Use organizations and roles to separate access. Configure
								accounts, encrypted credentials, API tokens, notifications, and
								encoding infrastructure from the application. The interface
								supports English and Japanese.
							</p>
						</div>
					</div>
					<a
						className="landing-text-link"
						href={`${userGuide}/LIBRARY-AND-ADMIN.md`}
					>
						Read about library and administration
					</a>
				</section>

				<section className="landing-demo-note" aria-labelledby="demo-scope">
					<div>
						<h2 id="demo-scope">Try the interface without an account.</h2>
						<p>
							Browse example jobs and channels, inspect sample monitoring data,
							and edit VOD and Live configurations. Demo actions change only
							demo data. They do not call the Bitmovin Encoding API or create
							cloud resources.
						</p>
					</div>
					<a className="landing-button" href="#/demo">
						Open the demo
					</a>
				</section>

				<section className="landing-run" aria-labelledby="run-bitovp">
					<h2 id="run-bitovp">Run Bitovp with your own accounts.</h2>
					<p>
						The full application runs on your infrastructure. Encoding requires
						a Bitmovin account and configured input and output access. Starting
						an encoding or creating a Live channel can incur provider charges.
					</p>
					<p>
						Broad Encoding API coverage is the goal; complete coverage is not
						claimed. Available controls and accepted settings depend on the
						application, your account, and the encoder version.
					</p>
					<div className="landing-actions">
						<a className="landing-button" href={`${userGuide}/INSTALLATION.md`}>
							Read the installation guide
						</a>
						<a
							className="landing-text-link"
							href={`${repository}/blob/main/docs/BITMOVIN-API-COVERAGE.md`}
						>
							Supported features and limits
						</a>
					</div>
					<details>
						<summary>Installation requirements</summary>
						<p>
							Use Docker with Docker Compose 2.30.0 or newer. Initial database
							setup also requires Node.js 24 or newer and pnpm 11. The
							installation guide covers authentication, database setup, and
							startup. There are no default sign-in credentials.
						</p>
					</details>
				</section>
			</main>

			<footer className="landing-footer">
				<div className="landing-container landing-footer-inner">
					<p>Bitovp is open source under the MIT license.</p>
					<nav aria-label="Footer navigation">
						<a href={repository}>Source code</a>
						<a href={guide}>User guide</a>
						<a href={`${repository}/issues`}>Report an issue</a>
					</nav>
				</div>
			</footer>
		</div>
	);
}
