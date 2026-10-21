/**
 * The English catalogue — the source of truth for BOTH locales' shape.
 *
 * `as const` is here for `MessageKey`, which needs the literal key names to build
 * dotted paths. It is NOT what makes `ja.ts` safe, and the first version of this
 * comment claimed it was: with literal LEAF types, `ja satisfies Messages` demands
 * every Japanese string equal its English original, so the check that was supposed
 * to force translation forbade it — 40 typecheck errors, each one a correct
 * translation. `Messages` therefore widens the leaves to `string` (see `Widen`)
 * and keeps the key structure, so a missing key still fails and a translated value
 * passes.
 *
 * The point of failing at typecheck rather than falling back to English at runtime:
 * an untranslated string that renders fine is one nobody notices, which is how
 * "i18n support" ships as a permanently half-English UI.
 *
 * Interpolation is `{name}`. There is no plural machinery: every count-bearing
 * string here reads naturally with a numeral in both languages (Japanese has no
 * grammatical plural), and inventing an ICU dependency for a case that does not
 * arise would be cost without a payer. If a genuine plural appears, add the
 * plural forms as separate keys and pick between them at the call site — the
 * types will force both locales to define them.
 */
// Share the provisioning and billing clause so every lifecycle hint stays consistent.
// No trailing punctuation: each call site continues the sentence its own way.
const PROVISIONS_AT_CREATE =
	"The channel begins starting up as soon as it is created, and charges may accrue before the planned feed time, depending on your Live Encoding pricing plan";

export const en = {
	liveOutputs: {
		destination: "Output destination",
		access: "Access permissions",
		addMirror: "Add storage mirror",
		removeMirror: "Remove storage mirror",
		mirrorNumber: "Storage mirror {number}",
		addHls: "Add HLS manifest",
		addDash: "Add DASH manifest",
		removeHls: "Remove HLS manifest",
		removeDash: "Remove DASH manifest",
		manifestNumber: "{kind} {number}",
		manifestSettings: "{kind} manifest settings",
		destinationHelp:
			"Choose a destination configured in step 4 that also receives the video and audio data.",
		path: "Output path",
		pathHelp:
			"Folder within the selected destination where the manifest file is written.",
		referenced:
			"Change or remove the archive or manifest destination before removing this storage mirror.",
	},
	creationSubmission: {
		responseUnavailable:
			"The creation response was incomplete. Retry without changing the form to recover the same job or channel.",
		sessionUnavailable:
			"Your session could not be confirmed. Reload this page before creating a job or channel.",
		storageUnavailable:
			"This browser could not save a safe retry receipt. Enable session storage and retry. No new request was sent.",
		pendingLimit:
			"This tab has too many unconfirmed creation requests. Retry an existing request or check the job and channel lists before starting another.",
	},
	branding: {
		title: "App name and icon",
		scope:
			"Customize the navigation name and icon for all users in this organization. Changes apply after saving.",
		name: "App name",
		nameHint: "Enter 1–64 characters.",
		icon: "App icon",
		iconHint: "Static PNG, JPEG or WebP, up to 256 KiB and 1024 × 1024 pixels.",
		preview: "Preview",
		removeIcon: "Remove icon",
		reset: "Restore defaults",
		loadFailed: "Could not load the app name and icon. Retry before editing.",
		saveFailed: "Could not save. Your changes are retained; try Save again.",
		saved: "Saved. Navigation has been updated.",
		iconInvalid:
			"Could not read this image. Choose a static PNG, JPEG or WebP up to 256 KiB and 1024 × 1024 pixels.",
		readOnly: "Only administrators can change the app name and icon.",
	},
	tenant: {
		organization: "Organization",
		organizations: "Organizations",
		accessAudit: "Access history",
		accessCaption: "Access history and client IP policy",
		organizationsCaption: "Organizations and member dashboards",
		name: "Name",
		slug: "ID",
		create: "Create organization",
		save: "Save",
		saved: "Saved",
		current: "Current organization",
		ipPolicy: "Allowed client IPs",
		ipHelp:
			"One IP or CIDR per line. Empty allows all clients. Applies to every organization member, including administrators. The platform owner can recover the policy.",
		ipPlaceholder: "203.0.113.10\n2001:db8::/32",
		noHistory: "No access records",
		historyHelp:
			"Page visits and API changes; background reads are omitted. Administrator and view-as access is never recorded. Decision indicates the access check, not the final operation result.",
		who: "Who",
		when: "When",
		path: "Page / API",
		ip: "Client IP",
		decision: "Access decision",
		allowed: "Allowed",
		denied: "Denied",
		more: "Load more",
		viewAs: "View dashboard as ",
		viewingAs: "Viewing {name} · {organization}",
		readOnly: "Read only",
		exitViewAs: "Exit view-as",
		member: "Member",
		password: "Your password",
		view: "Open dashboard",
		noMembers: "No active members",
		active: "Active",
		ownerOnly: "Available to the platform owner",
		usersRequired: "User accounts are required",
		loading: "Loading…",
	},
	ladder: {
		videoCopySource: "Video settings to reuse",
		audioCopySource: "Audio settings to reuse",
		defaultSettings: "Default settings",
		copyHelp:
			"Reuse a rendition’s settings, or choose Default settings to start fresh.",
	},
	theme: {
		label: "Appearance",
		neon: "Neon · Dark",
		slate: "Slate · Dark",
		paper: "Paper · Light",
		dimmed: "Dimmed · Dark",
		"solarized-dark": "Solarized · Dark",
		"solarized-light": "Solarized · Light",
		"high-contrast": "High contrast · Dark",
		system: "Follow system",
		hint: "Saved in this browser.",
	},
	shell: {
		skipToContent: "Skip to content",
	},
	autoShutdownUpdate: {
		title: "Encoder automatic stop",
		inputLoss: "No input received (seconds)",
		runtime: "Stop after update (minutes)",
		firstInput: "Wait for first input (minutes)",
		disabled: "Disabled",
		emptyDisabled: "Leave blank to disable this timer.",
		recordedHint:
			"These are the last settings recorded for this broadcast. Changes made elsewhere may differ. Updating replaces all three timers; it does not change the next broadcast's saved start settings.",
		timingHint:
			"The runtime timer starts again when the encoder accepts the update. The input-loss timer counts from the last received data. Waiting for first input has no effect after input connects.",
		limitHint:
			"Your organization's maximum live runtime still applies. The encoder can refuse an update when a shutdown timer is within 10 seconds of firing.",
		replaceHint:
			"Review all three timers. Any blank timer will be disabled; leaving all three blank disables all automatic stop timers on the encoder.",
		review: "Review settings",
		reviewDelivery: "Review and retry",
		unrecorded:
			"No delivery record was found for this update. Review the proposed settings before trying again.",
		reviewTitle: "Replace automatic stop settings",
		apply: "Apply to this broadcast",
		disarmAll: "Disable all three timers",
		invalid:
			"Use whole numbers: at least 30 seconds for input loss and at least 5 minutes for each other timer. Leave a field blank to disable it.",
		queued:
			"Update queued. Acceptance by the encoder has not been confirmed yet. Reload the status if it stays pending.",
		applied: "The encoder accepted this update.",
		unknown:
			"The outcome of this update needs to be resolved. Do not resend it; the runtime timer could start again. Stop remains available.",
		resolved:
			"The previous operation was resolved. Review all settings before applying another update.",
		failed:
			"The update was not confirmed. Reload the status before trying again.",
		unavailable:
			"Recorded automatic stop settings could not be read. Reload before preparing an update.",
		loadFailed: "Could not load automatic stop settings.",
		reload: "Reload settings and status",
		scheduled:
			"Encoder's scheduled shutdown: {at}. Input loss may stop it earlier.",
	},
	rtmpUpdate: {
		title: "RTMP ingest points",
		apply: "Apply selected points",
		hint: "After applying the selected ingest points, reconnect your sender if needed and check the input status.",
		queued: "Update queued",
		failed: "Could not queue the RTMP update",
	},
	providerDiagnostics: {
		title: "Provider diagnostics",
		view: "View",
		summary: "Status",
		events: "Events",
		streams: "Streams",
		srt: "SRT statistics",
		"hd-start": "HD start request",
		hdStartHint:
			"Shows this run's provider start settings with stream keys, URLs and credentials omitted.",
		refresh: "Refresh",
		fetched: "Fetched {time}",
		srtInput: "SRT input",
		allInputs: "All inputs",
		inputId: "Input ID",
		apply: "Apply",
		invalidId: "Enter a valid SRT input UUID.",
		unavailable: "Could not fetch provider diagnostics. Try refreshing.",
		previous: "Previous",
		next: "Next",
		page: "Page {page}",
		total: "{count} entries",
		getFinal: "Get final heartbeat",
		downloadFinal: "Download final heartbeat",
		status: "Provider status",
		empty: "No provider data is available for this selection.",
		received: "Receive rate",
		lost: "Lost packets",
		dropped: "Dropped packets",
		retransmitted: "Retransmitted packets",
		details: "Response details",
	},
	audioMix: {
		twoSources: "Add two audio tracks in Sources before combining mono tracks.",
		title: "Audio channel mix",
		preset: "Start from a preset",
		swap: "Swap left / right",
		mono: "Two mono tracks → stereo",
		downmix: "5.1 → stereo (LFE omitted)",
		custom: "Custom mapping",
		layout: "Mix channel layout",
		output: "Output channel",
		source: "Source audio",
		channel: "Source channel",
		gain: "Gain",
		number: "Channel number (zero-based)",
		add: "Add output channel",
		addSource: "Add source channel",
		remove: "Remove channel",
		disable: "Remove mix from this rendition",
		unset: "Default (not sent)",
		unknown: "Missing source",
		hint: "Define each output channel once. Use only names or only numbers for source channels. Combine channels within an output row. Gain is linear (1 = unchanged); check the input layout.",
	},
	vmafSetup: {
		computeAuthHelp:
			"Select the saved credential allowed to submit and stop compute jobs. Application identity requires prior setup inside the application environment.",
		storageAuthHelp:
			"Select the saved credential allowed to read, write, delete and sign working-storage objects. It can be the same identity if both sets of permissions are granted.",
		step1: "Cloud & preparation",
		step2: "Connect prepared resources",
		step3: "Time & budget",
		next: "Next",
		back: "Back",
		saveHint:
			"Saving stores this profile only. Start a measurement separately in VMAF Lab.",
		preparation: "Prepare these resources first",
		preparationHint:
			"Follow the steps for the selected cloud, then copy the resulting values into the next screen. Resource creation and image storage can incur charges. Nothing is created by this form.",
		exampleHint:
			"Values shown below are examples, not resources in your account. Replace project/account IDs, names and image digests with your own.",
		officialInstructions: "Open provider instructions",
		credentialsLink: "Register credentials in another tab",
		identityHelp:
			"Use application identity only when credentials/roles are configured inside the running application. A login in your Mac terminal is not automatically available inside Docker. Otherwise register a cloud credential here first, then select it in both fields as appropriate.",
		buildTitle: "How to prepare the VMAF image",
		buildHelp:
			"Build from this repository’s root. Replace <REGISTRY_PATH> with your ECR or other repository URI. Push the base image first, copy its 64-character digest as <BASE_DIGEST>, then build and push the VMAF image. Use the final image’s digest in the form. These commands publish to your cloud registry and may incur storage charges. The example targets x86 nodes; match the architecture to your compute nodes.",
		awsImageTitle: "1. Create an ECR repository and publish the image",
		awsImageBody:
			"In Amazon ECR → Private repositories, create vmaf in the compute region. Build the VMAF image below, then use View push commands to upload it. Open the uploaded image and copy its repository URI and image digest. ECR stores the image; it does not run the measurement.",
		awsComputeTitle:
			"2. Prepare EC2 Batch capacity, a queue and a job definition",
		awsComputeBody:
			"In AWS Batch, create a managed EC2 environment with minimum vCPUs 0, bounded maximum capacity and instances that can pull from ECR. Provide a 500 GiB node disk for staged media; task CPU and memory are selected automatically. Attach a job queue. Create a classic containerProperties EC2 job definition using exactly the same digest image URI; copy its name with revision, such as vmaf:1. Fargate, EKS and ecsProperties definitions are not supported by this integration.",
		awsStorageTitle: "3. Create a private S3 working bucket",
		awsStorageBody:
			"Create an S3 bucket near the compute region. Copy the bucket name without s3://. Permit the application to upload, read and delete its working objects. Add lifecycle expiry as a fallback for abandoned data; input and result files use this bucket.",
		awsAuthTitle: "4. Give the application Batch and storage access",
		awsAuthBody:
			"The application needs Batch submit, describe, list and terminate permissions, and S3 access for the working bucket. Node roles separately need ECR pull access. Select saved AWS credentials or configure an IAM role for the application. Do not paste keys into the image URI.",
		gcpImageTitle: "1. Select a project and publish to Artifact Registry",
		gcpImageBody:
			"Enable billing and the Batch, Compute Engine, Artifact Registry and Cloud Logging APIs. In Artifact Registry, create a Docker repository named vmaf in the chosen region. Publish the VMAF image below and open its version details to copy the URI with its sha256 digest.",
		gcpComputeTitle: "2. Prepare the task service account and compute region",
		gcpComputeBody:
			"In IAM & Admin → Service Accounts, create a task account such as vmaf-task. Grant Batch Agent Reporter, Logs Writer and Artifact Registry Reader for the required project/repository. Choose a region with CPU quota; this integration currently uses the default VPC with outbound connectivity. The application selects the machine size and disk for each task. Batch creates the VM when a measurement starts; no queue ID is needed.",
		gcpStorageTitle: "3. Create a private Cloud Storage working bucket",
		gcpStorageBody:
			"Create a regional GCS bucket near the compute region and copy its globally unique name without gs://. The application’s storage identity needs object upload/read/delete and signed-URL capability. A service-account key can sign locally; keyless signing needs a suitable signing service account and signBlob permission.",
		gcpAuthTitle: "4. Register the application’s service account",
		gcpAuthBody:
			"The submitting identity needs Batch Job Editor and Service Account User on the task account. For a local Docker installation, register an allowed service-account JSON key using its client_email, private_key and project_id fields, or explicitly configure workload identity in Docker. The task service-account email in step 2 is a separate setting.",
		azureImageTitle: "1. Publish a compatible container image",
		azureImageBody:
			"Publish the VMAF image to Azure Container Registry or a registry your Batch pool can pull from. Record the immutable digest URI and configure registry access on the pool.",
		azureComputeTitle: "2. Prepare a Batch account and Linux pool template",
		azureComputeBody:
			"In the Azure portal, open the Batch account overview for its account endpoint. Prepare a Linux container pool as a template and copy its pool ID. The application automatically sizes a temporary pool for each measurement. The template itself is retained.",
		azureStorageTitle: "3. Create a Blob container",
		azureStorageBody:
			"Create a private container in a nearby storage account. Copy the Blob service endpoint and the container name separately. Configure object access and user-delegation signing permissions for the application identity.",
		azureAuthTitle: "4. Register a service principal",
		azureAuthBody:
			"Register tenant ID, client ID and client secret for an identity allowed to manage Batch tasks and access the working storage. Compute and storage credentials can be selected separately.",
		akamaiImageTitle: "1. Publish an image that the VM can pull publicly",
		akamaiImageBody:
			"This integration currently requires a publicly pullable digest-pinned VMAF image. Publish code only; never include credentials or customer media. Private-registry login is not configured by this form.",
		akamaiComputeTitle: "2. Choose a region and boot image",
		akamaiComputeBody:
			"Use Akamai’s region and image IDs from Cloud Manager/API, with a cloud-init-capable Linux image. The application selects a suitable dedicated instance automatically. The VM is created when measurement starts.",
		akamaiStorageTitle: "3. Prepare Object Storage and its endpoint",
		akamaiStorageBody:
			"Create a nearby Object Storage bucket. Copy its S3 endpoint, bucket name and region. Register Object Storage access keys as an AWS/S3 credential; these are different from the Akamai compute API token.",
		akamaiAuthTitle: "4. Keep an independent cleanup controller running",
		akamaiAuthBody:
			"Register the Akamai compute token and run the application’s cleanup controller independently of this Mac. Powering off a VM does not stop its charges; it must be deleted. Do not enable this profile while cleanup depends on a laptop staying awake.",
		labelHelp: "A name you will recognize in VMAF Lab.",
		idHelp:
			"Choose a unique ID using letters, digits and hyphens. It cannot change after saving.",
		regionHelp:
			"Copy the region code where your compute resources and quota are available. Keep working storage nearby.",
		imageHelp:
			"Copy the published image URI with @sha256: followed by all 64 digest characters. A local Docker tag or :latest is not sufficient.",
		queueHelp:
			"AWS Batch → Job queues → select your queue → copy its name or ARN.",
		definitionHelp:
			"AWS Batch → Job definitions → active revision. Use name:revision and the exact same image digest as above.",
		projectHelp:
			"Google Cloud project selector → Project ID, not the display name or numeric project number.",
		serviceAccountHelp:
			"IAM & Admin → Service Accounts → copy the task account email. This is the identity used by Batch VMs, not the application’s private key.",
		accountUrlHelp:
			"Azure portal → Batch account → Overview → copy the account endpoint.",
		poolHelp:
			"Batch account → Pools → copy the Linux container pool template ID.",
		bootHelp:
			"Use an available cloud-init-capable image ID from Akamai, not a Docker image URI.",
		bucketHelp:
			"Copy the bucket name only, without s3://, gs:// or a folder path.",
		containerHelp:
			"Storage account → Containers → copy the container name only.",
		endpointHelp:
			"For AWS S3 leave blank. For Akamai copy the bucket’s HTTPS S3 endpoint without a bucket path or keys.",
		blobHelp:
			"Storage account → Endpoints → Blob service URL, without the container path or SAS token.",
		runHelp:
			"Maximum task runtime. Too short a limit can stop a valid measurement.",
		queueTimeHelp: "Maximum time allowed for scheduling and startup.",
		hourlyHelp:
			"Enter a conservative per-task hourly ceiling from your cloud calculator, including node/pool overhead. No current price is prefilled.",
		costTransferHelp:
			"Include transfer directions and storage costs for your region. Enter 0 only when they are covered elsewhere or confirmed free.",
		overheadHelp:
			"Reserve an additional USD amount per task for requests, logs and other overhead.",
		stagingHelp:
			"Reject a task before submission if its staged input exceeds this size.",
	},
	vmafSettings: {
		title: "VMAF compute profiles",
		intro:
			"Save execution settings and credentials for reuse in VMAF Lab. Saving does not start cloud resources.",
		profiles: "Execution profiles",
		credentials: "Cloud compute credentials",
		addProfile: "Add profile",
		addCredential: "Add cloud credential",
		empty: "No saved profiles yet. Local execution remains available.",
		emptyCredentials:
			"No cloud credentials saved. Workload identity can be used without storing a key.",
		save: "Save",
		edit: "Edit",
		disable: "Disable",
		enabled: "Available for new measurements",
		disabled: "Disabled",
		version: "Version {version}",
		provider: "Cloud",
		label: "Name",
		id: "Profile ID",
		identity: "Use application identity",
		computeCredentialId: "Compute management credential",
		stagingCredentialId: "Working storage credential",
		secretHelp:
			"Keys are encrypted and never displayed again. To rotate a key, add a new credential and select it in the profile.",
		error:
			"Could not save or load the configuration. Check the fields and retry.",
		invalid:
			"Complete the required fields with valid values. Existing profiles also require the current version.",
		platform: "Compute environment",
		autoCompute:
			"Compute resources are selected automatically: SD uses 4 vCPU / 8 GiB, HD 8 vCPU / 32 GiB, and higher resolutions 16 vCPU / 64 GiB. Disk is sized for the media. Selected pairs determine cloud concurrency, subject to budget and provider capacity.",
		limits: "Time, storage and cost ceilings",
		storage: "Working storage",
		storageProvider: "Storage service",
		bucket: "Bucket",
		container: "Container",
		endpoint: "S3 endpoint (optional)",
		storageRegion: "Storage region",
		storageAccountUrl: "Blob service URL",
		region: "Compute region",
		image: "Container image (immutable digest)",
		timeoutSeconds: "Run timeout per attempt (seconds)",
		queueTimeoutSeconds: "Queue timeout per attempt (seconds)",
		maxCostUsdPerHour: "Hourly cost ceiling (USD)",
		transferUsdPerGiB: "Transfer ceiling (USD/GiB)",
		overheadUsd: "Other cost allowance per task (USD)",
		maxStagingGiB: "Maximum staged input (GiB)",
		jobQueue: "AWS Batch queue",
		jobDefinition: "AWS job definition (revision pinned)",
		project: "GCP project",
		serviceAccount: "Task service account",
		accountUrl: "Azure Batch account URL",
		poolId: "Azure pool ID",
		bootImage: "Akamai boot image",
		spot: "Use Spot capacity",
		spotFallback: "Keep Spot, then allow Standard fallback",
		spotMaxRetries: "Maximum Spot retries",
		spotDeadlineSeconds: "Overall Spot window (seconds)",
		spotPolicyHelp:
			"Retry interrupted pairs on Spot. Switch to Standard only after this deadline or retry limit. The total job budget still applies; the hourly ceiling must cover Standard pricing.",
		reaperEnabled: "An independent cleanup controller is running",
		accessKeyId: "Access key ID",
		secretAccessKey: "Secret access key",
		clientEmail: "Service account email",
		privateKey: "Private key",
		projectId: "Project ID (optional)",
		tenantId: "Tenant ID",
		clientId: "Client ID",
		clientSecret: "Client secret",
		token: "API token",
		costHelp:
			"Enter conservative ceilings for your region and contract, including startup, idle time and storage. These are admission limits, not a guaranteed final bill.",
	},
	library: {
		analysisAll: "All analysis fields",
		analysisProvider: "Original AISA analysis (secrets masked)",
		analysisNormalized: "Stored normalized analysis (original unavailable)",
		analysisEmptyString: "Empty string",
		analysisEmptyObject: "Empty object {}",
		analysisEmptyArray: "Empty array []",
		analysisMore: "Show next 50 items ({shown}/{total})",
		analysisFields: {
			metadata: "Analysis metadata",
			version: "Provider version",
			disclaimer: "Disclaimer",
			inputLanguageCodes: "Input languages",
			ratings: "Content ratings",
			rating: "Rating",
			region: "Region",
			system: "Rating system",
			credits: "Content credits",
			persons: "People",
			songs: "Songs",
			copyright: "Copyright",
			name: "Name",
			role: "Role",
			department: "Department",
			artist: "Artist",
			scenes: "Scenes",
			content: "Scene content",
			characters: "Characters",
			characterAppearance: "Character appearance",
			approximateAge: "Approximate age",
			playedBy: "Played by",
			shots: "Shots",
			mainSubjects: "Subjects",
			box2d: "Bounding box",
			centerX: "Center X (%)",
			centerY: "Center Y (%)",
			appearanceTimeInSeconds: "Appearance time within shot (seconds)",
			startInSeconds: "Start time (seconds)",
			endInSeconds: "End time (seconds)",
			duration: "Duration (seconds)",
			title: "Title",
			description: "Description",
			summary: "Summary",
			verboseSummary: "Detailed summary",
			detailedDescription: "Detailed description",
			keywords: "Keywords",
			sensitiveTopics: "Sensitive topics",
			iabSensitiveTopicTaxonomies: "IAB sensitive topics",
			iab: "IAB classification",
			adOpportunityInformation: "Ad opportunity",
			score: "Score",
			reason: "Reason",
			shotAdvisories: "Shot advisories",
		},
		contentCredits: "Content credits",
		creditPersons: "People (cast and crew)",
		creditRole: "Role",
		creditDepartment: "Department",
		creditSongs: "Songs",
		creditArtist: "Artist",
		creditCopyright: "Copyright",

		contentTab: "Content",
		scenesTab: "Scenes",
		gridView: "Grid view",
		listView: "List view",
		sceneSearch: "Search scenes",
		sceneSearchHint: "Enter keywords to find scenes.",
		sceneSearchEmpty: "No scenes match this search.",
		sceneMatch: "Match",
		sceneMatchAll: "All words",
		sceneMatchAny: "Any word",
		sceneMatchHelp:
			"Separate words with spaces. Match all words or at least one across the scene title, keywords, summary and shot descriptions.",
		sceneSort: "Sort",
		sceneSortRelevance: "Relevance",
		sceneSortRecent: "Recently updated",
		sceneSortHelp:
			"The 0–100 relevance score compares results within the same search. Matching word count comes first, then weights for titles, keywords, summaries and shot descriptions. It is not a probability or AI confidence. Recently updated uses the content update time.",
		sceneRelevance: "Relevance {score}/100",
		sceneLanguage: "Analysis language",
		sceneLanguageAll: "All languages",
		sceneLanguageHelp:
			"Search saved scene analyses in the selected language. This does not translate the search words.",
		sceneLanguagesLoading: "Loading languages…",
		sceneLanguagesFailed: "Could not load analysis languages.",
		sceneLanguagesRetry: "Retry languages",
		thumbnailLoading: "Loading thumbnail…",
		thumbnailFileMissing: "MP4 file missing",
		updating: "Updating…",
		sceneLinkChanged:
			"This scene link no longer matches the saved content. Select a scene again.",
		sceneNavigationHelp:
			"Select a scene to view its details and seek the video. Without playback, selection changes the details only.",
		scenePage: "Page {page} of {pages} · {count} scenes",
		noSceneMatches: "No scenes match this search.",
		filterAll: "All",
		filterPlayback: "Playback metadata",
		filterMetadataOnly: "No playback metadata",
		playbackHelp:
			"HLS, DASH or MP4 metadata is present; availability is checked when playback starts.",
		noPlaybackMetadata: "No playback metadata",
		thumbnailUnavailable: "No thumbnail",
		previewUnavailable: "Preview unavailable",
		clearFilters: "Clear filters",
		range: "{start}–{end} of {count}",
		emptyFiltered: "No assets match these filters.",
		refresh: "Retry",
		recapture: "Register in library again",
		captureSuppressed:
			"This job was removed from the library during reset. Register it again to restore its library content.",
		editingDisabled: "Editing unavailable",
		sceneCount: "{count} scenes",
		subjectOverlay: "Show subject observations",
		subjectOverlayHint:
			"Observed positions within this shot, not tracking or bounding boxes.",
		globalMetadata: "Global metadata",
		sceneMetadata: "Scene metadata",
		currentScene: "Current scene",
		noCurrentScene: "No scene at the current playback position.",
		adOpportunity: "Ad Opportunity Score",
		adThreshold: "Highlight: Ad Score > 0.5",
		adReason: "Opportunity reason",
		dynamics: "Tension / pacing",
		settings: "Setting / atmosphere",
		characters: "Characters",
		objects: "Objects",
		adCategories: "IAB ad categories",
		unreported: "Not reported",
		timeline: "Scene timeline",
		zoom: "Timeline zoom",
		sceneOverlay: "Show scene overlay",
		automaticImport:
			"Analysis is imported automatically after encoding finishes.",
		omittedSubjects:
			"{count} out-of-shot subject observations were omitted. Original metadata is retained.",
		qcSnapshot: "QC / source snapshot (read-only)",
		qcSnapshotNotice:
			"Saved when this source was registered: up to 20 QC reports and 100 results per report. Dates belong to the original records. This is historical evidence, not a new measurement or playback verification.",
		playback: "Playback manifest",
		title: "Content Library",
		analysis: "AI Scene Analysis",
		loading: "Loading…",
		empty: "No content yet. Completed VOD jobs are registered automatically.",
		search: "Search titles and tags",
		archived: "Archived content",
		active: "Active content",
		previous: "Previous",
		next: "Next",
		count: "{count} items",
		openJob: "Open source job",
		capture: "Import analysis",
		captureHint:
			"Import existing provider analysis and playback references. This does not start an encoding.",
		pending: "Analysis import queued",
		running: "Importing analysis…",
		ready: "Analysis imported",
		error: "Analysis import failed",
		retry: "Retry import",
		unavailable: "No analysis has been imported.",
		missingLocale: "No analysis is available for this language.",
		locale: "Analysis language",
		summary: "Summary",
		scenes: "Scenes",
		shots: "Shots",
		subjects: "Subjects",
		classification: "Classification",
		searchScenes: "Search scene titles, summaries and keywords",
		noScenes: "No matching scenes.",
		seek: "Seek to {seconds}s",
		raw: "Provider analysis (read-only)",
		noPlayback: "No playback source.",
		metadata: "Editorial metadata",
		contentTitle: "Title",
		description: "Description",
		tags: "Tags (comma-separated)",
		register: "Register in Library",
		save: "Save",
		saved: "Saved",
		archive: "Archive",
		restore: "Restore",
		conflict:
			"This content changed in another session. Reload the latest content before saving again.",
		reload: "Reload latest",
		linked: "Linked content",
		identity:
			"Source identity is unverified; this reference does not prove media equivalence.",
		newContent: "Create new content",
		destination: "Registration destination",
		registerSuccess: "Content registered",
	},
	nav: {
		contentLibrary: "Content Library",
		signedInAs: "{name} · {role}",
		brand: "Bitmovin OVP",
		tagline: "encoding console",
		sectionPlatform: "Platform",
		sectionLibrary: "Library",
		sectionSystem: "System",
		/** The below-`md` sheet: its heading, and its trigger's label. */
		menu: "Navigation",
		openMenu: "Open the navigation menu",
		dashboard: "Dashboard",
		vodJobs: "VOD Jobs",
		liveChannels: "Live Channels",
		pseudoLiveFeeds: "Pseudo-Live Feeds",
		vmafLab: "VMAF Lab",
		storage: "Storage",
		presets: "Presets",
		templates: "Templates",
		verification: "Verification",
		settings: "Settings",
		signOut: "Sign out",
		signingOut: "Signing out…",
		authDisabled: "Auth is disabled — this install is open to anyone.",
		// The ADMIN-only diagnostics section is hidden together with its heading below the required role.
		sectionDiagnostics: "Diagnostics",
		apiCoverage: "API coverage",
	},
	// The shared permission screen explains denied direct links. Role names match the session menu.
	permission: {
		title: "Permission required",
		body: "You do not have permission to view this screen. Ask an administrator for access.",
		roles: "Required role: {required} · Your role: {current}",
		checking: "Checking your permissions…",
		unverified:
			"Your permissions could not be confirmed. Reload the page or try again.",
		retry: "Retry",
		reauthenticationTitle: "Sign in required",
		reauthenticationBody:
			"Your session has expired or was revoked. Sign in again to continue.",
		reauthenticationAction: "Sign in again",
	},
	locale: {
		label: "Language",
		en: "English",
		ja: "日本語",
		description:
			"Applies to UI copy only. Bitmovin API values, resource ids and log output stay verbatim.",
	},
	login: {
		title: "Sign in",
		subtitle: "Enter the shared team password for this Bitmovin OVP install.",
		passwordLabel: "Team password",
		usersSubtitle: "Sign in with your email address and password.",
		userPasswordLabel: "Password",
		emailLabel: "Email",
		emailRequired: "Email is required",
		passwordRequired: "Password is required",
		submit: "Sign in",
		submitting: "Signing in…",
		failed: "Sign-in failed",
		notConfiguredTitle: "Authentication is not configured",
		notConfiguredBody: "This install cannot sign anyone in yet.",
		disabledTitle: "Authentication is disabled",
		disabledBody:
			"Authentication is not used in this environment. Restrict access to approved users at the network boundary.",
		continueToConsole: "Continue to the console",
	},
	setup: {
		title: "First-boot setup",
		subtitle:
			"This install has no users yet. Create the first ADMIN account with the one-time setup code from the server log.",
		codeLabel: "Setup code",
		codeHint:
			"Printed once to the server log — run: docker compose logs web | grep setup-code",
		codeRequired: "Setup code is required",
		emailLabel: "Admin email",
		emailRequired: "Email is required",
		displayNameLabel: "Display name",
		displayNameRequired: "Display name is required",
		passwordLabel: "Password (12+ characters)",
		passwordRequired: "Password is required",
		passwordTooShort: "At least 12 characters",
		submit: "Create admin and sign in",
		submitting: "Creating…",
		failed: "Setup failed",
	},
	rotate: {
		title: "Set a new password",
		subtitle:
			"Your temporary password must be replaced before this account can act. Pick a new password only you know.",
		currentLabel: "Current (temporary) password",
		currentRequired: "Current password is required",
		newLabel: "New password (12+ characters)",
		newRequired: "New password is required",
		newTooShort: "At least 12 characters",
		confirmLabel: "Repeat new password",
		confirmMismatch: "Passwords do not match",
		submit: "Change password",
		submitting: "Changing…",
		failed: "Password change failed",
	},
	common: {
		accessAdminOnly:
			"This area is for administrators. Ask an admin if you need access.",
		cancel: "Cancel",
		close: "Close",
		confirm: "Confirm",
		copy: "Copy",
		copied: "Copied",
		delete: "Delete",
		edit: "Edit",
		loading: "Loading…",
		none: "None",
		refresh: "Refresh",
		retry: "Retry",
		save: "Save",
		saving: "Saving…",
		/** The sentence-ending glyph: JA uses 「。」, so it cannot be a JSX literal. */
		sentenceEnd: ".",
		unknown: "Unknown",
		unknownError: "unknown error",
		deleting: "Deleting…",
		deleteAria: "Delete {resource}",
		deleteAriaDisabled: "Delete {resource} (disabled)",
		renditionNumbered: "Rendition {n}",
		errorPrefix: "Error",
		name: "Name",
		status: "Status",
		created: "Created",
		duration: "Duration",
		progress: "Progress",
		actions: "Actions",
		labels: "Labels",
		region: "Region",
		clear: "Clear",
		select: "Select…",
		view: "View",
		provider: "Provider",
		requestFailed: "Request failed. Try again.",
	},
	customerError: {
		tenantIpDenied:
			"This IP address is not allowed for this organization. Contact an administrator.",
		tenantChanged:
			"The organization changed. Reload this page before continuing.",
		tenantMembershipRequired:
			"Access to this organization is unavailable. Check your membership and permissions.",
		tenantIpInvalid: "Enter a valid IP address or CIDR on each line.",

		authNotConfigured:
			"Authentication setup is incomplete. Ask an administrator to review the sign-in method and authentication settings.",
		authProviderUnavailable:
			"This sign-in method is not available. Ask an administrator to choose a supported sign-in method.",
		authInvalidCredentials: "The email address or password is incorrect.",
		authPasswordExpired:
			"This temporary password has expired. Ask an administrator to issue a new one.",
		authRateLimited:
			"Too many sign-in attempts failed. Wait a moment and try again.",
		authBusy:
			"Too many sign-in attempts are being checked. Wait a few seconds and try again.",
		authPasswordRequired: "Enter your password.",
		authEmailRequired: "Enter your email address.",
		authCredentialsChanged:
			"Your credentials changed while sign-in was being checked. Try again with your current password.",
		authModeUnsupported:
			"This sign-in method cannot create a browser session. Ask an administrator to review the authentication settings.",
		authSetupRequired:
			"Initial administrator setup is required. Open Setup to create the first administrator account.",
		storageEndpointNotAllowed:
			"This storage endpoint is not allowed in the current deployment. Ask an administrator to review the storage endpoint allowlist before saving the credential.",
		storageBrowseUnsupported:
			"This credential cannot browse storage from this screen. Enter the bucket and object path manually, or choose a browsable storage credential.",
		resetCleanupUnconfirmed:
			"Data cannot be reset because cleanup of delivery resources from an earlier operation could not be confirmed. Contact your system administrator or support team.",
		resetProviderResourcesUnconfirmed:
			"Some cloud encoding resources may still be active. Check the listed encoding IDs in Bitmovin, stop any active resources, and try the data reset again.",
		resetLocalWorkActive:
			"A VMAF measurement or pseudo-live feed is still active. Finish or stop it from its page, then try the data reset again.",
		resetActiveWork:
			"Encoding or live processing is still active. Stop the active work, wait for it to finish stopping, and try the data reset again.",
		resetStateChanged:
			"The system status changed before the data reset could start. Review the current status and try again.",
		resetAisaSnapshotRequired:
			"Some completed AI Scene Analysis jobs are waiting for automatic Content Library capture. Open the job to check progress, then return here. Reset remains blocked until capture finishes. Captured library data is kept when job history is reset.",
		liveNotStartable:
			"The channel is {status}. It can be started from CREATED, ERROR or STOPPED. Refresh the page and check its current state.",
		liveRunAlreadyActive:
			"This channel already has an active run. Open that run instead of starting another one.",
		liveNotStoppable:
			"The channel is {status}. Stop is available while it is RUNNING or ERROR. Refresh the page and check its current state.",
		liveStopHandoffMissing:
			"The previous stop request cannot be confirmed for this run. Refresh the page before trying again.",
		liveStopHandoffComplete:
			"The previous stop request is no longer in progress. Refresh the page and check the channel state.",
		liveNotRestartable:
			"The channel is {status}. Restart is available while it is RUNNING or ERROR. Refresh the page and check its current state.",
		liveRestartRequiresNewRun:
			"This run has ended and cannot be restarted. Choose Start channel to begin a new run.",
		liveStateChanged:
			"The channel changed while this request was being accepted. Refresh the page and try the appropriate action again.",
		liveNoEncoding:
			"This channel does not have an encoding for the requested action yet. Start the channel and wait for provisioning to finish.",
		liveCurrentRunMissing:
			"The current run could not be identified. Refresh the page; if the state does not recover, contact an administrator.",
		liveProviderEncodingMissing:
			"The current run has no encoder assigned yet. Wait for channel provisioning to finish and try again.",
		liveProviderTransitional:
			"The encoder has not reached RUNNING yet. Wait for the provider status to become RUNNING and try again.",
		liveProviderUnobserved:
			"The encoder status has not been confirmed yet. Wait for the next status check and try again.",
		liveProviderUnknown:
			"The encoder status cannot be confirmed right now. It is checked every 30 seconds; retry after a fresh reading, or stop the channel.",
		liveProviderTerminal:
			"The encoder for this run has ended. Choose Start channel to begin a new run.",
		liveDeploymentRestricted:
			"This channel's configuration is not allowed in the current deployment. Review its region and destinations before starting it.",
		liveTimeshiftRequiresRunning:
			"Timeshift can be reset while the channel is RUNNING. Its current state is {status}.",
		liveCueRequiresRunning:
			"An SCTE-35 cue can be sent while the channel is RUNNING. Its current state is {status}.",
		liveRequestConflict:
			"This request identifier is already assigned to different cue settings. Submit the intended cue with a new request identifier.",
		liveRequestAmbiguous:
			"The cue may already have been applied. Check the live-effect status before trying again.",
		liveRequestInProgress:
			"This cue request is already in progress. Wait for its result before trying again.",
		liveAccountMissing:
			"This channel no longer has a Bitmovin account attached. Attach the correct account before using live controls.",
		liveAccountMismatch:
			"The selected Bitmovin account does not belong to this channel. Refresh the page and select the channel's account.",
		liveRequiresRunning:
			"This operation is available while the channel is RUNNING. Its current state is {status}. Start the channel, confirm the input is connected, and try again.",
		liveIngestNotConnected:
			"The input is not CONNECTED yet. Wait for the Input state to become CONNECTED, then try again.",
		liveEncodingUnavailable:
			"The channel's encoding is not ready yet. Wait for channel provisioning to finish and try again.",
		liveAccountUnavailable:
			"The channel's Bitmovin account could not be found. Attach an available account before using live controls.",
		vmafNotRunning:
			"VMAF capture is available while the channel is RUNNING. Its current state is {status}.",
		vmafOutputUnreadable:
			"VMAF cannot read output {output} for rendition {rendition}. Use a readable object-storage destination for this capture.",
		vmafFeederRequired:
			"VMAF capture needs a pseudo-live file input as its reference. Start or attach a file input, then capture again.",
		vmafFirstSegmentPending:
			"Not every capture target has current segments yet. Check the input and output, wait briefly, then try again.",
		vmafReadinessUnobservable:
			"Capture readiness could not be verified. Check output settings and read access, then try again.",
		channelStopBeforeDelete:
			"The channel is {status}. Stop it first, then delete it after the stop completes.",
		channelVmafInProgress:
			"This channel's VMAF measurement is {status}. Wait for it to finish before deleting the channel.",
		channelStateChanged:
			"The channel changed while the request was being processed. Refresh the page, confirm its current state, and try again.",
		runtimeCapBeforeProgramEnd:
			"The maximum run time ends before the scheduled programme. Extend the maximum run time beyond the programme end.",
		feederLimitReached:
			"Up to {limit} file inputs can run at once ({current} now). Stop an unused input, wait for shutdown to complete, and try again.",
		feederChannelOccupied:
			"Another file input is active on this channel. Stage the new input as a switch, or stop the current input first.",
		feederSwitchRequiresActive:
			"There is no active file input to switch from. Start this as a normal file input instead.",
		feederChannelNotReady:
			"The channel is {status}. A file input can start while the channel is PROVISIONING or RUNNING.",
		feederRunMissing:
			"The current run cannot be found. Start the channel and wait for its run to be created, then try again.",
		feederStopNotNeeded:
			"The file input has already ended (status: {status}). Refresh the page to confirm its current state.",
		feederStopBeforeDelete:
			"Stop the file input before deleting it. Refresh after the stop completes, then delete it again.",
		feederShutdownPending:
			"The file input shutdown has not been confirmed yet. Wait briefly, refresh the page, and delete it after shutdown completes.",
		feederStateChanged:
			"The file-input session changed while the request was being processed. Refresh the page, confirm its current state, and try again.",
		feederChannelNotFound:
			"The selected channel no longer exists. Refresh the channel list and choose an available channel.",
		feederSourceCredentialMissing:
			"The selected storage credential is no longer available. Select or create a credential that can read the source file.",
		feederSrtCredentialInvalid:
			"The selected SRT passphrase credential is unavailable or has the wrong type. Select an SRT passphrase credential and try again.",
		feederSourceUnreadable:
			"The source file cannot be read. Check the storage credential, bucket, object path and read permission, then try again.",
		scheduleLeadTimeTooShort:
			"The air time does not leave the required {seconds} seconds for channel startup. Move the air time later or choose an earlier start time.",
		scheduleFireTimeNotFuture:
			"Choose a scheduled time in the future, then arm the schedule action again.",
		scheduleOutsideRunWindow:
			"This schedule action is after the channel's maximum run time. Move it earlier or extend the maximum run time.",
		scheduleContentNotFound:
			"The selected insertable content is not available on the current encoding. Refresh the content list and select it again.",
		scheduleContentNotReady:
			"The selected insertable content is {status}. Wait until it is READY, refresh the content list, and try again.",
		scheduleNotCancellable:
			"This schedule action is already {status} and cannot be cancelled. Refresh the schedule to see its latest state.",
		contentRequestConflict:
			"This request identifier belongs to different insertable-content settings. Submit the intended insertion with a new request identifier.",
		contentStateChanged:
			"The current run or encoder changed before the insertion was accepted. Refresh the page, confirm the channel is RUNNING and the input is CONNECTED, then try again.",
		contentRequestBlocked:
			"This content-insertion request cannot be started yet. Check the current insertion in the schedule, then retry or use a new request identifier.",
		contentInsertNotActive:
			"No inserted content is currently playing, so no stop is needed. Refresh the scheduled insertions to confirm their current state.",
		contentReservationNotCancellable:
			"This scheduled insertion can no longer be cancelled. Refresh the scheduled insertions to see its latest state.",
		// C36 (WP-A2): the slate compatibility preflight.
		slateIncompatible:
			"This clip does not match the live stream. Bitmovin would register it as READY and the insertion would fail at air time. Choose a clip whose frame rate, audio sample rate and other attributes match the ingest.",
		slateUnsupportedImage:
			"The still-image slate could not be registered. Use a JPG or PNG and set a display duration when inserting.",
		slateUninspected:
			"The clip is still being inspected. Wait for the compatibility check to finish, then register again.",
		slateSourceUnsupported:
			"This storage credential cannot serve insertable content. Pick a file in S3, S3-compatible, GCS (HMAC) or Azure Blob storage.",
		alertChannelNotFound:
			"The selected channel no longer exists. Return to the channel list and choose an available channel before adding the rule.",
		alertAlreadyResolved:
			"This alert has already been resolved. Refresh the page to see its latest state.",
	},
	nextAction: {
		regionLabel: "Next action",
		startEncoderTitle: "Start the channel",
		startEncoderBody:
			"Nothing is running yet. Starting boots an encoder instance, which then waits for your input to connect. Startup time varies by region and configuration.",
		recoverTitle: "Review the previous run's status",
		recoverBody:
			"Review diagnostics, the end reason and the encoder state before choosing the next action.",
		bootTitle: "Starting",
		bootBody:
			"Startup time varies by region and configuration. Open actions to cancel the start.",
		stoppingTitle: "Stopping — nothing to do",
		stoppingBody:
			"The encoder is shutting down. The step log below shows the stop steps; the channel becomes STOPPED when they finish.",
		connectInputTitle: "Connect your input",
		connectInputBody:
			"The encoder is up and waiting. Until an input binds there is no output timeline, so a slate insert would render nothing — start a feeder or point your encoder at the ingest URL.",
		outputTitle: "Waiting for the first segments",
		outputBody:
			"Input is connected; the manifest has no playable renditions yet. The first playback-probe segment landed 31.8s after the probe in our measurement.",
		alertsTitle: "An alert is open",
		alertsBody:
			"The channel is live but a rule is firing. Review it before anything else — resolve it or stop the channel.",
		alertsUnknownTitle: "Alert state could not be read",
		alertsUnknownBody:
			"The alert list did not load, so nobody can say this channel is healthy — a failed read is not zero alerts. Open the alerts card, retry, and check that the app can reach its own API before treating the channel as monitored.",
		// A failed provider status read leaves the encoder state unconfirmed.
		providerUnknownTitle: "Bitmovin encoder status unconfirmed",
		providerUnknownBody:
			"Bitmovin has not confirmed this run's encoder status yet, or the latest check failed, so do not treat the channel as on air. It is checked again every 30 s. Stop remains available; wait for a fresh reading before other live actions.",
		onAirTitle: "On air",
		onAirBody:
			"Input is connected, no alerts are open, and the manifest is playable. Stop the channel when the programme ends.",
		startNewRunTitle: "Start a new run",
		startNewRunBody:
			"This channel's last run has ended — its encoding is finished and cannot be restarted (that is Bitmovin's model, not a fault). Starting begins a NEW run: a fresh encoder, the same channel, its schedules and rules intact.",
		scheduledTitle: "The schedule will act",
		scheduledBody:
			"An armed schedule row will fire on its own. You do not have to start anything by hand.",
		idleTitle: "Nothing to do",
		idleBody:
			"The channel is not running and nothing is armed. Start the channel, or schedule an action.",
		goActions: "Actions",
		goFeeders: "Feeders",
		goSchedule: "Schedule",
		goAlerts: "Alerts",
		goManifests: "Manifests",
		goSteps: "Step log",
	},
	/**
	 * : the six body LAYERS, in operator order. Each heading is a
	 * landmark; each lead line says why the layer exists, so the order is
	 * legible rather than merely imposed.
	 */
	liveLayer: {
		// Name each section by its operational concept; explain its contents beside the heading.
		operations: "Channel state",
		operationsLead: "Alerts, manifests and slate reservations",
		operationsHelp:
			"Check alerts, playback links and slate reservations here. Current readings are in Delivery status above.",
		programme: "Programme",
		programmeLead: "Programme schedule, content insertion and emergency stop.",
		input: "Input & pseudo-live",
		inputLead: "Where the feed comes from, and what is pushing it.",
		delivery: "Output & delivery",
		deliveryLead: "DVR, DNS, VOD after the broadcast and VMAF quality capture",
		deliveryHelp:
			"Covers output groups and manifests, DVR, VOD after the broadcast and VMAF quality reports.",
		diagnostics: "Diagnostics & history",
		diagnosticsLead:
			"Raw telemetry, past runs, and the settings you change once.",
		danger: "Danger zone",
		dangerLead: "Irreversible. Nothing here is part of running a broadcast.",
	},
	// Section help distinguishes input state, output monitoring, slate insertion, file inputs,
	// and automatic stops using operator outcomes rather than API constraints.
	liveHelp: {
		ingest:
			"The address and stream key your encoder connects to over RTMP or SRT. The direction (push, listener or caller) comes from the input settings. Once video arrives here, the input and encoder state shows it as received.",
		heartbeat:
			"Every 30 seconds the encoder's own input and encoding statistics are collected and shown here. This does not confirm output updates or viewer playback — see Output monitoring for that.",
		origin:
			"Reads the HLS media playlists at the output destination and shows segment updates, ENDLIST and live-edge delay. This is a separate check from the channel state and from the input and encoder state, and it does not prove viewer playback.",
		schedule:
			"Reservations that start or stop the channel, or insert a slate, at a set time. Reserved, requested, accepted by the provider and confirmed on media are shown as separate states. A late stop still runs; a start or slate that is too late is marked not run.",
		slate:
			"Reservations of insertable content (a slate) that overrides the program. Reserved does not mean currently inserted. This is not AWS MediaLive's input switch, static image overlay or input-loss slate: it neither switches inputs nor overlays a still image.",
		insertion:
			"Register the content to insert here. Set a timed insertion in Schedule actions below.",
		insertionStop:
			"Stop content inserted via Schedule actions right now. This does not touch the reservation list.",
		feeders:
			"Repeatedly sends a stored MP4 and uses it as input to a live channel. It is not an AWS Elemental MediaLive Input resource.",
		runtimeCap:
			"A safety stop. Once the channel has been running for this many minutes it stops automatically, measured from the moment it was seen running. It can stop before the planned end of the program, and billing continues until the stop completes.",
		liveToVod:
			"After the broadcast, builds VOD manifests from the live output. It reuses the segments written during the broadcast, so it is not the same as an AWS Archive output group, which records a separate archive.",
	},
	// Live-specific wizard keys use AWS MediaLive vocabulary without renaming shared VOD labels.
	liveMirror: {
		title: "Storage mirror",
		enable: "Also deliver to storage",
		help: "Copies segments and manifests to storage using the primary paths and public-read setting. MP4 archive access is set separately.",
		unsupported:
			"Choose a storage destination for the mirror, not MSL or a delivery server.",
		sameDestination:
			"Choose a different storage credential or bucket from the primary destination.",
		unavailable: "Mirror credential unavailable — select a storage credential.",
	},
	liveArchive: {
		title: "MP4 archive",
		enable: "Save an MP4 archive",
		help: "Save one existing H.264 video and AAC audio together, alongside live delivery. No separate encoding is created. Storage outputs only; not Akamai MSL.",
		requiresStreams: "Add an H.264 video and AAC audio in Encodes first.",
		video: "Video",
		audio: "AAC audio",
		selectStream: "Select a stream",
		unavailableStream: "Selected stream is unavailable — select again",
		unavailableDestination: "Selected storage is unavailable — select again",
		destination: "Archive destination",
		separateStorage: "Separate storage output",
		originStorage: "Existing primary storage output",
		mirrorStorage: "Existing mirror storage output",
		credential: "Credential",
		bucket: "Bucket / container",
		path: "Archive path",
		pathHelp:
			"The first airing uses this path; later airings add a run prefix. Choose a unique path when duplicating a channel. Storage delivery mirrors also receive the archive, except its own destination. An MSL delivery mirror is incompatible.",
		filename: "Filename",
		access: "Archive access",
		private: "Request private access (default)",
		publicRead: "Allow public read",
		destinationDefault: "Use destination default (no permission specified)",
		verifyAfterStop:
			"After stopping, download and check the file and audio/video duration. Private requests PRIVATE; verify that bucket policies or other settings do not grant public access. The destination default may be public. This is not a live playback URL. Delivery checks alone do not verify the archive or whole plan.",
	},
	liveWizard: {
		outputWidth: "Width (px)",
		outputWidthHint:
			"Blank inherits the input aspect ratio; specifying both dimensions fixes the output size. A single dimension is judged for Live HD at 16:9.",
		customLiveNotice: "This configuration will use Custom Live.",
		customLiveExplanation:
			"Live HD cannot be confirmed for the settings below. Custom Live billing applies; no automatic billing-mode retry is performed.",
		customLegacy:
			"This saved plan retains its original Custom Live start method.",
		customRequested: "The imported plan explicitly selects Custom Live.",
		customCodec: "Codec {actual} is outside Live HD (H264 / AAC).",
		customInputProtocol:
			"Live HD support is not confirmed for {actual}; supported inputs are RTMP, redundant RTMP and SRT.",
		customInput:
			"{actual} depends on the input or is not fixed; Live HD compatibility cannot be confirmed.",
		customVideoCount: "Video streams: {actual}; Live HD allows up to {limit}.",
		customHdCount: "HD video streams: {actual}; Live HD allows up to {limit}.",
		customLongEdge: "Video long edge: {actual}px; Live HD limit {limit}px.",
		customShortEdge: "Video short edge: {actual}px; Live HD limit {limit}px.",
		customFps: "Frame rate: {actual}fps; Live HD limit {limit}fps.",
		customVideoBitrate:
			"Video bitrate: {actual}bps; Live HD limit {limit}bps per stream.",
		customPixels: "Combined video pixels: {actual}; Live HD limit {limit}.",
		customTotalBitrate:
			"Combined video bitrate: {actual}bps; Live HD limit {limit}bps.",
		customAudioCount: "Audio streams: {actual}; Live HD allows up to {limit}.",
		customAudioBitrate: "Audio bitrate: {actual}bps; Live HD limit {limit}bps.",
		customSampleRate: "Audio sample rate: {actual}Hz; Live HD limit {limit}Hz.",
		customChannels: "Audio channels: {actual}; Live HD allows up to {limit}.",
		customMode:
			"Encoding mode {actual} is outside Live HD single-pass encoding.",
		customPreset: "Preset {actual} is outside the Live HD preset range.",
		customManifests:
			"Output manifests: {actual}; Live HD allows up to {limit}.",
		stepBasics: "Basics",
		stepInput: "Input",
		stepEncodes: "Video and audio encodes",
		stepDestinations: "Destinations",
		stepOutputGroups: "Output groups and manifests",
		stepRunSafety: "Automatic restart and stop",
		stepScheduleActions: "Schedule actions",
		stepReview: "Review",
	},
	/**
	 * : the in-page navigation over those layers — a rail in the right
	 * margin at `xl`, the same list behind a "Jump to" button below it.
	 */
	liveNav: {
		regionLabel: "Sections",
		jumpTo: "Jump to",
		jumpToClose: "Close",
	},
	/**
	 * : the page's one polite live region. Everything here is spoken
	 * only on a CHANGE — never on a poll that measured the same thing again —
	 * so each string reads as an event, not as a status label.
	 */
	liveAnnounce: {
		ingestConnected: "Ingest connected.",
		ingestDisconnected: "Ingest disconnected.",
		heartbeatFresh: "Heartbeat is current again.",
		heartbeatStale: "Heartbeat has gone stale.",
		alertOpened: "An alert opened — {count} open.",
		alertResolved: "An alert resolved — {count} open.",
		scheduleArmed: "Scheduled: {action} at {time}.",
		scheduleCancelled: "Schedule cancelled.",
	},
	status: {
		regionLabel: "Channel status",
		ingest: "Ingest",
		ingestConnected: "Connected",
		playable: "Playable",
		never: "never",
		unknown: "unknown",
		none: "None",
		clockSkew: "clock skew",
		secondsAgo: "{seconds}s ago",
		summaryNextFire: "next {action} {time}",
		summaryNoneArmed: "none armed",
		summaryFeeders: "{count} running",
		summaryRenditions: "{count} renditions",
		summaryOpenAlerts: "{count} open",
		summaryStepsDone: "{done}/{total} done",
		summaryStreams: "{count} streams",
		summaryLinks: "{count} links",
		// A failed read must remain distinct from an empty or zero result.
		summaryUnavailable: "could not be read",
		readUnavailable:
			"This could not be read, so it is not the same as “nothing”. Retry, and check that the app can reach its own API — anything shown below is the last successful read.",
		// Show the next scheduled event and elapsed or remaining run time in the header.
		nextEvent: "Next event",
		nextEventIn: "{action} in {countdown}",
		// An armed row past its fireAt is evidence the sweep is not running,
		// not a row about to fire — the same reading `overdueArmedCount` uses.
		nextEventOverdue: "{action} overdue by {countdown}",
		nextEventSlate: "slate {seconds}s",
		runtime: "Runtime",
		runtimeElapsed: "{elapsed} elapsed",
		runtimeRemaining: "{elapsed} elapsed · {remaining} left",
		runtimeCapReached: "{elapsed} elapsed · cap reached",
		// The POST-MORTEM figure, frozen at the stop. Past tense on purpose:
		// nothing about it is still running.
		runtimeRan: "ran for {duration}",
		summaryResolvedAlerts: "{count} resolved",
	},
	notFound: {
		title: "Page not found",
		body: "The address is wrong, or the thing it pointed at was deleted. Encoding jobs and reports are removable, and a link to one that is gone lands here.",
		backToDashboard: "Back to the dashboard",
	},
	dashboard: {
		allPanelsHidden: "All dashboard panels are hidden.",

		heading: "Dashboard",
		panelsButton: "Panels",
		panelsHint:
			"Choose which panels to show. This preference is saved in this browser.",
		panelsUsage: "Usage",
		panelsReset: "Show all panels",
		trends: "Trends",
		loadFailed: "Could not load the overview:",
	},
	insights: {
		encodedVolume: "Encoded data per day (GiB)",
		egressVolume: "Egress per day (GiB)",
		statisticsNote:
			"Based on the selected account and period, including usage outside this application.",

		clear: "Clear",
		codecs: "Codecs",
		containers: "Containers",
		drm: "DRM",
		formatMix: "Delivery format mix (recent finished jobs)",
		jobsByDay: "Jobs per day (14 days)",
		liveAirtime: "Live airtime per channel (7 days)",
		minutesByDay: "Pipeline minutes per day (wall-clock, 14 days)",
		moreChannels:
			"+{count} channel(s) not shown — the chart caps at the top 10 by airtime.",
		noFinishedJobs: "No finished jobs yet.",
		noJobsYet: "No jobs in the window yet.",
		noLiveRuns: "No live runs in the window.",
		seriesCanceled: "Canceled",
		seriesError: "Error",
		seriesFinished: "Finished",
		seriesMinutes: "Minutes",
		seriesOther: "In progress / other",
		unparsedPlans:
			"{count} stored plan(s) no longer parse and are excluded from the format mix — counted, not silently dropped.",
	},
	jobs: {
		columns: "Columns",
		title: "VOD Jobs",
		newJob: "New VOD Job",
		// QC gate column + filter .
		qc: "QC",
		qcPass: "Pass",
		qcFail: "Fail",
		filterByLabel: "Filter by label…",
		selectAllLoaded: "Select all loaded jobs",
		loadFailed: "Failed to load jobs.",
		label: "Label",
		all: "All",
		deleteConfirmMany:
			"Removes each job, its VMAF reports and local snapshots. The Bitmovin encodings (if any) are left untouched. This cannot be undone.",
		deleteConfirmOne:
			"Removes the job, its VMAF reports and local snapshots. The Bitmovin encoding (if any) is left untouched. This cannot be undone.",
		rerunning: "Re-running…",
		rerunSelected: "Re-run selected",
		noActiveInSelection: "Selection contains no queued or running jobs",
		noTerminalInSelection:
			"Selection contains no terminal jobs — cancel them first",
		rerunFailed: "Re-run failed",
		cancelFailed: "Cancel failed",
		bulkDeleteFailed: "Bulk delete failed",
		deleteFailed: "Delete failed",
		noMatches: "No jobs match the current filters.",
		emptyHint: "No jobs yet — start one with “New VOD Job”.",
		loadMore: "Load more",
		statusDraft: "Draft",
		statusQueued: "Queued",
		statusRunning: "Running",
		statusAwaitingQc: "Awaiting quality check",
		statusFinished: "Finished",
		statusError: "Failed",
		statusCanceled: "Cancelled",
		statusQcFailed: "Quality check failed",
		providerFailure:
			"The encoding failed. Review the technical details before running it again.",
		technicalDetails: "Technical details",
		providerFailureDetail: "Provider error details",
	},
	playback: {
		skipToDetail: "Skip to job detail",
		railLabel: "Playback and manifests",
		/** Why a manifest has no playable URL (PublicUrlReason, one key per case). */
		whyNoUrl: "No playable URL",
		enlarge: "Enlarge",
		previewTitle: "Playback preview",
		retry: "Retry playback",
		mp4FileMissing: "MP4 file is missing from storage.",
		accessDenied:
			"Access to the output was denied (401/403). For private outputs, check playback URL authentication and read permissions.",
		storageAccessDenied:
			"Storage denied access to this MP4. Check the storage credential and read permissions.",
		previewWhileRunning: "Encoding still running — just-in-time manifest",
		previewWaitingForOutput:
			"Playback waits until video output is confirmed; it starts automatically once segments are seen.",
		previewPlayNow: "Play now",
		previewAfterFinish:
			"Playback preview appears here once the encoding has finished.",
		initialManifestTimeout:
			"Initial playback readiness could not be confirmed within the wait period. Check the input feed and publication buffer, then retry playback.",
		waitingForFirstSegment:
			"Waiting for the channel's first segment — the manifest is not published until the encoder writes one (attempt {attempt}).",
		recovering:
			"Playback is interrupted. Shaka Player is retrying automatically. This notice clears when delivery recovers.",
		recoveryStalled:
			"Playback has not recovered after 60 seconds. Shaka Player is still retrying; check the delivery path and the playback prerequisites below.",
		hlsUnsupported:
			"HLS playback is not supported by this browser (neither hls.js nor native HLS is available).",
		dashUnsupported: "DASH playback is not supported by this browser.",
		corsCheckTitle: "Playback prerequisites",
		corsOk:
			"The bucket's CORS rules allow this page and expose the range headers, so CORS is not the cause.",
		corsNoRules:
			"The bucket has no CORS configuration. A player fetches manifests and segments with XHR, so the bucket must allow this page's origin — public-read alone is not enough.",
		corsOriginNotAllowed:
			"No CORS rule allows {origin} for GET, so the browser blocks every fetch before playback starts.",
		corsRangeHeaderNotAllowed:
			"The CORS rules do not allow the Range request header. A player that requests byte ranges is preflighted, and the bucket rejects the preflight.",
		corsMissingExposeHeaders:
			"The CORS rules do not expose {headers}. Player requirements differ, so this check cannot rule the headers out. Add them to Access-Control-Expose-Headers, then verify the manifest and segment requests in the browser network log.",
		corsMissingExposeHeadersAdvisory:
			"The CORS rules do not expose {headers}. The open-source HLS preview does not treat this as causal: its hls.js path plays without those exposed headers. This is advisory and is not identified as the cause of this failure.",
		corsDeclaredBase:
			"This bucket has a public base URL declared on its credential, so playback goes through that host. This check reads the origin bucket's CORS rules, and it cannot tell whether the declared host is a CDN in front of the bucket — in which case those rules are not the ones the player is subject to — or the bucket's own address, in which case they are exactly right. Rather than guess, no verdict is given. If the declared host is the bucket itself, this bucket's CORS rules ARE the ones to check; if it is a CDN or custom domain, check CORS there.",
		corsUnknownDriver:
			"This provider's CORS configuration cannot be read yet, so CORS is neither confirmed nor ruled out.",
		corsUnknownForbidden:
			"The credential is not allowed to read the bucket's CORS configuration (s3:GetBucketCORS), so CORS is neither confirmed nor ruled out.",
		corsUnknownNoBucket:
			"This output is not served over HTTP, so it has no CORS configuration.",
		licenseDomainRefused:
			"Player licence: this domain is not authorised for the configured Bitmovin Player key. Register this host in the Bitmovin dashboard, or switch back to hls.js / Shaka Player (default).",
		corsCheckFailed: "Could not check the bucket's CORS configuration.",
		reasonNoCredential:
			"The credential this output writes through is not available, so its public host is unknown.",
		reasonNotPublic:
			"The output ACL is private (PRIVATE), so direct playback is unavailable. Configure a playback delivery URL.",
		reasonAzureNoAcl:
			"Azure has no per-blob ACL: anonymous access is a container setting, so the plan cannot say the container is public. Declare its public base URL on the credential.",
		reasonOciCompatAuth:
			"OCI's S3-compatibility endpoint requires authentication even for publicly readable objects. Declare the public base URL (native API path or a Pre-Authenticated Request) on the credential.",
		reasonSftpNoHttp:
			"SFTP outputs are not served over HTTP — copy the path into whatever origin fronts them.",
		reasonNoBuckets:
			"This credential holds no HTTP-addressable buckets, so no playback URL exists.",
		reasonMissingConfig:
			"The credential carries no {field}, which its public URL is built from.",
		reasonBadBaseUrl:
			"The public base URL declared for {bucket} is not usable. It must be an absolute http(s) URL with no query or fragment.",
		reasonInsecureEndpoint:
			"This output is served over http, not https — the browser blocks it as mixed content. Front the bucket with TLS and declare that base URL on the credential.",
		reasonMslEdgeUrlNotConfigured:
			"This Akamai MSL credential has no delivery edge base URL, so no playback link can be built. Register the Akamai edge base URL on the credential.",
		openCredentialSettings: "Open credentials",
	},
	jobDetail: {
		encodingModeFromLadder: "Configured per rendition",
		vmafLoadFailed: "Could not load VMAF reports.",
		retryVmafOnly: "Retry VMAF only",
		retryVmafOnlyHint:
			"Recalculate locally using existing outputs. No re-encoding.",
		vmafRunning: "VMAF measurement is in progress.",
		vmafRetryQueued: "VMAF retry queued. The encoding will not run again.",
		ridesInContainerOf: "inside {key}'s container",
		alsoCarries: "also carries {keys}",
		chainIngest: "ingest {mode} pos {position}",
		chainFile: "file {type}",
		chainDolby: "Dolby {kind} {detail}",
		chainTrim: "clip {kind}",
		chainConcat: "concat pos {position}",
		chainConcatMain: "concat pos {position} (main)",
		readByEncoding: "read by the encoding",
		encodingId: "Encoding id",
		renditions: "Renditions",
		videoRenditions: "Video",
		audioRenditions: "Audio",
		subtitleRenditions: "Subtitles",
		colKey: "Key",
		colCodec: "Codec",
		colResolution: "Resolution",
		colChannels: "Channels",
		colBitrate: "Bitrate",
		colProfile: "Profile",
		colSampleRate: "Sample rate",
		colMode: "Mode",
		colMuxings: "Muxings",
		// Per-Title RESULT capture (design §4a). "Results" is deliberately not
		// "renditions": these are what the encoder produced, not what was asked for.
		ptResults: "Per-Title results (what the encoder produced)",
		ptAbsent:
			"Not captured. Jobs that ran before this feature existed can be backfilled while Bitmovin still has the encoding (about 90 days).",
		ptFailed: "The capture could not read the results: {error}",
		ptCaptureNow: "Capture now",
		ptCapturing: "Capturing…",
		ptCaptureFailed: "Capture failed: {error}",
		ptFromRun: "Captured at the end of the run, {at}",
		ptFromBackfill: "Backfilled from Bitmovin, {at}",
		ptScanStreamsListed: "streams listed",
		ptScanResultsCaptured: "results captured",
		ptScanMuxingsListed: "muxings listed",
		ptScanTemplatesListed: "templates listed",
		ptScanTemplatesDeclared: "templates declared",
		ptScanUnattributed: "unattributed",
		ptScanConfigErrors: "codec-config read errors",
		ptScanDetailLabel: "Scan accounting — what was listed vs captured",
		ptIncomplete:
			"This scan stopped before the end of the list — the rungs below may not be all of them.",
		ptConfigErrors:
			"{count} codec configuration(s) could not be read, so those rows show no parameters.",
		ptNoResults:
			"The capture succeeded and found no result streams. The per-title algorithm produced nothing for this encoding.",
		ptColStream: "Stream",
		ptColApplied: "Applied",
		ptColAvgBitrate: "Avg bitrate",
		ptColMaxBitrate: "Max bitrate",
		ptColSegments: "Segments",
		ptColMuxing: "Muxing",
		ptPathTitle:
			"The path this rendition was actually written to — final once the encoding completes.",
		ptDrmPathTitle: "Encrypted output of the {type} DRM on this leg",
		// Copy-button names include the target and purpose so each control is distinct to screen readers.
		ptCopyPath:
			"Copy the output path of rendition {rendition} ({muxing}): {path}",
		ptCopyDrmPath:
			"Copy the {drm}-encrypted output path of rendition {rendition} ({muxing}): {path}",
		ptColParams: "Parameters",
		ptResultParamCount: "{count} settings",
		ptResultParamsLabel: "Encoder-chosen codec settings (observed)",
		ptResultParamsMissing: "not read",
		ptFromTemplate: "From template {rendition}",
		ptUnattributed: "Unattributed ({count})",
		// Keep the four fail-closed witnesses aligned with attributeResult.
		ptWhyUnattributed:
			"Results are matched first by a unique QC-mirror filename. Without that filename, fixed results require matching encoder-returned fixed settings; flexible results use a unique template-specific output path, or fall back to a sole flexible template of the same codec when no path evidence applies. Ambiguous or mismatched evidence remains “Unattributed”; it is never guessed.",
		perTitle: "Per-Title",
		perTitleScaled: "chosen by the algorithm",
		noMuxings: "no muxings",
		muxingDetail: "Muxing detail",
		viaDrmOutputs: "writes via the DRM resource's outputs",
		filterChain: "Filter chain",
		streamId: "Stream id",
		codecConfigId: "Codec config id",
		planParameters: "Plan parameters",
		schemaDefault: "default",
		expandRow: "Show details",
		expandRowNamed: "Show details for {rendition}",
		collapseRowNamed: "Hide details for {rendition}",
		collapseRow: "Hide details",
		inputFiles: "Input files",
		deletedCredential: "deleted credential",
		storageIo: "Storage I/O",
		storageInputs: "Read from",
		storageOutputs: "Written to",
		templatedPath: "templated",
		playable: "playable",
		region: "Region",
		encoderVersion: "Encoder version",
		encodingMode: "Encoding mode",
		labels: "Labels",
		created: "Created",
		encodeDuration: "Encode duration",
		encoderStartup: "Encoder startup",
		template: "Template",
		templateRevBehind: "{name} (rev {launched} → now {current})",
		templateDeleted: "Template deleted (rev {rev})",
		loadFailed: "Failed to load the job.",
		loading: "Loading job",
		canceling: "Canceling…",
		manifests: "Manifests",
		copyManifestUrl: "Copy the {kind} manifest URL: {value}",
		copyManifestPath: "Copy the {kind} manifest path: {value}",
		play: "Play",
		vmafReports: "VMAF reports",
		measureVmaf: "Measure VMAF again",
		// QC gate panel .
		qcGateTitle: "QC gate",
		qcGateAwaiting: "Awaiting measurement",
		qcGateMeasurementFailed: "Measurement failed",
		qcGateNoVerdict: "No verdict",
		qcGateBlocking: "Blocks manifest generation on fail",
		qcGateMarkOnly: "Mark-only on fail (delivery proceeds)",
		qcGateAwaitingBody:
			"Encoding is complete. Manifest generation is held until the VMAF measurement produces a verdict.",
		qcGateMetric: "Metric",
		qcGateScope: "Scope",
		qcGateThreshold: "Threshold",
		qcGateTarget: "Target",
		qcGateActual: "Actual",
		qcGateResult: "Result",
		qcGateUnmeasured: "unmeasured",
		qcGateAllRenditions: "all renditions",
		qcGateViewReport: "View VMAF report",
		qcGateExportJson: "Report (JSON)",
		qcGateExportCsv: "Report (CSV)",
		qcGateExportHtml: "Printable report (HTML)",
		// Override-and-deliver .
		qcGateOverrideButton: "Deliver anyway",
		qcGateOverrideConfirm: "Confirm: deliver despite FAIL",
		qcGateOverriding: "Delivering…",
		qcGateOverridden: "Delivery was forced past a failing gate at {at}.",
		qcGateOverriddenNoVerdict:
			"Delivery was forced without a gate verdict at {at} (the measurement never completed).",
		qcGateOverrideFailed: "Override failed: {error}",
		viewReport: "View report →",
		stepTimeline: "Step timeline",
		stepLogUnavailable: "Step log unavailable for this job.",
		noResources: "No resources recorded for this job yet.",
		copyAsCurl: "Copy as cURL",
		resourceId: "resource id",
		requeuing: "Re-queuing…",
		retryResume: "Retry (resume)",
		creating: "Creating…",
		rerunAsNew: "Re-run as new job (retry)",
		copyAndEdit: "Copy settings and edit",
		retryFailed: "Retry failed",
		alreadyTerminal: "Job already finished or canceled.",
		auxConfigLabel: "{key} — full configuration",
		auxOutputs: "Thumbnails, sprites & keyframes",
		filterConfigLabel: "Filter {key} — configuration",
		keyframeInline: "at {time}s",
		keyframesHeading: "Keyframes",
		paramsCount: "{count} parameters",
		spriteInline: "stream {stream} · every {distance} {unit}",
		spritesHeading: "Sprites (trick play)",
		thumbnailInline:
			"stream {stream} · {height}p · {count} position(s) ({unit})",
		thumbnailsHeading: "Thumbnails",
	},
	encodingActions: {
		title: "Encoding actions (advanced)",
		lastStatus: "Last Bitmovin status",
		priority: "Scheduling priority",
		priorityShort: "Priority",
		priorityUpdated: "Priority updated.",
		applying: "Applying…",
		applyPriority: "Apply priority",
		moveToInfrastructure: "Move to infrastructure",
		infrastructure: "Infrastructure",
		pickInfrastructure: "Pick an infrastructure",
		infrastructureIdPlaceholder: "infrastructure id (UUID)",
		infrastructureIdHelp: "Enter the target infrastructure id (UUID)",
		moving: "Moving…",
		encodingMoved: "Encoding moved.",
	},
	storage: {
		title: "Storage Browser",
		locationPresets: "Location presets",
		selectCredential: "Select credential…",
		notBrowsableSuffix: " (cannot be browsed from this screen)",
		credential: "Credential",
		bucket: "Bucket",
		bucketAccessDenied:
			"This credential was refused for this bucket or container. It may be scoped to other buckets, or lack list permission on this one — the bucket LIST is account-wide, so a bucket can appear here and still be closed to this key. Pick another, or use a credential with access to this one.",
		credentialRejected:
			"The credential itself was rejected, not this bucket. Check the access key and secret (the form is write-only, so a mistyped secret cannot be read back), and check this machine's clock — a skew over 15 minutes is refused. Re-entering the credential is the usual fix.",
		bucketListDenied: "This credential cannot list buckets.",
		browseUnsupported:
			"This credential cannot browse storage from this screen. Enter the bucket and object path manually, or choose a browsable storage credential.",
		noAccess: "(no access with this credential)",
		findCredentialFor: "Find a credential that can open",
		searchingCredentials: "Trying your other credentials…",
		credentialCanOpen: "This credential can open it:",
		noCredentialCanOpen:
			"None of your other credentials can open this bucket either. It needs a key scoped to it.",
		noCredentialCanOpenTruncated:
			"None of the first few credentials tried can open this bucket; the search stopped at the cap rather than trying every one.",
		bucketName: "Bucket name",
		bucketNamePlaceholder: "bucket name",
		listingBuckets: "Listing buckets…",
		bucketListingUnavailable: "Bucket listing unavailable",
		noBucketsListed:
			"No buckets are listable with this credential — the account may have none, or this key's permissions hide them.",
		open: "Open",
		useCurrentPrefix: "Use current prefix as output",
		prefixBreadcrumb: "Prefix breadcrumb",
		credentialsLoadFailed: "Failed to load storage credentials.",
		loadMoreFailed: "Loading more failed —",
		tryAgain: "try again",
		listFailed: "Failed to list objects",
		presetSaveFailed: "Saving the preset failed",
		pickBucket: "Pick or enter a bucket to browse.",
		pickCredential: "Select a storage credential to start browsing.",
		size: "Size",
		modified: "Modified",
		useAsOutput: "Use as output",
		useAsInput: "Use as input",
		inspect: "Inspect",
		emptyPrefix: "Nothing here — empty prefix or filtered out.",
		filterByName: "Filter by name",
		filterByExtension: "Filter by extension",
		extPlaceholder: "ext (mp4)",
		loadingObjects: "Loading objects",
		searchPrefix: "Search this prefix…",
		filterInPrefix: "Filter in prefix…",
		loadMorePaged: "Load more (100/page)",
		selection: "Selection",
		input: "Input",
		output: "Output",
		saveAsPreset: "Save as location preset",
		presetLabelPlaceholder: "preset label",
		presetRole: "Preset role",
	},
	inspect: {
		requesting: "Requesting inspection…",
		probing: "Probing — reading a capped slice of the object…",
		container: "Container",
		bitrate: "Bitrate",
		streams: "Streams",
		rawJson: "Raw JSON (full ffprobe output)",
		requestFailed: "Requesting the inspection failed",
		inspecting: "Inspecting…",
		reinspect: "Re-inspect",
		historyTitle: "Inspection history ({count})",
		failed: "Inspection failed",
		codec: "Codec",
		profile: "Profile",
		resolution: "Resolution",
		channels: "Channels",
		sampleRate: "Sample rate",
		language: "Language",
	},
	qc: {
		measureAdvanced: "Measurement options",
		measureSource: "Measurement source",
		measureSourceAuto: "Automatic (use the job settings)",
		measureSourceMirror: "QC mirror",
		measureSourceMp4: "Existing MP4 outputs",
		measureSourceHint: "The selected job must have the chosen output type.",
		measurePsnr: "PSNR",
		measurePsnrInherit: "Use the job setting",
		measurePsnrOn: "Measure PSNR",
		measurePsnrOff: "Do not measure PSNR",
		measureMethod: "Measurement method",
		measureMethodDefault: "Standard",
		measureMethodFrameIndex: "Frame index · BT.709 · 10-bit",
		measureMethodHint:
			"Frame-index comparison requires cloud execution and existing MP4 outputs. Results use a different scoring generation.",
		measureSelectJob: "Select a finished job to measure.",
		measureJobsEmpty: "No finished jobs are available.",
		measureJobsLoadFailed: "Failed to load finished jobs.",
		measureSelectionMissing:
			"The selected job is no longer available. Choose another job.",
		measureProfileMissing:
			"The selected cloud profile is no longer available. Choose another execution target.",
		measureCreated: "Measurement created. View report",
		resultlessReports: "{count} reports contributed no renditions: {ids}",

		previewOpen: "Open comparison preview",
		previewClose: "Close comparison preview",
		previewA: "Rendition A",
		previewB: "Rendition B",
		previewNone: "None",
		previewFrame: "Selected frame",
		previewPrevious: "Previous frame",
		previewNext: "Next frame",
		previewPlay: "Play both",
		previewPause: "Pause both",
		previewTiming: "Measured frame {frame} · {fps} fps · {seconds}s",
		previewCaveat:
			"Fixed QC videos, without adaptive switching. Browser seeking approximates the measured frame time; FPS conversion and browser decoding may show a neighbouring frame. This is not frame-exact mpv playback.",
		previewUnavailable:
			"Comparison requires retained, version-identifiable VOD QC videos and the measured FPS. Older reports may not contain this information.",
		previewLiveUnavailable:
			"The measured Live capture was not retained. The current live stream cannot represent these frames.",
		previewFailed:
			"Playback failed. The QC video may be missing, replaced, or unsupported by this browser. Both previews have been paused.",
		previewLoading: "Loading comparison videos…",
		previewNoScore: "Not in the displayed score sample",
		measureExisting: "Measure an existing job…",
		measureJob: "Finished job",
		measureModel: "Model",
		measureRun: "Measure",
		cancelCloud: "Stop cloud measurement",
		cancelCloudTitle: "Stop this cloud measurement?",
		cancelCloudConfirm:
			"Stop “{name}”? The report is retained. Resource cleanup continues after cancellation; charges may continue until cleanup completes.",
		cancelCloudFailed: "Could not stop the cloud measurement.",
		computeTasks: "Cloud task status",
		computeScoringFrames: "Frames {done}/{total} ({percent}%)",
		computeStandard: "Standard VM",
		computeAttempt: "Attempt {attempt}",
		computeUpdated: "Updated {time}",
		computeStale: "Awaiting an update",
		computePhaseMANIFEST: "Preparing",
		computePhaseREFERENCE_DOWNLOAD: "Downloading reference",
		computePhaseDISTORTED_DOWNLOAD: "Downloading rendition",
		computePhaseMODEL_DOWNLOAD: "Downloading model",
		computePhaseREFERENCE_PROBE: "Checking reference",
		computePhaseDISTORTED_PROBE: "Checking rendition",
		computePhaseALIGNMENT: "Checking frame alignment",
		computePhaseSCORING: "Scoring",
		computePhaseRESULT_UPLOAD: "Saving results",
		computePhaseRECEIPT_UPLOAD: "Finalizing",
		computePhaseSTAGING: "Staging inputs",
		computePhaseQUEUED: "Waiting for compute",
		computePhaseRETRYING: "Retrying",
		computeReserved: "Reserved USD {amount}",
		computeCleaned: "Cleaned up",
		computeCleanupPending: "Cleanup pending",
		computeAttention: "Operator attention required",
		executionTarget: "Run on",
		executionLocal: "Local",
		executionBudget: "Budget (USD)",
		executionBudgetInvalid:
			"Enter a budget greater than 0 and no more than USD 100,000.",
		executionBudgetHint:
			"Cloud execution incurs charges. This budget covers the measurement across all outputs and controls whether tasks can start; it is not a guaranteed final bill.",
		executionLocalOnly:
			"No cloud profiles configured. Measurements run locally.",
		executionProfilesUnavailable:
			"Cloud profiles could not be loaded. Local execution is available.",
		executionCloudReport: "Cloud · {profile} · budget USD {budget}",
		staleScoringGeneration: "scoring gen {version} — understated",
		subsampledBadge: "every {stride}th frame — min is a sample",
		mixedScoringGenerations:
			"These reports were scored by different pipeline generations ({generations}), so their numbers are not comparable — generation 1 predates the 2026-08-11 timestamp fix and understates quality (one encode measured 23.08 then and 84.21 after). Re-run the older reports before reading this chart as a quality difference.",
		mixedModels:
			"These reports were scored with different VMAF models ({models}), so the chart overlays two viewing conditions rather than two encodes. A model is not a detail: measured on one identical pair, vmaf_v1.0.16_3d0h scored 83.01 and vmaf_v1.0.16_3d0h_2160 scored 92.44 — 9.4 points from the model alone. Compare reports that share a model, or read each curve on its own.",
		mixedSubsampling:
			"These reports were scored with different frame-sampling strides (n_subsample {strides}), so their minima are not comparable: a subsampled report's lowest score is the worst frame of a SAMPLE, while a full-precision report's is the worst frame there is. The pooled means stay close, which is what makes this easy to miss. Re-score at full precision before reading the minimum or the harmonic mean as a quality difference.",
		title: "VMAF Lab",
		compareSelected: "Compare selected",
		loadFailed: "Failed to load VMAF reports.",
		report: "Report",
		mode: "Mode",
		model: "Model",
		meanPerRendition: "Mean VMAF / rendition",
		deleteTitle: "Delete this VMAF report?",
		deleteConfirmMany:
			"Removes each report and all its frame-level results. This cannot be undone.",
		deleteConfirmOne:
			"Removes the report and all its frame-level results. This cannot be undone.",
		selectAllLoaded: "Select all loaded reports",
		waitToSelect: "Wait for the report to finish before selecting it",
		needTwoFinished: "Select at least two finished reports to compare",
		needOneTerminal: "Select at least one finished or errored report",
		erroredNotComparable: "Errored reports can be deleted but not compared",
		deleteFailed: "Delete failed",
		bulkDeleteFailed: "Bulk delete failed",
		loadMore: "Load more",
		backToLab: "Back to the VMAF Lab",
		pendingScore: "Pending",
		mayHaveBeenDeleted: " They may have been deleted. ",
		reportResourceLabel: "report {label}",
		noRenditionsToCompare:
			"The loaded reports have no rendition results to compare.",
		perFrame: "Per-frame VMAF",
		qualityLadder: "Quality ladder",
		compareReports: "Compare reports",
		all: "All",
		noneSelected: "None",
		loadingReports: "Loading reports",
		reportLoadFailed: "Failed to load the VMAF report.",
		reportTitle: "VMAF report",
		pseudoLiveAlignment: "Pseudo-live alignment",
		alignmentDiagnostics: "Alignment diagnostics",
		noRenditionResults: "This report finished with no rendition results.",
		loadingReport: "Loading VMAF report",
		windowedVmaf: "Windowed VMAF",
		pooledSummary: "Pooled summary",
		confidence: "Confidence",
		offsetFrames: "Offset (frames)",
		reasonZerosDominate:
			"{zeros} of {frames} frames scored below 1.0 ({percent}%) — that is not a quality measurement, it is misalignment, pathological input, or a ladder far outside the model's range",
		reasonZerosOrdinary:
			"{zeros} of {frames} frames below 1.0 ({percent}%) — within the ordinary range for hard cuts",
		reasonNoZeroFrames: "no frame scored below 1.0",
		reasonP25BelowOne:
			"the 25th percentile is below 1.0, so at least a quarter of the frames scored nothing — not a quality measurement",
		reasonHarmonicCollapsed:
			"the harmonic mean collapsed to 0 while the arithmetic mean did not, which means at least one frame scored zero and the aggregate is not comparable",
		reasonSound: "the distribution looks sound",
		reasonTooFewRungs: "fewer than two rungs carry a bitrate",
		reasonAllStepsMove: "every meaningful bitrate step moves the score",
		reasonFlatSteps: "bitrate steps that did not move the score: {steps}",
		comparisonUnknown: "Comparison terms unknown",
		hintHarmonicMean:
			"Harmonic mean (n ÷ Σ(1/score)). Penalises low-scoring frames harder than the plain mean — the standard VMAF aggregate for perceived quality.",
		hintLow1Percent:
			"VMAF 1% low: the mean of the worst 1% of frames. Sustained worst-case quality — what a viewer notices during the roughest stretch.",
		hintMean:
			"Arithmetic mean of every frame's VMAF score; higher is better. Usually 0–100, but not capped there — a model tuned for a larger display can exceed 100 on the same bytes, and the axis grows to fit rather than clipping. The headline 'average quality' number.",
		hintMinMax:
			"Lowest and highest single-frame VMAF scores across the whole clip.",
		hintPercentiles:
			"Percentiles of the sorted per-frame scores. p5 = only 5% of frames score below this; the low tail (p1/p5/p10) drives perceived quality more than the mean.",
		hintPsnr:
			"Peak signal-to-noise ratio in dB (Y plane) — a simpler fidelity metric than VMAF; higher is better, but it correlates less with perceived quality. Identical frames are capped at 100 dB.",
		hintWorstFrame:
			"The single lowest-scoring frame (its frame number + VMAF). The deepest dip in the clip — marked on the time-series chart.",
		hintAlignmentConfidence:
			"Alignment is best-effort to ±1 frame: B-frame reordering and encoder pipeline latency mean the matched output frame can be emitted one frame early/late. A one-frame-off alignment still yields a near-correct VMAF (adjacent frames are highly similar), but is not provably exact. Treat the offset as accurate to ±1 and gate on this confidence.",
		hintLoopMap:
			"The captured window mapped back onto the looping source. Each entry is one source-loop wrap: the output frame where it begins, the source frame it resumes from (0 except the first partial loop), and the loop index. A ≥3-loop capture yields ≥3 entries.",
		hintFrameOffset:
			"Recovered frame offset: source_index(i) = (i + offset) mod F. The phase of the looping source at the start of the captured window, refined to frame accuracy by cross-correlating per-frame signatures.",
		geometryUpscaled: "{rendition}p → {reference}p ({upscale}× upscale)",
		geometryNative: "{rendition}p → {reference}p (native)",
		summaryModelPart: " Model {model}.",
		summaryCrossResolution:
			"Cross-resolution VMAF: the {rendition}p rendition was upscaled {upscale}× and scored against the {reference}p source.{model} Low scores are expected for aggressive ladders and are not, on their own, an encoder defect.",
		summaryNative:
			"VMAF comparison: {rendition}p scored against a {reference}p source.{model} Low scores can reflect quality loss or comparison conditions. Check the reference, frame alignment and model before drawing conclusions.",
		summaryUnknownWithModel:
			"Scored with {model}. Source geometry unknown, so the comparison's terms cannot be stated.",
		summaryUnknownNoModel:
			"The comparison's terms are unknown: neither the rendition nor the source height was recorded.",
		degenerateBadge: "Not a quality measurement",
		ladderFlatBadge: "Ladder did not separate",
		coarseAnchor: "Coarse anchor",
		coarseFullSearch: "full search",
		loopOffsetMap: "Loop-offset map",
		loop: "Loop",
		outputFrameStart: "Output frame start",
		sourceFrameStart: "Source frame start",
		confidenceCaveat: "Alignment confidence caveat",
		alignmentUnverified:
			"Alignment unverified — these scores are diagnostic, not a verified quality measurement. Calculation complete does not confirm frame alignment.",
		alignmentExcludedFrames: "Confidence-excluded frames",
		alignmentMaskedFrames: "Loop-masked frames",
		frameOffset: "Frame offset",
		rendition: "Rendition",
		meanHint: "Mean — more information",
		harmonicHint: "Harmonic mean — more information",
		worstFrameHint: "Worst frame — more information",
		mean: "Mean",
		meanVmafSeries: "mean VMAF",
		harmonic: "Harm.",
		min: "Min",
		max: "Max",
		worstFrame: "Worst frame",
		psnrMin: "PSNR min",
		psnrMax: "PSNR max",
		noFrameData: "No per-frame data for this report.",
		hidePsnr: "Hide PSNR (dB)",
		showPsnr: "Show PSNR (dB)",
		noSeriesFrame:
			"No series selected — tick one or more above to plot the per-frame VMAF.",
		noSeriesData: "No per-frame data for the selected series.",
		noSeriesLadder:
			"No series selected — tick one or more above to plot the quality ladder.",
		scoreLegend:
			"Subjective-scale anchors: 20 ≈ bad · 40 ≈ poor · 60 ≈ fair · 80 ≈ good · 100 ≈ excellent",
		scoreLegendDisclaimer:
			"These are approximate anchors on a continuous scale, not interval boundaries or pass/fail criteria. Compare the same model and evaluation conditions, including display resolution and viewing distance. Some v1 models extend to 110.",
		sortBitrateAscending: "Sort by bitrate: low to high",
		sortBitrateDescending: "Sort by bitrate: high to low",
		startFrame: "Start frame",
		endFrame: "End frame",
		frameRangeCurrent: "Current frame range: {start}–{end}",
		frameRangeInvalid: "Start frame must not be greater than end frame.",
		frameRangeOutOfBounds: "Choose frames between {min} and {max}.",
	},
	notif: {
		deleteConfirm: "Delete notification channel “{name}”?",

		// Page-level heading (E2E 2026-08-14: the one screen without an h1).
		pageHeading: "Notifications",
		pageHeadingSub: "Outbound channels and which product events they receive.",
		addChannel: "Add a channel",
		attempts: "attempts",
		channelName: "Channel name",
		channels: "Channels",
		createChannel: "Create channel",
		createFailed: "Could not create the channel.",
		credential: "Webhook credential",
		disable: "Disable",
		disabled: "Disabled",
		enable: "Enable",
		enabled: "Enabled",
		eventKinds: "Event kinds",
		genericWebhook: "Generic webhook",
		kind: "Kind",
		labelFilter: "Label filter (optional)",
		labelFilterHint:
			"Comma-separated; the rule matches a job carrying ANY of these labels. Empty = all events of the selected kinds.",
		needsWebhookCredential:
			"No NOTIFICATION_WEBHOOK credential yet — create one under Settings → Credentials first (the URL is vault material).",
		noChannelsYet: "No channels yet.",
		noDeliveriesYet: "No deliveries yet.",
		recentDeliveries: "Recent deliveries (read from the queue)",
		selectCredential: "Select a credential…",
	},
	/** The release-evidence screen (re-audit 2026-08-29, HIGH-7 / GO 11). */
	verification: {
		heading: "Verification runs",
		caption:
			"One row per harness run: the code and schema it ran against, the source bytes it read, every scenario's verdict, and the seal over the report it produced.",
		loading: "Loading verification runs…",
		loadFailed: "Could not load the verification runs.",
		noRuns: "No verification run has been recorded yet.",
		colRun: "Run",
		colKind: "Tier",
		colStatus: "State",
		colStarted: "Started",
		colCommit: "Commit",
		colCounts: "Verdicts",
		notSealed: "not sealed",
		drift: "schema drift",
		backToList: "All verification runs",
		fingerprint: "Fingerprint",
		commit: "Commit",
		checkoutMigration: "Checkout migration",
		dbMigration: "Database migration",
		driftLabel: "Schema drift",
		driftYes: "Yes — the checkout and the database are on different migrations",
		driftNo: "No",
		startedAt: "Started",
		finishedAt: "Finished",
		baseUrlOrigin: "Product origin",
		actor: "Actor",
		account: "Bitmovin account",
		resumedFrom: "Resumed from",
		resumeDecision: "Resume decision",
		source: "Source",
		sourceObject: "Source object",
		sourceIdentity: "Source identity",
		sourceIdentityUnknown: "not recorded",
		scenarios: "Scenarios",
		noOutcomes: "This run recorded no scenario outcome.",
		colScenario: "Scenario",
		colVerdict: "Verdict",
		colReason: "Reason",
		colEncoding: "Encoding",
		colChecks: "Checks",
		colPlanSha: "Plan digest",
		providerReadback: "Provider readback",
		noProviderReadback:
			"Nothing was read back from the provider — this run abandoned no encoding.",
		cleanup: "Cleanup",
		noCleanup: "No job had to be driven to a terminal state.",
		providerTerminal: "provider terminal",
		viewJob: "Open the encoding job",
		seal: "Report seal",
		reportPath: "Report path",
		reportSha: "Report SHA-256",
		sealValue: "Seal",
		sealAlgorithm: "Seal algorithm",
		sealKeyId: "Seal key ID",
		evidenceVersion: "Evidence format version",
		retentionUntil: "Evidence retained until",
		sealedAt: "Sealed at",
		refreshFailed: "Could not refresh — showing the last loaded state.",
		lastUpdated: "Last updated",
		liveEvidence: "Live delivery evidence",
		noLiveEvidence:
			"No live evidence tuple was recorded — no live scenario in this run reached its samples.",
		evidenceComplete: "complete",
		evidenceIncomplete: "incomplete",
		evidenceAiring: "Airing",
		evidenceProbes: "Probes",
		evidenceMedia: "Media witnessed",
		evidenceProgression: "Progression",
		evidenceMissing: "Missing",
	},
	hevcV2: {
		mctf: "Motion compensated temporal filtering (MCTF)",
		mctfHelp:
			"Unset uses the provider default. OFF disables temporal filtering; AUTO and ON are explicit settings. This changes codec filtering, not Per-Title TargetQualityQP.",
		perceptualConfig: "Perceptual quality configuration",
		perceptualHelp:
			"Unset omits the entire configuration. With native HEVCv2 SMART_PASS, Unset uses CQP; selecting PERCEPTUAL_QUALITY_MODE switches rate control to PQP, even when perceptualEncodingMode is OFF. OFF requests perceptual encoding disabled; it does not restore CQP. These settings do not guarantee fewer low-quality frames.",
		perceptualEncodingMode: "Perceptual encoding mode",
		perceptualStrength: "Perceptual strength",
		perceptualPenaltyStrength: "Perceptual penalty strength",
		perceptualPenaltyKnee: "Perceptual penalty knee",
		perceptualTemporalStrength: "Perceptual temporal strength",
		pixelPerDegree: "Pixels per degree",
		unitRange: "Optional value from 0 to 1. Unset uses the provider default.",
		positiveRange: "Optional positive value. Unset uses the provider default.",

		advanced: "Advanced HEVCv2",
		bcfOverride: "BCF override",
		mixed:
			"HEVCv2 requires every video rung to use HEVCv2 and BCF override in Basics.",
		unavailable: "HEVCv2 is unavailable for the selected account.",
		jsonOnly:
			"Save this HEVCv2 plan as JSON. Template YAML export is unavailable.",
	},
	heartbeatWebhook: {
		slots:
			"The encoding already has five hooks. Other applications' hooks are preserved; Poll continues.",
		ambiguous:
			"The registration outcome is uncertain. Checking provider ownership before retry or cleanup; Poll continues.",
		providerFailed:
			"Provider registration failed. Check account permissions and connectivity; Poll continues.",
		budget: "Waiting for the next reconciliation budget; Poll continues.",
		modeLabel: "Registration mode",
		modeLegacy: "Legacy account-wide",
		title: "Heartbeat webhook cadence",
		intro:
			"Heartbeat is registered separately for each live encoding. Unsupported or unknown encoder versions use regular status checks. Changes apply to new runs; existing runs keep their interval.",
		intervalLabel: "Requested interval (seconds)",
		intervalHint:
			"1–{max}; 0 turns heartbeat off. Actual receipt intervals may differ.",
		effective: "Configured interval: {interval} s — {source}",
		effectiveOff: "Effective now: no hook registered — {source}",
		sourceGui: "set on this screen",
		sourceEnv: "from the deployment environment",
		sourceDefault: "the code default",
		envDefault: "Deployment default: {interval} s",
		envDefaultOff: "Deployment default: no hook",
		codeDefault:
			"The deployment environment sets nothing; the code default is {interval} s",
		save: "Save",
		reset: "Use the deployment default",
		saved:
			"Saved. The interval applies to new runs. Existing runs keep their interval.",
		resetDone: "Reverted to the deployment default.",
		loadFailed: "Failed to load the heartbeat cadence",
		invalid: "Whole numbers only: interval 0 or 1–{maxInterval}.",
	},
	usage: {
		loadedLabels: "{loaded} / {total} labels loaded",
		partialLabelSearch:
			"Search filters loaded labels. More labels are loading.",
		findExactLabel: "Find exact label",
		exactLabelMissing: "No label with this exact name.",
		labelCatalogHint:
			"Labels from Bitmovin; the list may be up to one minute old.",
		noLabels: "No labels available to select.",
		labelFilters: "Filter by label",
		searchLabels: "Find a label",
		noMatchingLabels: "No labels match your search.",
		clearLabel: "Clear label filter",
		label: "Encoding label",
		allLabels: "All encoding usage",
		labelSubtitle:
			"Encoding statistics for {label}, including usage outside this application.",
		labelHint:
			"Select one provider label. Label statistics combine VOD and Live, are read on demand for up to 90 days, and are not stored locally. Labels containing commas cannot be selected individually.",
		labelCombinedHint:
			"One encoding may carry several labels. This view shows only the selected label and does not sum overlapping labels. Live Units are unavailable in label statistics.",
		combined: "VOD + Live",
		labelsLoadFailed: "Could not load encoding labels",
		retryLabels: "Retry labels",
		labelIncomplete:
			"Label statistics have unavailable values for {count} day(s). Gaps and incomplete period totals are not shown as zero.",
		billableEgressTitle: "Billable transfer per day (GiB)",
		account: "Bitmovin account",
		noAccounts: "No Bitmovin account configured",
		fromDate: "From (UTC)",
		toDate: "To (UTC)",
		applyRange: "Show range",
		selectedRange: "Selected period: {from} — {to} (UTC)",
		autoQueued: "Waiting to update latest statistics",
		autoRunning: "Updating latest statistics",
		autoRetry: "Retry latest statistics",
		backfill: "Import statistics for this period",
		backfillHint:
			"Includes all encoding usage reported for this account, including jobs run outside this application. Existing statistics are refreshed.",
		backfillqueued: "Waiting to import",
		backfillrunning: "Importing",
		backfillcompleted: "Import complete",
		backfillfailed: "Import failed",
		backfillRows: "{count} daily records saved",
		backfillFailed: "Could not import statistics. Try again.",
		incomplete:
			"Statistics are missing for {count} day(s). Totals and trends include only the available data.",

		subtitle:
			"Account-wide encoding statistics from Bitmovin, including jobs run outside this application.",
		negativeMinutes:
			"The reported billable minutes include negative values. Review the breakdown; displayed values have not been adjusted.",
		minutesTitle: "Encoding minutes per day (billable)",
		breakdownTitle: "Codec × resolution",
		breakdownNote:
			"Encoding stream breakdown; feature and transmuxing minutes are separate.",
		classBreakdownNote:
			"SD, HD and UHD are provider resolution classes, not exact dimensions.",
		missingCodecRecords:
			"{count} records lack a codec breakdown; this table is incomplete.",
		otherApiValues: "Other API values",
		otherApiValuesNote:
			"Feature and transmuxing values are not added to encoding minutes. Negative values are preserved as reported; their meaning is not inferred.",
		featureMinutes: "Feature minutes",
		transmuxingMinutes: "Transmuxing minutes",
		liveUnits: "Live Units",
		notRetrieved: "Not retrieved",
		liveUnitsNote:
			"Live HD Units come from the separate Live options statistics API. Daily encoding minutes are a separate metric, not a Custom Live-only total, and are never converted into Units. Provider statistics may be revised after this read.",
		liveUnitsTitle: "Live HD units per day",
		liveMetric: "Live chart metric",
		liveMinutesMetric: "Live: encoding minutes (billable)",
		liveUnitsMissing:
			"Live HD Units are missing for {count} day(s) across the selected accounts. Gaps and the period total are not shown as zero.",
		rawTime: "timeEncoded (raw API value)",
		rawTimeNote:
			"The unit and aggregation meaning are unverified for timeEncoded. It is not displayed as output hours or used for billing calculations.",
		period7: "7 days",
		period30: "30 days",
		period90: "90 days",
		allAccounts: "All accounts",
		vod: "VOD",
		live: "Live",
		totalMinutes: "Encoding minutes (billable)",
		totalEncoded: "Output time (API-reported)",
		refreshedAt: "Statistics as of {time}",
		neverRefreshed:
			"Statistics have not been read yet for every account and kind — Bitmovin's daily statistics are read within a minute of startup and every 6 hours after that.",
		pendingDays:
			"{count} day(s) in this range are newer than the last read (Bitmovin settles daily totals late; the next read covers them).",
		loadFailed: "Failed to load usage",
		empty: "No usage in this period",
		emptyBreakdown:
			"No codec × resolution breakdown was returned for this period",
		bucket: "Bucket",
		codec: "Codec",
		resolution: "Resolution",
		minutes: "Billable minutes (API-reported)",
		encodedTime: "Output time (API-reported)",
		retentionNote:
			"Historical statistics are stored locally. Available history depends on the data returned by Bitmovin.",
	},
	pageTitles: {
		verification: "Verification runs",
		verificationRun: "Verification run",
		playerSettings: "Player settings",
		apiCoverage: "API coverage",
		features: "Features",
		reset: "Reset data",
		apiTokens: "API tokens",
		dashboard: "Dashboard",
		watchFolders: "Watch folders",
		notFound: "Page not found",
		notifications: "Notifications",
		signIn: "Sign in",
		setup: "First-boot setup",
		changePassword: "Change password",
		users: "Users",
		vodJobs: "VOD Jobs",
		vodJob: "VOD Job",
		newVodJob: "New VOD Job",
		liveChannels: "Live Channels",
		liveChannel: "Live Channel",
		newLiveChannel: "New Live Channel",
		pseudoLiveFeeds: "Pseudo-Live Feeds",
		feederSession: "Feeder Session",
		vmafLab: "VMAF Lab",
		vmafReport: "VMAF Report",
		compareVmafReports: "Compare VMAF Reports",
		storage: "Storage",
		presets: "Templates & presets",
		templates: "Templates",
		settings: "Settings",
		bitmovinAccounts: "Bitmovin accounts",
		// . The heading was renamed and this was not, so the tab
		// said "Storage credentials" over a page titled "Credentials" —
		// invisible to jsdom, which renders components and not metadata.
		storageCredentials: "Credentials",
		infrastructure: "Infrastructure",
		live: "Live",
		webhooks: "Webhooks",
	},
	lifecycle: {
		/* Lifecycle durations shown here must be measured and include their sample counts. */
		aria: "Encoder lifecycle",
		s1: "① Start requested",
		s1Hint:
			"Encoder not running. A manual start or the schedule's START row boots it.",
		s1ErrorHint:
			"Channel is in ERROR — the encoder may still be up on Bitmovin (Stop releases it). A start from here resumes provisioning.",
		// Use amber while provider status is unconfirmed. Once the provider confirms an encoding has ended,
		// the lifecycle hint must not imply that the encoder may still be running.
		providerUnknownHint:
			"Provider status cannot be confirmed — Bitmovin's status read for this run's encoding is failing (last confirmed {at}; unconfirmed since {since}). It is re-checked every 30 s. Stop remains available; start, restart, slate, SCTE-35, timeshift and new feeders wait for a fresh reading.",
		providerUnobservedHint:
			"Waiting for the first Bitmovin encoder status check. Until it arrives, this channel is not shown as confirmed on air.",
		providerUnknownNever: "never",
		providerTerminalHint:
			"Bitmovin reported this run's encoding {status} at {at} — the encoder is gone and cannot be restarted. Start the channel for a fresh run (new encoder, new ingest coordinates).",
		s2: "② Instance booting",
		s2Hint:
			"Bitmovin is provisioning the encoder instance. Startup time varies by region and configuration. View past measurements under Live in Settings. Input cannot be received yet.",
		s3: "③ Waiting for input",
		s3Hint:
			"The encoder is up and listening. Nothing is broadcast yet — slates and output need a CONNECTED input. Connect your feed (or a feeder); slate content can already be registered.",
		s4: "④ Input connected — encoding & delivering",
		s4Hint:
			"The pipeline is live: slates (蓋被せ) can be inserted from here on. On a running, fed channel a playback probe saw its first segment 31.8s in (n=1; connect-to-first-segment itself is unmeasured).",
		s7: "⑦ Stopped",
		s7Hint:
			"While stopping, wait for completion. An ended encoding cannot be restarted. After stopping, Start new run creates a new encoder. Register insertable content again for that run.",
	},
	live: {
		cancelStartFailed:
			"Start cancellation could not be requested. Please retry.",
		cancelStartAccepted: "Start cancellation requested.",
		cancelStartPending: "Cancelling start",
		cancelStart: "Cancel start",
		title: "Live Channels",
		providerStatusUnconfirmed: "{status} · Bitmovin status unconfirmed",
		newChannel: "New Live Channel",
		inventory: {
			title: "Live encoder inventory",
			hint: "Manual snapshot, not proof of ownership. Needs review includes untracked encoders and encoders on stopped channels; these may belong to other tools. Nothing is stopped automatically.",
			account: "Bitmovin account",
			select: "Select an account",
			check: "Check now",
			checking: "Checking…",
			unknown: "Not checked; count unknown",
			failed:
				"Check failed; count unknown. Retry, or ask an administrator to inspect larger inventories.",
			summary:
				"Needs review: {count} · Non-terminal: {running} · Untracked: {unexplained} · Terminal-channel mismatch: {contradicted} · Provisioning: {inFlight}",
			checked: "Checked at:",
		},
		actions: "Actions",
		loadFailed: "Failed to load live channels.",
		encodingId: "Encoding id",
		emptyHint: "No live channels yet — create one with “New Live Channel”.",
		stopBeforeDeleting: "Stop the channel before deleting",
		deleteConfirm:
			"Removes the channel, its feeder sessions, heartbeats and live VMAF reports. The Bitmovin encoding (if any) is left untouched. This cannot be undone.",
		deleteNamed: "Delete “{name}”?",
		deleteTitle: "Delete this channel?",
		deleteFailed: "Delete failed",
		loadMore: "Load more",
		// Live-list columns, filters and sorting let operators compare channels without opening each detail page.
		list: {
			health: "Health",
			nextEvent: "Next event",
			runtime: "Runtime",
			filter: "Show",
			filterAll: "All",
			filterActive: "Active",
			filterError: "Needs attention",
			filterErrorHint:
				"Needs attention is wider than the ERROR status: it also covers every anomaly the Health column shows — an open alert, a heartbeat that stopped answering, a failed feeder, or an output that stopped advancing.",
			filterSoon: "Scheduled soon",
			sort: "Sort",
			sortAnomaly: "Anomalies first",
			sortCreated: "Newest first",
			searchPlaceholder: "Filter by name",
			scopeNote:
				"Filtering and sorting apply to the {count} channels loaded so far — load more to include the rest.",
			matchNone: "No channel matches this filter.",
			rowMenu: "Actions for {name}",
			openChannel: "Open channel",
			countdownDue: "due now",
			countdownIn: "in {duration}",
			elapsed: "{duration} elapsed",
			remaining: "{duration} to cap",
			noCap: "no runtime cap",
			capExceeded: "past its runtime cap",
			outputAdvancing: "Advancing",
			lastOutput: "Last output",
			outputAdvanced: "Advancement observed",
			outputStalled: "Stalled",
			outputEnded: "Ended (ENDLIST)",
			outputUnobserved: "Not observed",
			feederLabel: "Feeder",
			feederErrors: "{count} failed",
		},
		channelLoadFailed: "Failed to load the live channel.",
		loadingChannel: "Loading live channel",
		// Primary labels describe input and monitoring tasks; heartbeat names the collection mechanism.
		ingestCoordinates: "Input endpoint",
		planUnavailableHints: "Plan unavailable — cannot derive connection hints.",
		heartbeat: "Input & encoder state",
		history: "History",
		ladder: "Ladder",
		lastRun: "Last broadcast",
		push: {
			pollOnly: "Regular status checks only (encoder unsupported)",
			perEncoding: "Per encoding + customData",
			pendingVersion:
				"Waiting for a supported resolved version (Poll continues)",
			actualVersion: "Resolved encoder version",
			registration: "Webhook registration",
			registered: "Registered (receipt checked separately)",
			notRegistered: "Not registered; Poll continues",
			retired: "Registration retired",
			title: "Signed Push telemetry",
			receiving: "Sample updated recently",
			unavailable: "Reception unavailable",
			never: "No usable Push sample",
			stale: "No recent sample update",
			clockSkew: "Check the reception clock",
			ended: "Historical reception",
			receivedAt: "Displayed sample first received",
			sampledAt: "Provider sample time",
			observedCadence: "Interval between distinct-sample receipts",
			configuredCadence: "Current interval setting (not measured)",
			off: "OFF",
			sampleInput: "Input state in sample",
			boundary:
				"Distinct signature-verified samples. Push takes priority when both receipt and sample are within 90 seconds; otherwise recent Poll is used. Receipt time is the displayed sample's first receipt. A foreground RUNNING page refreshes about every 15 seconds.",
			sampleFresh:
				"The provider sample is recent. Receiving Push alone does not prove successful playback.",
			sampleStale: "Provider sample is stale; not current input health.",
			sampleUnknown:
				"Sample time is unknown; current input health cannot be confirmed.",
			sampleSkew:
				"Provider sample time is in the future; current input health cannot be confirmed.",
			sampleHistorical: "Historical sample, not current input health.",
		},
		/** Stream health (2026-08-23): the three-layer at-a-glance answer. */
		health: {
			diagnosis: {
				ENDED: "Historical record of an ended broadcast.",
				UNKNOWN:
					"Current input health is unconfirmed. Check notification reception and the input source.",
				INPUT_WAITING:
					"Waiting for input. Check the sender's destination and start sending.",
				INPUT_LOST:
					"Input loss or an input error detected. Check the sender and network.",
				OUTPUT_STALLED: "Output updates have stalled. Check output details.",
				OUTPUT_UNKNOWN:
					"Input connection confirmed; output updates are unconfirmed.",
				PUSH_UNAVAILABLE:
					"No recent Push update; displaying Poll. This does not mean the broadcast stopped.",
				HEALTHY:
					"Input connection and output updates confirmed, not a guarantee of viewer playback.",
			},
			source: "Evidence: {source}",
			qualityTitle: "Input quality: {count} observations",
			qualityHint:
				"Input heuristics only. Average frame rate and maximum GOP cover the last minute; these do not validate output settings.",
			packetStalled:
				"Input {streamIndex} ({mediaType}): no packet for {ageSeconds}s. Check the sender.",
			rateLow:
				"Video input {streamIndex}: average {actualFps} fps / declared {declaredFps} fps. Check sender load and frame drops.",
			gopLong:
				"Video input {streamIndex}: maximum GOP {maximumMs} ms. Check the sender's keyframe interval.",
			packetGrowth:
				"Dropped or corrupt packets increased by {count} since the previous sample. Check the sender and network.",
			panelTitle: "Delivery status",
			sources:
				"Recent Push takes priority, with Poll fallback. Output monitoring is independent. Historical state lines follow Push where it was received and Poll elsewhere; alert counts remain Poll-based.",
			ingestDetails: "Input details",
			lastSeen: "Last seen {when}",
			laneAlerts: "Open alerts: {count}",
			laneAlertsUnknown: "Open alerts: Unknown",
			ended: "Ended",
			starting: "Starting",
			encoderIp: "Encoder IP",
			region: "Region",
			latestWarning: "Latest warning",
			noWarning: "No warnings",
			outputNotObserved: "Not observed yet",
			edgeDelayMax: "Maximum edge delay",
			seconds: "{s}s",
			toManifests: "Playback links",
			droppedCounts: "Total {total} (+{delta} since last sample)",
			ingest: "Input",
			encoder: "Encoder",
			output: "Output",
			ok: "Healthy",
			down: "Not detected",
			unobservable: "Not measurable (no HLS)",
			stale:
				"No Poll status sample within 90 seconds. This is separate from Push reception or a broadcast stopping.",
			timelineTitle: "Broadcast timeline",
			stateHistory: "Observed states",
			stateHistoryDescription:
				"Observed input, encoder and output states follow. Unchanged intermediate samples are omitted. Unobserved times are not inferred.",
			stateHistoryEmpty: "No state observations are available.",
			eventStartRequested: "Start requested",
			eventQueued: "Queued",
			eventRunning: "Encoder running",
			eventInputConnected: "Input connected",
			eventInputDisconnected: "Input disconnected",
			eventInputReconnected: "Input reconnected",
			timelineSources: "Connection events: Push / state lines: Poll",
			timelineSourcesPush:
				"Connection events: Push / state lines: Push where received, Poll elsewhere",
			pushLanesTruncated:
				"Only the most recent Push receipts drew the state lines; earlier stretches are drawn from Poll.",
			pushCoverage:
				"Push events include up to 100 events from the latest 300 receipts, not a complete history or proof of video reflection.",
			pushTruncated:
				"Showing recent notifications and events. Find earlier records in the receipt log.",
			pushLogLink: "Go to Push receipt log",
			eventOutputActive: "Output active",
			eventContentInserted: "Content insertion scheduled",
			eventContentStopped: "Content stop requested",
			eventStopped: "Encoder stopped",
			actionsTruncated:
				"Not every content action is shown — only the first 100 are.",
			eventScte35: "SCTE-35 cue",
			eventEsam: "ESAM signal",
			eventStopRequested: "Stop requested",
			eventRestartRequested: "Restart requested",
			eventTimeshiftReset: "Timeshift reset",
			startup: "Encoder startup time: {duration}",
			startingElapsed: "Encoder starting — {duration} elapsed",
			loading: "Loading stream health…",
			loadFailed: "Could not load stream health.",
			noData: "No Poll status samples for this broadcast yet.",
			truncated:
				"Timeline shows the last 24 hours of samples; earlier samples were cut off.",
		},
		ladderVideo: "Video renditions",
		ladderAudio: "Audio renditions",
		ladderOther: "Other renditions",
		ladderKey: "Key",
		ladderCodec: "Codec",
		ladderHeight: "Height",
		ladderBitrate: "Bitrate",
		ladderDetail: "Parameters",
		ladderParams: "{count} parameters",
		ladderParamsLabel: "Rendition {key} — full parameters",
		planUnavailableLadder:
			"The stored plan does not parse, so the ladder cannot be shown.",
		dvr: "DVR / timeshift",
		planUnavailableDvr: "Plan unavailable — DVR windows unknown.",
		// A file input is an upstream feature, separate from an AWS Input resource.
		feeders: "File input (pseudo-live)",
		contentInsertion: "Content insertion",
		dnsMappings: "DNS mappings",
		liveToVod: "Live-to-VOD",
		vmafCapture: "VMAF capture",
		stepTimeline: "Step timeline",
		stepLogUnavailable: "Step log unavailable for this channel.",
		// This section lists slate reservations rather than confirming what is on air. Keep its section key stable.
		slateNow: "Slate reservations",
		advanced: "Duplicate & template",
		dangerZone: "Delete this channel",
		dangerZoneLead:
			"Deleting removes the channel and its feeder sessions, heartbeats and live VMAF reports. The Bitmovin encoding is left alone.",
		cueNeedsRunning:
			"SCTE-35 cues can only be inserted into a RUNNING channel.",
		manifestUrlsDisclose: "Show every manifest URL",
		manifestUrlsDiscloseClose: "Hide manifest URLs",
		// Name the operator task; the provider encoder is a secondary detail.
		start: "Start channel",
		startNewRun: "Start a new run",
		//  — the Akamai MSL output editor in the live wizard's
		// output step. Bitmovin authenticates the MSL output resource with the
		// account API key rather than a storage credential, and MSL takes four
		// required fields of its own, so the step offers a destination choice
		// rather than deriving the kind from whichever credential was picked.
		// (Our plan DOES carry an AKAMAI_MSL credential — the provisioned
		// stream id and event name are vault material since 2026-08-19.)
		outputDestination: "Destination",
		destinationStorage: "Object storage",
		destinationAkamaiMsl: "Akamai MSL",
		outputDestinationHelp:
			"Object storage writes segments to a bucket you hold credentials for. Akamai MSL delivers straight to a stream Akamai has provisioned for you.",
		mslStreamId: "Stream ID",
		mslStreamIdHelp: "The numeric stream id Akamai issued for this event.",
		mslEventName: "Event name",
		mslEventNameHelp: "The Akamai event name, exactly as provisioned.",
		mslStreamFormat: "Stream format",
		mslStreamFormatHelp:
			"This constrains the encoding, not just the label: DASH needs fMP4 segments and a DASH manifest, HLS needs TS segments and an HLS manifest, CMAF needs fMP4 and both manifests. The plan preview reports any mismatch before you submit.",
		mslVersion: "MSL protocol version",
		mslVersionHelp:
			"MSL5 requires encoder 2.283.0 or newer and uses a different segment-naming grammar, which this app derives for you. MSL4 stays the default until its EOL 2026-12-31. The Digest publishing credentials on the AKAMAI_MSL credential apply to MSL5 only — Bitmovin rejects them on an MSL4 output.",
		startResume: "Start channel (resume)",
		stop: "Stop channel",
		restart: "Restart channel",
		// Failure-toast labels use noun forms while action buttons use verb phrases.
		actionLabelStart: "Channel start",
		actionLabelStop: "Channel stop",
		actionLabelRestart: "Channel restart",
		actionLabelResetTimeshift: "Timeshift reset",
		actionLabelScte35: "SCTE-35 cue insertion",
		actionRejected: "{label} rejected: {message}",
		actionFailed: "{label} failed: {message}",
		actionFailedGeneric:
			"{label} failed. Refresh the page and try again; contact an administrator if it continues.",
		actionReasonUnknown:
			"The request could not be completed. Refresh the page and try again; if it still fails, contact an administrator.",
		errorDetails: "Error details",
		recordedFailure:
			"The live operation encountered a problem. Check the activity history and current channel state, then retry if appropriate.",
		actionAccepted: "{label} accepted.",
		duplicate: "Copy settings and edit",
		stopChannelTitle: "Stop the channel?",
		stopChannelBody:
			"Stops the channel's live encoding. Attached file-input sessions are stopped with it. Viewers lose the stream.",
		stopChannel: "Stop channel",
		restartChannelTitle: "Restart the channel?",
		restartChannelBody:
			"Restarts the running encoding — the stream is interrupted while the encoder comes back up.",
		restartChannel: "Restart channel",
		insertCue: "Insert SCTE-35 cue",
		cueDuration: "Cue duration (s)",
		cueEnqueued: "SCTE-35 cue enqueued.",
		sending: "Sending…",
		insertCueShort: "Insert cue",
		manifestsAllHint: "Manifests (none selected = all manifests)",
		channelWord: "channel",
	},
	heartbeat: {
		stream: "Stream",
		type: "Type",
		codec: "Codec",
		resolution: "Resolution",
		rate: "Rate",
		bitrate: "Bitrate",
		keyframeAvg: "Keyframe avg (ms)",
		keyframeMax: "Keyframe max (ms)",
		keyframeLastMinute: "Keyframe last min. avg / max (ms)",
		noStreamDetails: "No per-stream details in the latest sample.",
		events: "Events",
		droppedVideo: "Dropped video",
		droppedAudio: "Dropped audio",
		corruptVideo: "Corrupt video",
		corruptAudio: "Corrupt audio",
		noHistory:
			"No heartbeat history yet — the chart fills in as the 30s sweep runs.",
		loadingHistory: "Loading heartbeat history",
	},
	pushLog: {
		title: "Push heartbeat receipts",
		hint: "Newest received first; one row per verified receipt, including retries. Historical provider snapshots, not current health or playback proof. Details include only allowed telemetry fields; Poll history and export are separate below.",
		sampledAt: "Provider sample time",
		receivedAt: "App receipt time",
		auto: "Latest receipts refresh every 2 seconds while this running log is open in the foreground.",
		paused:
			"Automatic refresh paused: closed, ended, historical, older page, or background.",
		inspecting:
			"Refresh paused while inspecting details. Close all details to resume.",
		details: "Details",
		empty: "No verified Push receipts are stored for this run.",
		older: "Older receipts",
		latest: "Latest receipts",
		retry: "Retry",
		current: "Current run (follow restarts)",
		poll: "Poll history and export (approximately 30-second samples)",
	},
	heartbeatLog: {
		title: "Heartbeat log",
		summary: "Push receipts and separate Poll history by run",
		run: "Run",
		operatorOnly: "The heartbeat log is available to operators.",
		noRuns: "This channel has not run yet, so there is no heartbeat log.",
		loading: "Loading the heartbeat log…",
		empty: "No heartbeat samples are kept for this run.",
		eventsTitle: "Encoder events (as of the newest sample)",
		noEvents: "The encoder has reported no events for this run.",
		export: "Export JSON (admin)",
		summaryLine:
			"Poll history summary: {samples} samples · input connected {connectedMinutes} min · {warnings} warning/error events (Push receipts shown separately)",
		rowsPruned: "samples pruned before the summary",
		time: "Time",
		ingest: "Input",
		incomingMbps: "In Mbps",
		fps: "fps",
		keyframe: "Keyframe avg / max (ms)",
		packets: "Dropped V/A · corrupt V/A",
		manifestAge: "Manifest age (s)",
		segmentMean: "Segment mean (ms)",
		events: "Events",
		raw: "Raw",
		rawToggle: "JSON",
		rowsLoaded: "{count} rows loaded",
		loadMore: "Load more",
		columnsHint:
			"In Mbps and fps are the first video stream's measured incomingBitrate and rate; keyframe figures are keyFrameIntervalAvg / Max; manifest age is the poll time minus the newest HLS manifest update; events list only what appeared at that poll. Open JSON for every provider field.",
	},
	dvr: {
		resetTitle: "Reset timeshift (RUNNING only)",
		resetEnqueued:
			"Reset enqueued — it is applied to the running encoding shortly.",
		residualPeriod: "Residual period (s)",
		offsetSeconds: "Offset (s)",
		resetting: "Resetting…",
		reset: "Reset timeshift",
	},
	feeder: {
		pickChannel: "Channel",
		title: "File input (pseudo-live)",
		loadFailed: "Failed to load feeder sessions.",
		session: "Session",
		channel: "Channel",
		protocol: "Protocol",
		source: "Source",
		started: "Started",
		stop: "Stop",
		noSessions: "No feeder sessions for this channel yet.",
		browseStorage: "Browse storage…",
		rtmpPush: "RTMP push",
		srtCaller: "SRT Caller",
		noPassphrase: "No passphrase",
		sourceObject: "Input file (MP4)",
		pickViaBrowse: "Pick via Browse storage…",
		rtmpUrl: "RTMP URL",
		rtmpUrlPlaceholder: "rtmp://<encoder-ip>/live",
		streamKey: "Stream key",
		srtHost: "SRT host",
		srtPort: "SRT port",
		passphraseCredential: "Passphrase credential",
		hideForm: "Hide form",
		revealFill: "Reveal key & fill",
		revealing: "Revealing…",
		showKey: "Show key",
		hideKey: "Hide key",
		inputDestinationPreparing: "The input destination is being prepared.",
		keyContextUnavailable:
			"The stream-key context is not available. Check the channel's Bitmovin account, or wait for input provisioning to complete.",
		revealNone:
			"No stream key is assigned to this encoding yet — it appears once the channel is RUNNING.",
		revealFailed: "Could not reveal the stream key.",
		revealMultiple:
			"Multiple keys are assigned to this encoding (primary + backup points) — pick and reveal the right one in Settings \u2192 Live \u2192 Stream keys.",
		staticKeyHint:
			"Static ingest takes the ASSIGNED key's revealed value — the plan's own key is refused.",
		newSession: "Start file input",
		// : ffmpeg pushed healthily for 9.5 minutes into a session the
		// encoder never bound. The worker now recycles such pushes on its own.
		// : PUSHING with no heartbeat to confirm it is unconfirmed, not
		// healthy — the badge used to read the absence of information as PUSHING.
		pushingUnconfirmed:
			"A feeder reports PUSHING, but the channel has no recent heartbeat to confirm the encoder is receiving it. Treat the push as unconfirmed until a heartbeat arrives.",
		pushingNotBound:
			"A feeder is pushing but the encoder has not bound any input. It retries with a fresh connection automatically; if this persists, check the ingest coordinates and the source file, or stop and recreate the feeder.",
		inputConfirmed:
			"Input confirmed — the live encoder reports that it is receiving this file input.",
		prefilledFromEncoderIp:
			"Prefilled from the channel's encoder IP — editable",
		encoderIpUnknownRunning:
			"Encoder IP unknown until the channel is RUNNING — fill manually or wait",
		prefilledFromEncoderIpShort: "Prefilled from the channel's encoder IP",
		encoderIpUnknown: "Encoder IP unknown until RUNNING",
		prefilledFromSrtPort: "Prefilled from the channel's SRT listener port",
		srtPortRange: "Bitmovin SRT listener ports are 2088–2091",
		creating: "Creating…",
		startSession: "Start file input",
		// : the immediate switch is two-phase, like the scheduled one.
		switchFromActive: "Switch from the active feeder (stage first, then swap)",
		switchFromActiveHint:
			"The new source is downloaded, probed and checked against the running feed before anything stops. The active feeder is stopped only once the new one is ready, and the new push starts after the old one is confirmed gone — dead air is preferred over two pushes at one ingest.",
		switchSession: "Stage and switch",
		phaseStaging: "staging",
		phaseReady: "ready — holding for the switch",
		stopBeforeDeleting: "Stop the session before deleting",
		deleteTitle: "Delete this feeder session?",
		deleteConfirm:
			"Removes the session and its log tail and loop boundaries. A running push is not touched. This cannot be undone.",
		stopTitle: "Stop feeder session?",
		stopBody:
			"Stops the push (stop request → 5s grace → forced termination). Sessions are one-shot — to feed again, create a new session.",
		stopSession: "Stop session",
		detailLoadFailed: "Failed to load the feeder session.",
		loadingSession: "Loading feeder session",
		sessionWord: "file-input session",
		sessionDetailTitle: "File input session",
		detailLead:
			"Review the saved MP4 being repeated into this live channel, its input destination and its current state.",
		inputDestination: "Input destination",
		technicalInformation: "Technical information",
		resourceId: "Resource ID",
		channelResourceId: "Live channel ID",
		diagnostics: "Diagnostics",
		diagnosticsLead:
			"Operational details available to administrators and support.",
		diagnosticsLoading: "Loading diagnostics…",
		diagnosticsLoadFailed: "Could not load diagnostics.",
		ownerHost: "Execution host",
		processId: "Process identifier",
		processGoneAt: "Exit confirmed at",
		recordedFailure: "Recorded failure",
		notAvailable: "Not available",
		internalFailure:
			"The file input could not continue. Ask an administrator to review Diagnostics.",
		timing: "Timing",
		loop: "Loop",
		wallClock: "Wall clock",
		streamTime: "Stream time (s)",
		noLogLines: "No log lines yet.",
	},
	// #259: localize typed attributes/planned normalization; preserve values and legacy prose.
	mediaDifference: {
		videoStream: "video stream",
		videoCodec: "video codec",
		resolution: "resolution",
		frameRate: "frame rate",
		h264Profile: "H.264 profile",
		h264Level: "H.264 level",
		pixelFormat: "pixel format",
		audioStreams: "audio streams",
		audioCodec: "audio codec",
		audioSampleRate: "audio sample rate",
		audioChannels: "audio channels",
		videoPosition: "video stream position",
		container: "container",
		kind: "media kind",
		unknown: "Unknown attribute",
		present: "present",
		absent: "absent",
		willReencode: " (will be re-encoded to match)",
	},
	feederError: {
		ingestUnsatisfied:
			"Source cannot satisfy the channel's ingest: {detail}. The encoder would accept the connection and publish nothing.",
		sourceMismatch:
			"Source does not match what this channel is ingesting ({origin}) — the encoder would warn on the attribute change and drop the input, leaving the playlist advancing on a frozen picture:\n{differences}",
		slatePosition:
			"Slate clip does not match the live stream: Bitmovin requires the video stream at stream position 0, and this file carries {found} there. The content would register as READY and then fail at insert time.",
		slateMismatch:
			"Slate clip does not match the live stream, so the insert would fail at air time even though the content registers as READY:\n{differences}",
		// C36: stills are admitted since ; renders only for rows refused before that.
		slateImage:
			"The still-image slate could not be registered. Use a JPG or PNG and set a display duration when inserting.",
		// What a `sourceMismatch` was compared against — interpolated into its
		// sentence as `{origin}`.
		origin: {
			runSource: "the source this run started on",
			heartbeat: "the encoder's last heartbeat",
		},
	},
	contentInsertion: {
		feedbackAccepted: "Reservation request accepted",
		feedbackIdentity: "Content {contentId} · Reservation {reservationId}",
		feedbackProvider: "Reservation response status: {status}",
		feedbackUnconfirmed: "Content appearance is unconfirmed.",
		feedbackOutputAdvancing:
			"{source}: output updates observed; inserted content is not verified.",
		feedbackOutputNotAdvancing:
			"{source}: output updates unconfirmed; this does not establish insertion failure.",
		feedbackOutputUnknown: "Current output updates are unconfirmed.",
		feedbackPreview: "Check in preview",
		needsRunning: "Content insertion needs a RUNNING channel.",
		stopped: "Stop request accepted.",
		registered: "Registered content",
		schedule: "Schedule",
		noneRegistered: "No content registered on this encoding yet.",
		register: "Register content",
		scheduled: "Scheduled",
		deschedule: "Cancel reservation",
		descheduleNamed:
			"Cancel reservation for {name}, scheduled for {runAt} (reservation ID {scheduledId})",
		nothingScheduled: "No reservations.",
		slateLead:
			"The content-insertion reservations for this channel. “Reserved” does not mean the content is currently inserted.",
		requirementsHint: "Content insertion requirements — more information",
		loadingInsertable: "Loading insertable content",
		runAt: "Run at (blank = run immediately)",
		runAtInvalid: "Enter a valid run time.",
		durationSeconds: "Duration (s)",
		nameOptional: "Name (optional)",
		namePlaceholder: "brb-slate",
		inputPath: "Input path",
		inputPathPlaceholder: "/slates/brb.mp4",
		inputId: "Input id",
		loadingScheduled: "Loading reservations",
		stopSending: "Sending stop request…",
		requestFailed: "Request failed",
		scheduling: "Scheduling…",
		registering: "Registering…",
		// Slate reservations use operator-facing status words; raw provider codes stay in technical details.
		runAsap: "Run immediately",
		reservationDuration: "{seconds} s",
		statusCreated: "Registering",
		statusScheduled: "Reserved",
		statusToBeDescheduled: "Cancelling",
		statusDescheduled: "Cancelled",
		statusError: "Reservation error",
		statusUnknown: "Reservation status unknown",
		technicalDisclose: "Show technical details",
		technicalDiscloseClose: "Hide technical details",
		technicalLead:
			"The reservation rows as Bitmovin returned them. The status is Bitmovin's reservation status; it carries no playback state.",
		// The emergency stop — its own Operations section, apart from the list.
		stopTitle: "Emergency stop: inserted content",
		stopLead:
			"An emergency operation: stops the inserted content that is playing and returns the channel to the live input. Future reservations are not cancelled — cancel those under Slate reservations.",
		stopAction:
			"Stop the playing inserted content and return to the live input",
		stopConfirmTitle: "Stop the inserted content that is playing?",
		stopConfirmBody:
			"This sends a request to stop the inserted content and return the channel to the live input. Future reservations stay as they are. If nothing is playing, the request fails.",
		stopConfirm: "Stop and return to the live input",
		stopNeedsRunning:
			"This operation is available only while the channel is running.",
		// C36 (WP-A1/A2): pick the file, check it against the live stream,
		// then register. READY means registered, not playable.
		readyMeansRegistered:
			"READY means Bitmovin has registered the file, not that it matches the stream. The compatibility check before registering is what decides that.",
		registerLead:
			"Pick the clip in storage, check it against the live stream, then register. Bitmovin downloads it from the storage; nothing is uploaded through this app.",
		sourceFile: "Source file",
		sourceFileHelp:
			"A movie file whose video is at stream position 0 and matches the live stream's codec, resolution and frame rate, with the same number of audio streams at the same sample rate and channel count. JPG/PNG stills are accepted too: a still plays silent, letterboxed on black, and needs a display duration when inserted. Bitmovin does not check this until the insertion runs; the check here does.",
		checkCompatibility: "Check compatibility",
		checking: "Checking…",
		registerNeedsCheck: "Run the compatibility check first.",
		preflightPending:
			"Inspecting the file — a bounded read plus ffprobe. This usually takes a few seconds.",
		verdictOk: "Compatible with the live stream.",
		verdictIncompatible:
			"Not compatible with the live stream — registering is disabled. The insertion would fail at air time.",
		verdictUnverified:
			"Could not be verified. You may register, but the insertion is not guaranteed to play.",
		standDownNoIngestReference:
			"The channel has no ingest reference yet — no heartbeat and no recorded source to compare against.",
		standDownNoProbe: "The inspection recorded no stream data for this file.",
		standDownNoCredential:
			"No vaulted storage credential can read this object, so it was not probed.",
		standDownInputUnresolved:
			"The Bitmovin input could not be resolved to a storage bucket, so the file was not probed.",
		standDownInspectionFailed:
			"The file's inspection failed; open it in the storage browser's Inspect for the reason.",
		standDownNoComparableAttribute:
			"The channel's ingest reference carries no attribute this file can be compared on, so nothing was verified.",
		comparedOn: "Compared on: {compared}.",
		notComparable:
			"Not comparable from this channel's reference: {attributes}.",
		leadingSlashStripped:
			"The leading slash was removed: the file is registered as {path}.",
		imageNotice:
			"This is a still image: it plays silent, letterboxed on black. Set a display duration when inserting.",
		differencesTitle: "Differences from the live stream",
		differenceBlocking: "blocks",
		differenceReported: "reported only",
		advancedOpen: "Advanced: register by Bitmovin input id",
		advancedClose: "Hide advanced",
		advancedLead:
			"For content on an input this app does not vault. The same compatibility check runs; when nothing can probe the file it stands down and says so.",
		// : a picked file is converted to match the live input before
		// registration; the verdict says what will happen, not "refused".
		prepImage:
			"This is a still image; it registers as it is. It plays silent, letterboxed on black, and needs a display duration when inserting.",
		prepAsIs: "An MPEG-TS matching the live input; it registers as it is.",
		prepNormalize:
			"It will be converted to an MPEG-TS matching the live input before registration (adjusted: {reasons}).",
		prepWait:
			"The live input is not connected yet. Once registered, the file is converted and registered automatically when the input connects.",
		prepRefused: "Cannot be registered. Check the file.",
		prepRefusedUnprobed:
			"Cannot be registered: the file could not be probed, so nothing is known about it.",
		prepRefusedNoContainer:
			"Cannot be registered: the file is not readable as a movie or a still image.",
		prepRefusedNoVideo:
			"Cannot be registered: the file has no video stream (a slate must be a movie or a still image).",
		prepRefusedInspection:
			"Cannot be registered: the file's inspection failed. Open it in the storage browser's Inspect for the reason.",
		differenceConverted: "fixed by conversion",
		prepDestinationOutput:
			"The converted file is written to the channel's output storage, {location}/ (no write access to the source location is needed).",
		prepDestinationSource:
			"This channel has no S3-family output storage, so the converted file is written next to the source, {location}/ — the source location must be writable.",
		normalizationAccepted:
			'Conversion started. Progress shows under "Converting and registering"; the file appears in registered content when done.',
		normalizationAcceptedWaiting:
			'Accepted. The file is converted and registered automatically once the live input connects; progress shows under "Converting and registering".',
		normalizationsTitle: "Converting and registering",
		normalizationsLead:
			"Files being converted to match the live input and registered. Finished files move to registered content; a failure shows its reason.",
		normStatusWaiting: "Waiting for input",
		normStatusQueued: "Queued",
		normStatusNormalizing: "Converting",
		normStatusRegistering: "Registering",
		normStatusReady: "Registered",
		normStatusError: "Failed",
		normFailed:
			"Conversion or registration failed. Check the file and register it again.",
	},
	esam: {
		matchTimeInvalid: "Enter a valid match time.",
		needsRunning:
			"ESAM media points can only be inserted into a RUNNING channel.",
		title: "Insert ESAM media point",
		signals: "Signals (at least one)",
		addSignal: "Add signal",
		hint: "ESAM media points — more information",
		matchTime: "Match time (optional)",
		offset: "Offset",
		insertFailed:
			"Insertion failed. Check the input and channel state, then try again.",
		inserting: "Inserting…",
		insert: "Insert media point",
	},
	liveToVod: {
		stopFirst: "Stop the channel first — live-to-VOD publishes a ",
		complete: "complete",
		manifests: "Manifests",
		needManifest: "Select at least one manifest family.",
		noSupportedFamily:
			"No VOD manifest can be generated for this recording format.",
		lastRun: "Last run:",
		destination: "Destination:",
		finishedAtSuffix: " · finished {at}",
		refreshSuffix: " · refresh to see progress",
		manifestPath: "Manifest path",
		manifestPathPlaceholder: "output/my-channel",
		startFailed: "Could not start live-to-VOD",
		startUnsupportedFamily:
			"The selected manifest cannot be generated from this recording format. Change the selection and try again.",
		startInvalidPath:
			"Choose the recording folder itself or one of its parent folders for the manifest path.",
		startAlreadyRunning: "Live-to-VOD generation is already in progress.",
		startNotStopped:
			"Stop the channel first so the complete recording can be published.",
		generating: "Generating…",
		publish: "Publish as VOD",
		families: "Manifest families",
		partialHint:
			"One manifest family finished and another failed. Publishing again generates only the failed family — the finished manifests are kept.",
		statusRunning: "Generating",
		statusFinished: "Complete",
		statusPartial: "Partially complete",
		statusError: "Failed",
		familyStatusPending: "Waiting",
		familyStatusCreated: "Ready to generate",
		familyStatusRunning: "Generating",
		familyStatusFinished: "Generated",
		familyStatusError: "Failed",
		familyStatusUnsupported: "Not supported",
		unsupportedFamily:
			"This recording format does not support {family} manifest generation.",
		errorEnqueue:
			"The generation request was not accepted. Wait a moment and try again.",
		errorQueueUnknown:
			"The request status could not be confirmed. Refresh the page before trying again.",
		errorProvider:
			"The manifest generation status could not be confirmed. Please try again.",
		errorCleanup:
			"The previously generated manifest could not be confirmed as removed. Contact an administrator before retrying.",
		errorInvalidRecord:
			"The previous generation result is incomplete. Contact an administrator.",
		technicalDetails: "Technical details (administrators)",
	},
	dns: {
		needsRunning: "DNS mappings are shown while the channel is RUNNING.",
		loading: "Loading DNS mappings",
		hostname: "DNS hostname",
	},
	captureVmaf: {
		invalidWindow: "Enter a whole number from 10 to 600 seconds.",
		needsRunning: "VMAF capture is available while the channel is RUNNING.",
		window: "Capture window (s)",
		failed:
			"Capture failed. Check the channel and output state, then try again.",
		starting: "Starting…",
		capture: "Capture VMAF",
	},
	subtitles: {
		dashboard:
			"Operational overview — encodings, live channels, failures, queue depth and recent VMAF reports. Every card links into its detail view.",
		vodJobs: "Create encodings and follow their progress and results.",
		liveChannels:
			"Start live channels, watch their inputs and outputs, schedule actions and stop them.",
		feeders:
			"Repeatedly sends a stored MP4 and uses it as input to a live channel. It is not an AWS Elemental MediaLive Input resource.",
		vmafLab:
			"Quality reports scored with VMAF and PSNR. Mean, 1% low, percentiles and a per-frame time series per rendition.",
	},
	empty: {
		noVmafReports:
			"No VMAF reports yet — enable VMAF on a VOD job and its report appears here once it finishes.",
		noFeederSessions:
			"No file-input sessions yet. Choose Start file input to send a stored MP4 to a live channel.",
	},
	prose: {
		storageIntro:
			"Explore buckets with the credentials from Settings → Credentials: verify access, copy URIs, and save ",
		storageCredentialsHint: "Add or check them in Settings → Credentials.",
		inspectBounded:
			"The preview is bounded on purpose: it reads a capped head and, at most, one capped retry slice — never the whole object. A container whose index sits at the END of the file (a non-faststart MP4) is therefore out of reach here. Re-mux it with",
		noHeartbeatSample:
			"No heartbeat sample yet — every RUNNING channel is polled on a 30s sweep.",
		heartbeatDeltas:
			"Deltas are per 30s poll; the encoder's counters are cumulative since encoding start (lifetime totals shown underneath). The first poll after a start reports zero deltas by design.",
		noConnectEvents:
			"No connect/disconnect events in the latest heartbeat — a healthy stream reports none after the initial connect.",
		captureVmafIntro:
			"Capture the recent output window and score it against the looping feeder source with libvmaf. The pseudo-live alignment engine recovers the loop offset, reports a confidence, and flags drift — the report opens when the run starts.",
		captureVmafNoFeeder:
			"No attached pseudo-live feeder — VMAF capture needs the looping source MP4 as the reference. Start a feeder session first.",
		deliveryMirrorPathsFollowPrimary:
			"A mirror writes the SAME files to the SAME paths as the primary output — only the bucket differs. There is no separate prefix to set: the plan records a mirror as an output reference, and every file is copied to it at the path the primary already uses. Change the primary output's folder and the mirrors follow it.",
		esamNoAccount:
			"This channel has no Bitmovin account attached — ESAM insertion is unavailable.",
		esamIntro:
			"Inserts a pre-built SCTE-35 payload (SCTE-250 / ESAM) into the running stream. The encoding must have been started with",
		contentNoAccount:
			"This channel has no Bitmovin account attached — content insertion is unavailable.",
		contentIntro:
			"Registered media Bitmovin can cut into the live stream. Movie files must match the live stream's codec, resolution and framerate, and carry the same number of audio streams with the same sample format, channel count and sample rate.",
		contentLoadFailed: "Failed to load registered content",
		scheduleLoadFailed: "Failed to load the schedule",
		dvrNoManifestIds:
			"No provisioned manifest ids in the step log yet — the reset applies to all manifests.",
		cueNoManifestIds:
			"No provisioned manifest ids in the step log — the cue goes to all manifests.",
		dnsLoadFailed: "Failed to load DNS mappings",
		dnsNoMapping:
			"No DNS mapping for this encoding — point your contribution encoder at the ingest coordinates above, or create a mapping in Settings → Live.",
		noLoopBoundaries:
			"No loop boundaries recorded yet — the first one lands when the source wraps.",
		vmafRunning:
			"VMAF running… frame scores appear here once the libvmaf pipeline finishes.",
		noLadderMetadata:
			"No bitrate/height metadata on these renditions — ladder view unavailable.",
		noLadderMetadataSelected:
			"No bitrate/height metadata on the selected renditions — ladder view unavailable.",
		noReportsLoaded: "None of the requested reports could be loaded",
		noSavedPresets:
			"No saved presets yet — build a plan in the wizard and use “Save as preset” to store it here.",
		presetGalleryIntro:
			"Ready-made samples of common delivery setups — check the credentials, input paths and destinations before using one. Loading one prefills the wizard form when the form can represent it, or opens imported-plan mode with a placeholder checklist for the advanced scenarios.",
		noEncodingYet:
			"This job has no Bitmovin encoding yet — the runtime actions become available once the encoding is created.",
		lastStatusExplainer:
			"The last state observed for this encoding. TRANSFER_ERROR means the encoding finished but its outputs did not upload — the transfer alone cannot be retried, so the recovery is a re-run.",
		noAccountAttached:
			"This job has no Bitmovin account attached — re-attach one to list infrastructures.",
	},
	settings: {
		basic: "Basic settings",
		basicCaption:
			"Language, theme, Bitmovin accounts, playback, features and notifications.",
		aReservedKeyCanBeRe:
			"A reserved key can be re-used across live encodings, so your",
		aStaticIpIsAttachedWhen:
			"A static IP is attached when a LIVE encoding is created (Encoding.staticIpId) — manage the address lifecycle here, pick it in",
		accessKey: "Access key",
		acquireEncoding: "Acquire encoding",
		acquiredEncoding: "Acquired encoding",
		acquiring: "Acquiring…",
		addAccount: "Add account",
		addBitmovinAccount: "Add Bitmovin account",
		addCredential: "Add credential",
		addDnsMapping: "Add DNS mapping",
		addId: "Add id",
		addMapping: "Add mapping",
		addOneFirst: "Add one first",
		addPoolIdManually: "Add pool id manually",
		addRegionSettings: "Add region settings",
		addS3AkamaiOciGcsAzure:
			"Add S3 / Akamai / OCI / GCS / Azure credentials to browse buckets and create Bitmovin inputs & outputs.",
		addSchedule: "Add schedule",
		addYourBitmovinApiKeyTo:
			"Add your Bitmovin API key to start creating encodings.",
		addYourFirstAccount: "Add your first account",
		addYourFirstCredential: "Add your first credential",
		adding: "Adding…",
		advancedLegacyStaticAccessKeysDeprecated:
			"Advanced (legacy) — static access keys, deprecated by Bitmovin",
		apiKey: "API key",
		apiKeyWriteOnlyOrgId:
			"API key (write-only), org id, encoder version pin, default regions, test connection.",
		apiKeysAreEncryptedAtRest:
			"API keys are encrypted at rest and used server-side only.",
		apiToken: "API token",
		apiTokensCaption:
			"Bearer machine credentials for scripts and CI — minted here, shown once",
		awsAccountNumber: "AWS account number",
		bitmovinAccount: "Bitmovin account",
		bitmovinAccounts: "Bitmovin accounts",
		bitmovinAllocatesTheAddressAsynchronouslyIt:
			"Bitmovin allocates the address asynchronously — it appears with status CREATING first.",
		bitmovinApiAuditLog: "Bitmovin API audit log",
		bitmovinNotificationReceiverAutoRegistrationOn:
			"The endpoint that receives Bitmovin notifications. Check delivery status, signature verification and recent events here.",
		bitmovinNotificationReceiverSignatureVerificatio:
			"Bitmovin notification receiver, signature verification status, recent deliveries, API audit log.",
		clearErrorEncodings: "Clear error encodings",
		cloudConnect: "Cloud Connect",
		cloudConnectAccountsCannotBeEdited:
			"Cloud Connect accounts cannot be edited — the Bitmovin API has no update call. To change one, delete it and re-create it.",
		cloudConnectAwsGceAzureAkamai:
			"Cloud Connect (AWS / GCE / Azure / Akamai / OCI) with region settings, static IPs for live ingest, prewarmed encoder pools with start/stop schedules.",
		cloudConnectBringYourOwnCloud:
			"Cloud Connect (bring-your-own cloud), static IPs for live ingest and prewarmed encoder pools — proxied server-side; cloud secrets pass through to Bitmovin and are never stored here.",
		cloudRegion: "Cloud region",
		compartmentOcid: "Compartment OCID",
		copyTheseIntoYourContributionEncoder:
			"Copy these into your contribution encoder. Adopting this encoding as a managed channel in this app is not built yet.",
		couldNotListPools: "Could not list pools",
		createAPoolOfPreStarted:
			"Create a pool of pre-started live encodings for instant go-live.",
		createAPoolOfStandingEncoders:
			"Create a pool of standing encoders to cut encoding start latency.",
		createAccount: "Create account",
		createCredential: "Create credential",
		createPool: "Create pool",
		createPrewarmedEncoderPool: "Create prewarmed encoder pool",
		createStandbyPool: "Create standby pool",
		creating: "Creating…",
		credentialsMode: "Credentials mode",
		credentialsPassThroughToBitmovinThis:
			"Credentials pass through to Bitmovin — this app never stores them.",
		defaultCloudRegion: "Default cloud region",
		diskSize: "Disk size",
		dnsHostname: "DNS hostname",
		dnsMappings: "DNS mappings",
		dnsMappingsMoreInformation: "DNS mappings — more information",
		dynamicPoolGrowsOnDemandCapped:
			"Dynamic pool — grows on demand, capped at 10 instances",
		editBitmovinAccount: "Edit Bitmovin account",
		editCredential: "Edit credential",
		emailPrivateKeyProject: "Email + private key + project",
		encoderVersion: "Encoder version",
		encodingId: "Encoding id",
		encodingTemplate: "Encoding template",
		encodingsEventLogAndAcquire: "Encodings, event log and acquire.",
		encodingsKeptPreStartedSoA:
			"Encodings kept pre-started so a channel can go live in seconds.",
		encryptedAtRestAes256Gcm:
			"Everything the encoder authenticates with — storage, DRM, live ingest and integrations. Encrypted at rest (AES-256-GCM). Secrets are write-only: they can be replaced but never read back. Verify access and browse buckets in Library → Storage.",
		failedToLoadAccounts: "Failed to load accounts",
		failedToLoadBitmovinAccounts: "Failed to load Bitmovin accounts",
		failedToLoadCredentials: "Failed to load credentials",
		failedToLoadDeliveries: "Failed to load deliveries.",
		failedToLoadDnsMappings: "Failed to load DNS mappings",
		failedToLoadEncodings: "Failed to load encodings",
		failedToLoadPools: "Failed to load pools",
		failedToLoadRegionSettings: "Failed to load region settings",
		failedToLoadSchedules: "Failed to load schedules",
		failedToLoadStandbyPools: "Failed to load standby pools",
		failedToLoadStaticIps: "Failed to load static IPs",
		failedToLoadStreamKeys: "Failed to load stream keys",
		failedToLoadTheAuditLog: "Failed to load the audit log.",
		failedToLoadTheEventLog: "Failed to load the event log",
		failedToLoadThePayload: "Failed to load the payload.",
		freesEveryKeyHeldByOne:
			"Frees EVERY key held by one encoding — release is scoped by encoding, not by key.",
		giveALiveEncoderAStable:
			"Give a live encoder a stable hostname so a contribution encoder does",
		gpuInstances: "GPU instances",
		iamRoleName: "IAM role name",
		invalidDate: "Invalid date",
		leaveTheValueBlankAndBitmovin:
			"Leave the value blank and Bitmovin generates a secure random key — the recommended path.",
		loadMore: "Load more",
		loading: "Loading…",
		loadingAccounts: "Loading accounts",
		loadingBitmovinAccounts: "Loading Bitmovin accounts",
		loadingCloudConnectAccounts: "Loading Cloud Connect accounts",
		loadingCredentials: "Loading credentials",
		loadingDnsMappings: "Loading DNS mappings",
		loadingPoolDetails: "Loading pool details",
		loadingPoolEventLog: "Loading pool event log",
		loadingPools: "Loading pools",
		loadingPrewarmedPools: "Loading prewarmed pools",
		loadingRegionSettings: "Loading region settings",
		loadingSchedules: "Loading schedules",
		loadingStandbyEncodings: "Loading standby encodings",
		loadingStandbyPools: "Loading standby pools",
		loadingStaticIps: "Loading static IPs",
		loadingStreamKeys: "Loading stream keys",
		main: "main",
		manifestUrl: "manifest URL",
		mapASubdomainOntoARunning: "Map a subdomain onto a running live encoding.",
		noApiCallsRecordedYetTry:
			"No API calls recorded yet — try “Test connection” on a Bitmovin account.",
		noBitmovinAccountsYet: "No Bitmovin accounts yet",
		noCredentialsYet: "No credentials yet",
		noDeliveriesYetWebhookEventsAppear:
			"No deliveries yet — webhook events appear here as Bitmovin sends them.",
		noDnsMappingsYet: "No DNS mappings yet",
		noEventsLogged: "No events logged.",
		noPoolsInThisAccountCreate:
			"No pools in this account — create one under Settings → Infrastructure, or paste an id below.",
		noPrewarmedPoolsYet: "No prewarmed pools yet",
		noRegionSettingsYet: "No region settings yet.",
		noSchedulesYet: "No schedules yet.",
		noStandbyEncodingsInThisPool: "No standby encodings in this pool.",
		noStandbyPoolsYet: "No standby pools yet",
		noStaticIpsYet: "No static IPs yet",
		noStreamKeysYet: "No stream keys yet",
		notificationsCaption:
			"Slack / generic webhooks per event kind, with label filters",
		ocid1CompartmentOc1: "ocid1.compartment.oc1..",
		ocid1TenancyOc1: "ocid1.tenancy.oc1..",
		poolsBillWhileStartedScheduleStops:
			"Pools bill while STARTED — schedule stops for idle hours.",
		preWarmedPoolIds: "Pre-warmed pool IDs",
		prewarmedPools: "Prewarmed pools",
		privateKey: "Private key",
		projectId: "Project id",
		recentDeliveries: "Recent deliveries",
		regionSettings: "Region settings",
		regionSettingsHaveNoUpdateApi:
			"Region settings have no update API — to change one, delete it and re-create it.",
		replaceSecretMaterial: "Replace secret material",
		requestAFixedIngestAddressFor:
			"Request a fixed ingest address for live encodings.",
		requestFailed: "Request failed",
		requestIp: "Request IP",
		requestStaticIp: "Request static IP",
		requesting: "Requesting…",
		reserveAKeyToGiveA:
			"Reserve a key to give a contribution encoder a stable ingest credential.",
		reserveKey: "Reserve key",
		ingestPointWord: "Ingest point",
		reserveStreamKey: "Reserve stream key",
		reservedStreamKeysCreateDeleteUnassign:
			"Reserved stream keys (create / delete / unassign), DNS ingest hostnames, and standby pools with acquire — account-level live resources.",
		reservedStreamKeysDnsIngestHostnames:
			"Reserved stream keys, DNS ingest hostnames and standby pools — account-level live resources that outlive any single channel.",
		reserving: "Reserving…",
		resourceGroupId: "Resource group id",
		revealKey: "Reveal key",
		rotateApiKey: "Rotate API key",
		s3CompatEndpoint: "S3-compat endpoint:",
		mslEdgeCandidateLegend: "MSL4 delivery URL candidate",
		mslEdgeCandidateExplain:
			"Type the Akamai hostname you were given and pick the stream format; the candidate is built from the stream ID and event name above and never guessed. MSL5: paste the Akamai Control Center value into the field above instead.",
		mslEdgeCandidateHost: "Akamai hostname",
		mslEdgeCandidateFormat: "Stream format",
		mslEdgeCandidateFill: "Fill candidate",
		mslEdgeCandidatePreview: "Candidate:",
		s3S3RoleGenericS3Akamai:
			"S3 / S3 role / Generic S3 (Akamai, OCI presets) / GCS HMAC / GCS service account / Azure — encrypted at rest.",
		saveChanges: "Save changes",
		saveTheAccountFirstToPick:
			"Save the account first to pick from its pools — or paste pool ids below.",
		saving: "Saving…",
		secretFieldsAreEncryptedWithThe:
			"Secret fields are encrypted with the server MASTER_KEY before they reach the database.",
		secretKey: "Secret key",
		secretMaterialWriteOnlyAes256:
			"Secret material — write-only, AES-256-GCM encrypted at rest",
		serviceAccountEmail: "Service account email",
		serviceAccountJson: "Service account JSON",
		standbyPools: "Standby pools",
		standbyPoolsMoreInformation: "Standby pools — more information",
		standingEncoderInstancesThatSkipStartup:
			"Standing encoder instances that skip startup queueing. Reference a pool from Settings → Bitmovin accounts (default pre-warmed pool ids) or per encoding.",
		standingEncodersBillWhileThePool:
			"Standing encoders bill while the pool exists — size it to your real go-live concurrency.",
		starting: "Starting…",
		staticIpUsageMoreInformation: "Static IP usage — more information",
		staticIps: "Static IPs",
		stopping: "Stopping…",
		// : renamed from "Storage credentials". The screen has
		// always held DRM, live-ingest and integration secrets too, and a title
		// that contradicts its contents teaches operators to distrust the labels.
		storageCredentials: "Credentials",
		groupStorage: "Storage",
		groupDrm: "DRM",
		groupLiveIngest: "Live ingest",
		groupIntegration: "Integrations",
		streamKey: "stream key",
		streamKeys: "Stream keys",
		streamKeysMoreInformation: "Stream keys — more information",
		streamUrl: "stream URL",
		subscriptionId: "Subscription id",
		targetPoolSize: "Target pool size",
		templateUnavailableNotDecodableText:
			"Template unavailable (not decodable text).",
		tenancyOcid: "Tenancy OCID",
		tenantId: "Tenant id",
		testConnection: "Test connection",
		testing: "Testing…",
		theApiKeyIsEncryptedWith:
			"The API key is encrypted with the server MASTER_KEY before it reaches the database.",
		theMappingBelongsToOneLive:
			"The mapping belongs to one live encoding — Bitmovin has no account-level create.",
		timedStartStopActionsUtcBitmovin:
			"Timed START/STOP actions (UTC; Bitmovin ignores the seconds).",
		triggerTime: "Trigger time",
		unassignByEncoding: "Unassign by encoding",
		unassignStreamKeys: "Unassign stream keys",
		unassigning: "Unassigning…",
		webhookEventsAreReceivedAndVerified:
			"Webhook events are received and verified for diagnostics. Job and channel status is driven by polling — webhook-driven dispatch is not enabled.",
		webhookPayload: "Webhook payload",
		workspaceConfiguration: "Workspace configuration.",
	},
	apiCoverage: {
		requestFields: {
			title: "SDK request-body properties",
			scopeNotice:
				"SDK-declared body-model properties, counted at the top level per operation. Models also share response attributes, so not every property is writable.",
			assignmentNotice:
				"Direct property evidence means a property name is visible in an object literal or model constructed directly for an SDK call. This includes optional or undefined values and does not prove GUI access or actual transmission. Spreads, variables, helpers and union bodies are not followed. Unconfirmed does not mean unimplemented.",
			bodyOperations: "Operations with a request body",
			expandedOperations: "Operations with expanded bodies",
			unexpandedOperations: "Operations with unexpanded bodies",
			totalFields: "Top-level properties per operation",
			sourceAssigned: "Direct property evidence",
			unconfirmed: "Unconfirmed properties",
			searchLabel: "Search request properties",
			searchPlaceholder: "property, type, model, API or source…",
			property: "Property / type",
			model: "Body model",
			sdkDeclaration: "SDK declaration",
			noMatches: "No request properties match this search.",
			unexpandedTitle: "Bodies that could not be expanded",
			unexpandedReason: "Reason",
			unknownReason: "No expanded model is available.",
			arrayReason: "The request body is an array.",
			unknownBodyReason: "No concrete body type is declared.",
			unionReason: "The body accepts several possible types.",
			dictionaryReason: "The body uses arbitrary property names.",
			unsupportedReason:
				"This body type is outside the current extraction scope.",
			noUnexpanded: "No unexpanded bodies match this search.",
			previousFields: "Previous request properties page",
			nextFields: "Next request properties page",
			previousBodies: "Previous unexpanded bodies page",
			nextBodies: "Next unexpanded bodies page",
		},
		currentNotice:
			"SDK Encoding API operations matched to current source calls; not execution or paid validation. Dynamic calls may remain unconfirmed, so unconfirmed does not mean unimplemented.",
		sourceConfirmed: "Source-confirmed",
		unconfirmed: "Unconfirmed",
		confirmedOperations: "Operations with source calls",
		confirmedCreates: "SDK create methods with source calls",
		currentProvenance:
			"Generated: {date} · Source commit: {repo} · Source fingerprint: {source} · SDK: {sdk} · SDK fingerprint: {sdkFingerprint} · Scope: Encoding API",
		sdkMatches: "SDK versions match. This does not establish runtime success.",
		sourceEvidence: "Source evidence",
		sdkMethod: "SDK method",
		parameterSnapshotTitle: "Reference: historical parameter survey",
		parameterSnapshotNotice:
			"Parameter classifications have not been refreshed. These are historical references, separate from current configurability and the latest operation census.",
		parameterProvenance: "Survey date: {date} · SDK: {sdk}",
		historicalNotice:
			"Historical survey snapshot. These figures do not establish current API coverage, availability, execution verification, or paid validation.",
		noMatches: "No endpoints match these filters.",
		loading: "Loading the coverage census…",
		loadFailed: "Loading the coverage census failed",
		staleWarning:
			"The installed SDK ({installed}) differs from the surveyed SDK ({surveyed}). This snapshot has not been refreshed for the SDK update.",
		sdkVersion: "Installed SDK",
		surveyedAgainst: "surveyed SDK: {version}",
		operationsImplemented: "Operations implemented",
		createOperations: "Create operations",
		paramsReachable: "Parameters operator-reachable",
		provenance:
			"Survey date: {date} · Survey commit: {repo}. Confirm current availability in the relevant feature screen.",
		byFamily: "Operations by family",
		family: "Family",
		total: "Total",
		implemented: "Implemented",
		substituted: "Substituted",
		notImplemented: "Not implemented",
		share: "Share",
		paramsByFamily: "Parameters by family (implemented families)",
		paramsLegend:
			"wizard/advanced = form controls · raw-JSON = whole-plan import only · auto-derived = the compiler decides · not settable = absent from the plan schema, unreachable by any route",
		fields: "Fields",
		autoDerived: "Auto/fixed",
		notSettable: "Not settable",
		endpoints: "All endpoints",
		searchLabel: "Search endpoints",
		searchPlaceholder: "path, SDK method or evidence…",
		allFamilies: "All families",
		allStates: "All states",
		matchCount: "{n} matching",
		endpoint: "Endpoint",
		operation: "Operation",
		state: "State",
		channel: "Channel",
		note: "Note",
		prev: "Prev",
		next: "Next",
	},
	settingsBuild: {
		title: "Web build serving this page",
		scope:
			"This Web only. These values do not identify the worker, another Web service, or the Bitmovin encoder version.",
		version: "App version",
		commit: "Commit",
		unknown: "Unknown",
	},
	settingsX: {
		users: "Users",
		usersCaption: "Per-user accounts and roles (ADMIN)",
		resetQueuesUnreachable:
			"The data reset completed, but some pending processing could not be cleared. Contact your system administrator or support team before starting new work.",
		features: "Features",
		player: "Player & Analytics",
		apiCoverage: "API coverage",
		apiCoverageCaption:
			"Review the latest source census of API operations and evidence, with the historical parameter survey kept separate.",
		groupAccess: "Authentication and access",
		groupDiagnostics: "Operations",
		groupDiagnosticsCaption:
			"Review supported encoding features and delivery-verification history.",
		verificationCaption: "Results of delivery-verification runs",
		playerCaption:
			"Choose the player used for VOD and Live previews. Bitmovin Analytics is available only with Bitmovin Player.",
		playerLoadFailed: "Could not load the player settings.",
		playerProvider: "Preview player",
		playerProviderHint:
			"hls.js / Shaka Player needs no licence. Bitmovin Player requires a licence key.",
		playerProviderNative: "hls.js / Shaka Player (default)",
		playerProviderBitmovin: "Bitmovin Player (licence key required)",
		playerOpenSourceHint:
			"Open-source previews do not send data to Bitmovin Analytics.",
		playerLicenseKey: "Player licence key",
		publicClientKeyHint:
			"Public client key: sent to the browser by design, domain-locked at Bitmovin.",
		analyticsLicenseKey: "Analytics licence key",
		analyticsKeyHint:
			"Used only with Bitmovin Player. Use a separate key from production so QA impressions never mix into audience data.",
		playerSaveFailed: "Saving the player settings failed.",
		playerSaved:
			"Saved. The preview uses the new settings on the next page load.",
		featuresCaption:
			"Turn optional parts of the platform on or off for this deployment.",
		featureQcVmaf: "VMAF lab and QC",
		featureQcVmafHint:
			"Off by default. When off, the VMAF lab, the wizard's QC gate editor and the per-job QC surfaces are hidden, no new measurements are created, and a plan carrying a qc block is refused. Jobs already parked or failed under an existing gate stay releasable — their QC panel, override and evidence export keep working.",
		featuresLoadFailed: "Could not load the feature settings.",
		featuresSavedReloadHint:
			"Saved. Reload the page for the navigation and the wizard to pick it up.",
		featuresReload: "Reload now",
		reset: "Reset data",
		resetCaption:
			"Choose the data and settings to delete. Related work is canceled and cleaned up automatically. This cannot be undone.",
		resetDeletes: "Selected for deletion: {count} records",
		resetSelectAll: "Select all",
		resetSelectNone: "Select none",
		resetAuditReceiptNote:
			"Existing operation history is deleted; a new record of this reset is kept.",
		resetOrganizationOnly:
			"This resets only the current organization. User accounts, memberships, other organizations, and platform settings are kept.",
		resetSelectionKept:
			"Unchecked categories are kept, along with stored media and environment files (.env). Information needed to stop delivery is retained temporarily until cleanup finishes.",
		resetDependenciesAdded: "Related categories also selected: {categories}.",
		resetDependenciesRemoved:
			"Dependent categories also unchecked: {categories}.",
		resetDeletedCounts: "Deleted records",
		resetSetupRequired:
			"User accounts were deleted. Open setup to create a new administrator. Reload the page if setup does not open.",
		resetOpenSetup: "Open setup",
		resetDeleteContentLibrary: "Content library",
		resetDeleteChannelAlertRules: "Channel-specific alert rules",
		resetDeleteAlertRules: "Global alert rules",
		resetDeleteWebhookRegistrations: "Webhook registrations",
		resetDeleteVerificationHistory: "Delivery verification history",
		resetDeleteWatchFolders: "Watch folders",
		resetDeleteNotificationRules: "Notification rules",
		resetDeleteNotificationChannels: "Notification destinations",
		resetDeleteStoragePresets: "Storage locations",
		resetDeletePresets: "Presets",
		resetDeleteUsageStatistics: "Usage statistics",
		resetDeleteBitmovinAccounts: "Bitmovin accounts",
		resetDeleteCredentials: "Credentials",
		resetDeleteApiTokens: "API tokens",
		resetDeleteApplicationSettings: "Application settings",
		resetDeleteSetupCodes: "Setup codes",
		resetDeleteUsers: "Users",
		resetDeleteVodJobs: "VOD jobs and manifest records",
		resetDeleteLiveChannels: "Live channels and run history",
		resetDeleteLiveSchedules: "Live schedules and operation history",
		resetDeletePseudoLiveFeeds: "Pseudo-Live Feed history",
		resetDeleteVmafMeasurements: "VMAF measurements and results",
		resetDeleteStorageChecks: "Storage check history",
		resetDeleteWatchFolderHistory: "Watch-folder detection history",
		resetDeleteAlertHistory: "Alert history",
		resetDeleteWebhookHistory: "Webhook delivery history",
		resetDeleteAuditHistory: "Operation history",
		resetKeeps:
			"Credentials, Bitmovin accounts, storage locations, presets, watch folders, notifications, API tokens, user accounts and application settings are kept.",
		resetPreserves:
			"System records required for safe operation are kept and are not included in the deletion count.",
		resetBitmovinNote:
			"Bitmovin is never touched: nothing is stopped or deleted in the cloud, and stored objects stay where they are.",
		resetBlockedLocal:
			"A VMAF measurement or pseudo-live feed is still active. Finish or stop it from its page, then try the data reset again.",
		resetBlocked:
			"Encoding or live processing is still active. Stop the listed work, wait for it to finish stopping, and try the data reset again.",
		resetDisarmNote:
			"{count} watch rules will be switched off. Their detection history is deleted with the rest, so leaving them on would re-detect every object under their prefixes and submit a paid encoding for each. Turn them back on when the next project is ready.",
		resetBlockedTruncated:
			"Showing {shown} of {total}. Open VOD Jobs, Live Channels, Pseudo-Live Feeds or VMAF Lab to finish or stop the remaining work.",
		resetAuditUnknown:
			"The reset history could not be confirmed and may still have been saved. Keep the encoding IDs below until an administrator confirms the result.",
		resetDisarmedList:
			"Watch rules switched off: {rules}. Turn the ones you still want back on when the next project is ready.",
		resetAuditMissing:
			"The reset history could not be saved. Keep the encoding IDs below and contact your system administrator or support team.",
		resetEncodersRecorded:
			"{count} Bitmovin encoding ids were recorded in the audit trail, so a stray encoder can still be traced back here.",
		resetEncodersRecordedTruncated:
			"Recorded {shown} of {total} Bitmovin encoding IDs in the audit trail. The remaining {omitted} IDs were not saved. Contact your system administrator or support team.",
		resetProviderPointersHeading:
			"Save these Bitmovin encoding IDs before leaving this page:",
		resetProviderPointersTruncated:
			"Showing {shown} of {total} encoding IDs. The remaining IDs were not saved in the audit trail. Contact your system administrator or support team.",
		resetProviderResourcesTruncated:
			"Showing {shown} of {total} cloud encoding resources. Review the remaining resources from VOD Jobs and Live Channels.",
		resetTemporaryStreamKeysUnconfirmed:
			"The data reset completed, but cleanup of temporary live stream keys could not be confirmed. Review temporary stream keys in Bitmovin before starting a new live channel.",
		resetResultReportUnconfirmed:
			"The reset request may have completed, but its result report could not be confirmed. Check the current data and Bitmovin resources before taking further action. Contact your system administrator or support team before running the reset again.",
		resetScopedNote:
			"{count} channel-specific alert rules will also be deleted because their channels are being deleted. Rules that apply to all channels are kept.",
		resetActivePseudoLive: "Pseudo-Live Feed ({status})",
		resetActiveVmaf: "VMAF measurement ({status})",
		resetActivePseudoLiveNamed:
			"{channel} · {source} · started {date} ({status})",
		resetActiveVmafNamed: "{name} · started {date} ({status})",
		resetActiveVodVmaf: "VOD quality measurement · started {date} ({status})",
		resetActiveLiveVmaf: "Live capture · started {date} ({status})",
		resetResourceVodJob: "VOD job",
		resetResourceLiveChannel: "Live channel",
		resetStatusDraft: "Draft",
		resetStatusQueued: "Queued",
		resetStatusEncoding: "Encoding",
		resetStatusAwaitingQuality: "Awaiting quality review",
		resetStatusCompleted: "Completed",
		resetStatusError: "Error",
		resetStatusCanceled: "Canceled",
		resetStatusQualityFailed: "Quality criteria not met",
		resetStatusCreated: "Created",
		resetStatusPreparing: "Preparing",
		resetStatusLive: "Live",
		resetStatusStopping: "Stopping",
		resetStatusStopped: "Stopped",
		resetStatusDownloading: "Downloading source",
		resetStatusSending: "Sending",
		resetStatusMeasuring: "Measuring",
		resetReconcileAction: "Check with Bitmovin",
		resetReconcilePending: "Checking with Bitmovin…",
		resetReconcileHint:
			"Checks stopped or never-started encodings. Missing encodings clear only after account and absence checks; running, queued or unverified entries remain. Nothing is stopped or deleted.",
		resetReconcileDone:
			"Checked with Bitmovin: {confirmed} stopped, never started or confirmed absent; {running} running or queued; {unverified} unverified.",
		resetBlockedEncoders:
			"Some cloud encoding resources may still be active. Check the listed encoding IDs in Bitmovin, stop any active resources, and try the data reset again.",
		resetAisaJobLink: "Open job awaiting capture",
		resetBlockedVerification:
			"Data cannot be reset because cleanup of delivery resources from an earlier operation could not be confirmed. Contact your system administrator or support team.",
		resetConfirmLabel: "Type {word} to confirm. This cannot be undone.",
		resetAction: "Reset data",
		resetDone: "Reset complete.",
		resetLoadFailed: "Could not load what a reset would delete.",
		apiTokens: "API tokens",
		live: "Live",
		liveChannelsInThisApp: "Live channels in this app",
		encodingIdOrPasteOne: "encoding id (or paste one)",
		deleteStandbyPoolNamed:
			'Delete pool "{name}"? Every standby encoding it holds goes with it.',
		addProviderAccount: "Add {provider} account",
		addProviderCloudConnect: "Add {provider} Cloud Connect account",
		awsInfrastructureSuffix: " · AWS infrastructure {id}",
		connectYourOwnProviderAccount:
			"Connect your own {provider} account to run encodings on your infrastructure.",
		connectedLatency: "connected · {ms}ms",
		couldNotListChannels: "Could not list this app's live channels",
		deleteProviderAccountNamed:
			'Delete {provider} account "{name}"? There is no update API — re-creating is the only way back.',
		deleteStreamKeyAssignedTail:
			" It is currently ASSIGNED — Bitmovin will refuse until it is unassigned.",
		dnsIntro:
			"Give a live encoder a stable hostname so a contribution encoder does not have to be re-pointed when the IP changes on restart.",
		encodingIdCopyLabel: "encoding id",
		encodingIdLine: "encoding {id}",
		encodingWord: "encoding",
		failed: "failed",
		infrastructureManagedPerAccount:
			"Infrastructure is managed per Bitmovin account. ",
		keyCountOne: "{count} key",
		keyCountOther: "{count} keys",
		liveResourcesManagedPerAccount:
			"Live resources are managed per Bitmovin account. ",
		managedCloudSuffix: " · managed cloud",
		noLiveChannelWithEncoding:
			"No live channel in this app has a Bitmovin encoding yet — paste an encoding id below.",
		noProviderAccounts: "No {provider} Cloud Connect accounts",
		notifications: "Notifications",
		orgLabel: "org {id}",
		pasteIdsManuallyBelow: "— paste ids manually below.",
		perRegionNetworkConfig:
			"Per-region network configuration for this {provider} account.",
		prewarmedPoolSummary:
			"{version} · {region} · {disk} GB disk · target {target}",
		prioritySuffix: " · priority {value}",
		releaseStaticIpUsedTail: " It is currently USED by an encoding.",
		reservedKeyIntro:
			"A reserved key can be re-used across live encodings, so your contribution encoder keeps one configuration. Bitmovin also mints",
		reservedKeyIntroTail: "keys for single encodings — those appear here too.",
		roleArn: "Role ARN:",
		showingAccounts: "Showing {shown} accounts",
		showingMappings: "Showing {shown} mappings",
		showingPools: "Showing {shown} pools",
		showingPoolsNoPaging:
			"Showing {shown} pools — the Bitmovin pool list takes no paging parameters.",
		showingRecentChannels:
			"Showing the {count} most recent channels — paste the id if yours is not listed.",
		showingStaticIps: "Showing {shown} static IPs",
		showingStreamKeys: "Showing {shown} stream keys",
		shownOfTotal: "{shown} of {total}",
		standbyIntro:
			"Encodings kept pre-started so a channel can go live in seconds. Standing instances bill while the pool exists.",
		standbyPoolCounts:
			"{ready} ready · {preparing} preparing · {error} error · target {target}",
		staticIpIntro:
			"A static IP is attached when a LIVE encoding is created (Encoding.staticIpId) — manage the address lifecycle here, pick it in the live wizard.",
		templateSuffix: " · template {name}",
		webhooks: "Webhooks",
		infrastructure: "Infrastructure",
		deleteAccountNamed: 'Delete account "{name}"?',
		deleteCredentialNamed:
			'Delete credential "{name}"? Storage location presets using it are removed too.',
		deleteDnsMapping: "Delete DNS mapping {name}?",
		deletePoolNamed: 'Delete pool "{name}"?',
		deleteStreamKeyNamed: 'Delete stream key "{name}"?',
		releaseStaticIp: "Release static IP {name}?",
		deleteRegionSettings: "Delete {provider} region settings for {region}?",
		regionSettingsFor: "Region settings — {name}",
		schedulesFor: "Schedules — {name}",
		standbyPoolFor: "Standby pool — {name}",
		removePoolId: "Remove pool {id}",
		receivedAt: "Received {when}",
		holdsKeys: "Holds {names}",
	},
	settingsForms: {
		action: "Action",
		allInfrastructureBelowLivesInThisAccount:
			"All infrastructure below lives in this account's Bitmovin organization",
		allLiveResourcesBelowLiveInThis:
			"All live resources below live in this account's Bitmovin organization",
		at: "At",
		awsInfrastructureIdOptional: "AWS infrastructure id (optional)",
		call: "Call",
		cloudConnectInfrastructureIdOptional:
			"Cloud Connect infrastructure id (optional)",
		cloudConnectRunsBitmovinEncodersInsideYour:
			"Cloud Connect runs Bitmovin encoders inside YOUR cloud account",
		created: "Created",
		defaultsAppliedToNewEncodingsPickFrom:
			"Defaults applied to new encodings; pick from this account's pools or paste ids from other orgs",
		delete: "Delete",
		descriptionOptional: "Description (optional)",
		details: "Details",
		duration: "Duration",
		dynamic10: "dynamic ≤10",
		eachIpServesOneEncodingAtA:
			"Each IP serves one encoding at a time: starting an encoding with an already-USED IP puts that encoding in ERROR. Release (delete) an IP only when nothing references it.",
		eachPoolStartsItsEncodingsFromAn:
			"Each pool starts its encodings from an Encoding Template. The pool refills toward targetPoolSize automatically, so deleting a single sick instance is safe. Acquiring hands you an encoding's ingest points and manifest URLs; adopting it as a managed channel in this app is not built yet — copy the coordinates out.",
		edit: "Edit",
		eitherTheWholeServiceAccountJsonOr:
			"Either the whole service-account JSON, or its email/key/project split",
		encoding: "Encoding",
		encodings: "Encodings",
		endpoint: "Endpoint",
		eventLogNewestFirst: "Event log (newest first)",
		externalIdOptional: "External id (optional)",
		fallbackRegionsCommaSeparated: "Fallback regions (in order)",
		infrastructure: "Infrastructure",
		instancesKeptReadyForStreaming1100:
			"Instances kept ready for streaming (1–100)",
		k12DigitAccountId: "12-digit account id",
		label: "Label",
		leaveBlankForBitmovinManagedCloud: "Leave blank for Bitmovin managed cloud",
		leaveTheValueBlankAndBitmovinGenerates:
			"Leave the value blank and Bitmovin generates a secure random key. A key you choose yourself must be globally unique and unguessable: anyone who knows it can push into your live encoding. An ASSIGNED key cannot be deleted — unassign it (or stop the encoding) first.",
		live: "Live",
		localTimeStoredAsUtcSecondsAre:
			"Local time, stored as UTC — seconds are ignored",
		lowercaseLettersDigitsAndDashesMax63:
			"Lowercase letters, digits and dashes; max 63 characters",
		manifest: "Manifest",
		modernPathBitmovinAssumesThisRoleNo:
			"Modern path — Bitmovin assumes this role, no static keys",
		mustBeASpecificRegionOrExternal:
			"Must be a specific region (or EXTERNAL with a Cloud Connect infrastructure id) — AUTO and continent/provider aggregates are rejected",
		mustBeGloballyUniqueAndUnguessableBlank:
			"Must be globally unique and unguessable — blank is safer",
		name: "Name",
		nameOptional: "Name (optional)",
		onlyForAwsCloudConnectInfrastructuresLeave:
			"Only for AWS Cloud Connect infrastructures — leave blank for Bitmovin managed cloud",
		pasteThePlainTemplateItIsBase64:
			"Paste the plain template — it is base64-encoded on submit",
		payload: "Payload",
		pickOneOfThisAppSLive:
			"Pick one of this app's live channels, or paste an id for an encoding it did not provision",
		poolIdOtherOrg: "pool id (other org)",
		processed: "Processed",
		processingPending: "pending",
		provider: "Provider",
		received: "Received",
		region: "Region",
		reservedKeysPersistTemporaryOnesAreTied:
			"RESERVED keys persist; TEMPORARY ones are tied to one encoding",
		retry: "Retry",
		schedules: "Schedules",
		schedulingPriority0100: "Scheduling priority (0–100)",
		secretConfigured: "secret configured",
		sentAsXTenantOrgIdOn: "Sent as X-Tenant-Org-Id on every API call",
		serviceAccountCredentialsJson: "Service account credentials (JSON)",
		signature: "Signature",
		signatureUnverified: "unverified",
		signatureVerified: "verified",
		stableBetaOrAPinnedVersion: "STABLE / BETA or a pinned version",
		standingInstancesKeptWarmWhileStarted:
			"Standing instances kept warm while STARTED",
		start: "Start",
		status: "Status",
		stop: "Stop",
		subdomain: "Subdomain",
		tenantOrgIdOptional: "Tenant org ID (optional)",
		theLiveEncodingCurrentlyHoldingTheKey:
			"The live encoding currently holding the key(s) — pick one, or paste an id",
		theSubdomainIsOneDnsLabelLowercase:
			"The subdomain is one DNS label: lowercase letters, digits and dashes, at most 63 characters. A mapping belongs to a specific encoding — Bitmovin has no account-level create or delete, so both take the encoding id. Each running channel also shows its own mappings on its detail page.",
		type: "Type",
		unassign: "Unassign",
		valueOptional: "Value (optional)",
		view: "View",
		webhooks: "Webhooks",
		writeOnlyEncryptedAtRestNeverShown:
			"Write-only — encrypted at rest, never shown again",
		writeOnlyPassesThroughToBitmovinNever:
			"Write-only — passes through to Bitmovin, never stored here",
	},
	fields: {
		spekeUrl: "SPEKE endpoint",
		spekeApiKey: "API key (optional)",
		spekeGatewayRegion: "API Gateway region (optional)",
		spekeExternalIdMode: "External ID mode (optional)",
		spekeVaultHelp:
			"The endpoint and authentication are stored encrypted. Provide both username and password for Basic authentication.",
		spekeRoleHelp:
			"Required with an AWS role ARN. Use the region hosting the SPEKE API Gateway.",
		lmiScte35Help:
			"Pass SCTE-35 messages to the receiving Origin. The Origin generates playback manifests.",
		lmiPublishingPoint: "Publishing point",
		lmiPublishingPointHelp:
			"Origin publishing URL, for example https://origin.example/live/channel.isml. Stored encrypted.",
		lmiScte35Passthrough: "SCTE-35 passthrough",
		k165535: "1–65535",
		k16ByteCencFairplayContentKey:
			"16-byte CENC/FairPlay content key; kid stays in the plan",
		accessKey: "Access key",
		accessKeyId: "Access key ID",
		accountKey: "Account key",
		accountLegacyKeys: "account {number} (legacy keys)",
		aes128Exactly16CharactersAes:
			"AES-128 = exactly 16 characters, AES-256 = exactly 32; resolved at channel start — never stored in plans",
		apiTokenConfigured: "API token configured (write-only)",
		appliesToBitmovinIOBrowsing:
			"Applies to Bitmovin I/O; browsing always signs V4",
		azureSummary: "{subscription} · {group} · tenant {tenant}",
		bitmovinAssumesThisRoleNoStatic:
			"Bitmovin assumes this role — no static keys stored",
		contentKey32HexChars: "Content key (32 hex chars)",
		customerSecretKey: "Customer secret key",
		customerSecretKeyId: "Customer secret key ID",
		decryptionKeyOptional: "Decryption key (optional)",
		externalIdOptional: "External ID (optional)",
		firewallId: "Firewall id",
		hmacAccessKey: "HMAC access key",
		hmacSecret: "HMAC secret",
		host: "Host",
		mslStreamId: "Stream ID",
		mslEventName: "Event name",
		mslPublishingUsername: "MSL5 publishing username (Digest)",
		mslPublishingPairBothOrNeither:
			"HTTP Digest username for publishing MSL5 segments. Provide both halves or neither — Bitmovin rejects a half pair at provisioning.",
		mslPublishingPassword: "MSL5 publishing password (Digest)",
		mslPublishingOnlyMsl5:
			"MSL5 only: Bitmovin rejects these fields on an MSL4 output, so an MSL4 channel ignores them. Write-only — never readable after save.",
		mslEdgeBaseUrlOptional: "Delivery edge base URL (optional)",
		mslEdgeBaseUrlHint:
			"The Akamai delivery root a viewer loads the stream from — https, no query, no trailing slash. MSL4: https://<hostname>/hls/live/<stream ID>/<event name>; MSL5: the value shown in Akamai Control Center. The app appends /<manifest name>. The link is the viewer's edge, not proof that the encoder is publishing.",
		kantarServicePassword: "Kantar service password",
		kantarServiceUserEncryptedAlongsideThe:
			"Kantar service user; encrypted alongside the password — never readable after save",
		limitParallelEncodingsOptional: "Limit parallel encodings (optional)",
		login: "Login",
		namespace: "Namespace",
		network: "Network",
		networkName: "Network name",
		nexguardLicense: "NexGuard license",
		numericAkamaiIdsAreNumbersUnlike:
			"Numeric — Akamai ids are numbers, unlike every other provider",
		ociUserSettingsCustomerSecretKeys:
			"OCI → User settings → Customer secret keys",
		passphrase16Or32Chars: "Passphrase (16 or 32 chars)",
		password: "Password",
		passwordOptional: "Password (optional)",
		pasteTheFullKeyFileClient:
			"Paste the full key file (client_email, private_key)",
		poisBasicAuthUserEncryptedAlongside:
			"POIS basic-auth user; encrypted alongside the password — never readable after save",
		port: "Port",
		portOptional: "Port (optional)",
		publicBaseUrlsOptional: "Public base URLs (optional)",
		oneLinePerBucketBucketHttpsCdn:
			"One line per bucket: bucket = https://cdn.example.com/base. Declares where the bucket is served publicly, and takes precedence over any URL derived from the destination ACL. Required for Azure containers and OCI, whose public URL cannot be inferred.",
		provideAtLeastOneOfPassword:
			"Provide at least one of password / decryption key",
		region: "Region",
		regionEndpointEndingInLinodeobjectsCom:
			"Region endpoint ending in .linodeobjects.com — stored as Bitmovin GenericS3, V4 signing",
		resolvedByTheLiveWorkerAt:
			"Resolved at channel start — plans only carry a credential reference",
		roleArn: "Role ARN",
		secretAccessKey: "Secret access key",
		secretKey: "Secret key",
		securityGroupId: "Security group id",
		serviceAccountJson: "Service account JSON",
		serviceAccountKeyJson: "Service account key JSON",
		signatureVersion: "Signature version",
		sshPortOptional: "SSH port (optional)",
		storageAccountName: "Storage account name",
		subnetId: "Subnet id",
		subnetName: "Subnet name",
		subnetOcid: "Subnet OCID",
		useTls: "Use TLS",
		username: "Username",
		webhookUrl: "Webhook URL",
		webhookUrlHint:
			"https:// only — treat like a password (Slack incoming webhooks grant post access); when SECRET_EGRESS_ALLOWED_HOSTS is set, the host must be listed there",
	},
	webhookReg: {
		account: "Bitmovin account",
		accountLead:
			"Hooks the account still holds at account level — this app's earlier registrations and anyone else's. Remove what you no longer want; nothing is registered here any more.",
		colKind: "Kind",
		colLastDelivery: "Last delivery",
		colSubject: "Encoding",
		colUrl: "Receiver URL",
		confirmExternalUnregister: "NOT this app's — click again to remove",
		external: "external",
		listFailed: "Could not list registrations.",
		noDelivery: "none yet",
		noneRegistered: "No webhook registrations on this account.",
		noPerEncoding:
			"No per-encoding registrations yet — rows appear once a job or live run has an encoding.",
		noteIngressChanged: "public ingress moved — re-registered",
		noteIngressUnavailable: "no public ingress — waiting",
		noteKeyRotated: "signature key rotated — re-registered",
		noteOrphan: "encoding deleted — hook removed",
		noteTerminal: "encoding finished — hook removed",
		perEncodingLead:
			"Registered automatically for every running job and live run (finished / error / transfer error / live manifest ready), removed when the encoding ends, re-registered when the public ingress moves.",
		perEncodingTitle: "Per-encoding registrations",
		removeFailed: "Removal failed.",
		reregisterFailed: "Could not request re-registration.",
		reregisterNow: "Re-register now",
		reregisterRequested:
			"Requested — waiting registrations are retried within {seconds} s.",
		runSubject: "{name} · run #{seq}",
		selectAccount: "Select an account…",
		statusActive: "active",
		statusDeleted: "removed",
		statusFailed: "failed",
		statusSkipped: "waiting",
		thisApp: "this app",
		title: "Account-level hooks (Bitmovin → this app)",
		unregister: "Unregister",
		urlCurrent: "current ingress",
		urlStale: "previous ingress",
	},
	ingress: {
		snapshotNote:
			"This information was read when the page loaded. Refresh to check the latest state. ",
		checked: "Checked {when}",
		legacyRow: "this app (legacy, unsigned)",
		mode: "Mode",
		modeNamedTunnel: "named tunnel (INGRESS_HOSTNAME)",
		modeNone: "none",
		modeQuickTunnel: "quick tunnel (cloudflared)",
		modeStatic: "static (PUBLIC_BASE_URL)",
		none: "No public ingress — Bitmovin cannot reach this install. {reason}",
		notReported:
			"The public ingress has not been reported yet — is the background service running?",
		receiver: "Signed receiver",
		receiverHint:
			"Registrations are made automatically per encoding, each with its own receiver URL and signature key (never shown). A hook registered by hand in the Bitmovin dashboard cannot carry the key and is refused.",
		secretEnv: "signature verification on (BITMOVIN_WEBHOOK_SECRET)",
		secretGenerated: "signature verification on (generated key)",
		secretUnavailable: "signature key unavailable (MASTER_KEY)",
		since: "since {when}",
		stale: "Last checked {when} — the background service may be down.",
		title: "Public ingress",
	},
	wizard: {
		codecDarPair:
			"Display aspect ratio requires both numerator and denominator",
		minGopFrames: "Minimum GOP length (frames)",
		maxGopFrames: "Maximum GOP length (frames)",
		openGop: "Open GOP",
		sarNumerator: "Sample aspect ratio numerator",
		sarDenominator: "Sample aspect ratio denominator",
		displayAspectRatio: "Display aspect ratio",
		darNumerator: "Display aspect ratio numerator",
		darDenominator: "Display aspect ratio denominator",
		qp: "Constant quantization factor (QP)",
		strictCbr: "Strict CBR (target-bitrate mode)",
		codecBitrateRange:
			"Minimum codec bitrate must not exceed maximum codec bitrate (bps).",
		codecGopRange:
			"Minimum GOP length must not exceed maximum GOP length (frames).",
		codecSarPair: "Set both the sample aspect ratio numerator and denominator.",
		codecAspectConflict:
			"Choose sample aspect ratio or display aspect ratio, not both.",
		codecQpRange:
			"Maximum quantization factor must not be less than the minimum.",
		codecStrictCbrMode:
			"Strict CBR requires a target bitrate without CRF or constant QP.",
		crf: "Constant rate factor (0–51)",
		hlsVideoUri: "Video playlist URI",
		hlsVideoUriHelp:
			"Optional flat .m3u8 filename. Leave blank for the derived name. For variants per audio group, include {token}. Per-Title keeps bitrate-derived names.",
		hlsVideoUriLiveHelp:
			"Optional flat .m3u8 filename. Leave blank for the derived name. Patterns and subdirectories are unavailable for Live.",
		hlsVideoUriPerTitle:
			"Individual video playlist filenames are unavailable for Per-Title. Clear this override and use the manifest's bitrate-derived names.",
		onDemandDrmTemplateUnavailable:
			"YAML export is unavailable for OnDemand MP4 DRM. Use Plan JSON or run this plan in the app to preserve DRM.",
		spekeTemplateUnavailable: "SPEKE settings are available as Plan JSON.",
		spekeOtherSystems: "Other system IDs (optional)",
		spekeProvider: "SPEKE key provider",
		spekeSystems: "DRM systems",
		spekeSystemsHelp:
			"Select at least one DRM system supported by the key provider.",
		spekeContentHelp:
			"Optional; an ID is generated when omitted. Matching Content ID and KID request the same keys.",
		spekeIvHelp: "Required for FairPlay; 32 hex characters.",
		burnInSrt: "Burn in SRT subtitles",
		burnInSrtHelp:
			"Select an SRT file from Input files. Subtitles become part of the video.",
		burnInSrtNone: "Off",
		subtitleEncoding: "Character encoding",

		gcsRegion: "GCS region",
		gcsRegionHint:
			"Select a Google Cloud region. Leave unset to use the provider default.",
		segmentNamingTemplate: "Segment naming template",
		segmentNamingTemplateHint:
			"When set, takes precedence over segment naming. Example: seg-{rand_chars:8}-%number%.m4s",
		credentialsLoadFailed:
			"Could not load credentials. Retry to select your storage credentials.",
		accountsLoadFailed:
			"Could not load Bitmovin accounts. Retry to select an account.",
		aisaDisabledQcOnly:
			"VMAF-only encoding skips AI Scene Analysis. Turn off VMAF-only to use these saved settings.",
		previewPlacementNeedsJit:
			"Preview placement requires Just in time. Change the timing or reset Start placement to VOD (default).",
		encodingModeFromLadder: "Use ladder encoding modes / presets",
		encodingModeFromLadderHint:
			"Set encoding modes or presets in step 3. The job-level mode is omitted to avoid conflicting settings.",
		noPreset: "None (use encoding mode)",
		copiedPerTitleBitrateFixed:
			"Cleared the incompatible fixed bitrate on copied Per-Title templates. All other settings and the source job are unchanged.",
		copySourceFailed:
			"The source job could not be loaded. Check the copy link and try again; no job has been created.",
		copiedJobHint:
			"Settings copied. Review and edit them, then start encoding when ready. No new job has been created yet.",
		muxedAudioNone: "None — video only",
		muxedAudio: "Muxed-in audio",
		muxedAudioHint:
			"Audio tracks that travel INSIDE these segments. Each variant that carries its own audio needs no EXT-X-MEDIA group; the ones that carry none point at a standalone audio container instead.",
		ownContainer: "Standalone container",
		ownContainerLabel: "Build one for this track",
		ownContainerOnHint:
			"A container of its own, referenced by an EXT-X-MEDIA group. Leave this on unless every variant that needs this track already carries it.",
		ownContainerOffHint:
			"No container of its own — this track ships only inside the video containers that carry it.",
		ownContainerOffUncarriedHint:
			"Nothing carries this track, so a container is built anyway — turning this off would drop the audio from the delivery entirely.",
		aManifestInThisPlanMultipliesHls:
			"A manifest in this plan multiplies HLS variants per audio group: give each audio rendition a media entry (group id / name / uri) and each video rendition a variant label, or the master playlist comes out incomplete. The dolby-dv-hdr10-sdr presets show the full pattern.",
		aPresetWithThatNameAlreadyExists:
			"A preset with that name already exists — pick another name.",
		aclPublicReadNeededForDirectPlayback:
			"ACL PUBLIC_READ (request public read access)",
		adaptiveSpatialTransform: "Adaptive spatial transform",
		addAdaptationSet: "Add adaptation set",
		addAudio: "Add audio",
		addCenc: "Add CENC",
		addConcatenation: "Add concatenation",
		addContainerFormat: "Add container format",
		addDash: "Add DASH",
		addDeinterlaceFilter: "Add filter",
		addDolbyStream: "Add Dolby stream",
		addEncoding: "Add encoding",
		addFairplay: "Add FairPlay",
		addHls: "Add HLS",
		addHlsMediaEntry: "Add HLS media entry",
		addIngestTrack: "Add ingest track",
		addInputFile: "Add input file",
		addKeyframe: "Add keyframe",
		addNexguardWatermarking: "Add NexGuard watermarking",
		addSmooth: "Add SMOOTH",
		addSource: "Add source",
		addSprite: "Add sprite",
		addSubtitle: "Add subtitle",
		addThumbnail: "Add thumbnail",
		addTrim: "Add input clip",
		addVideo: "Add video",
		addWebvttSubtitle: "Add WebVTT subtitle",
		additionalManifests: "Additional manifests",
		addsAProgressiveMp4QcMirrorPer:
			"Adds a QC mirror file for each video rendition (MP4, or WebM for VP9, under the qc/ output prefix). After encoding finishes, libvmaf compares it with the source automatically. View the report in VMAF Lab (/qc).",
		adoptConfigurationThreshold: "Adopt configuration threshold",
		advanced: "Advanced",
		advancedAv1: "Advanced (AV1)",
		advancedH264: "Advanced (H264)",
		advancedH265: "Advanced (H265)",
		advancedNeededOnlyForMultiAudioGroup:
			"Standard VOD can use custom video playlist filenames. Other fields assign renditions to HLS audio groups or DASH adaptation sets and set HLS variant labels. Leave routing fields unset unless you need separate audio groups or ladders.",
		advancedPaddingAspect: "Advanced (padding, aspect)",
		advancedPlacementHlsAudioGroups: "Advanced placement (HLS audio groups)",
		advancedVp9: "Advanced (VP9)",
		ai: "ai",
		alsoComputePsnr: "Also compute PSNR",
		alsoComputePsnrMoreInformation: "Also compute PSNR — more information",
		anEncryptionRowTargetsThisOutputIts:
			"An encryption row targets this output — its destination is omitted and the DRM output writes instead. A value here overrides that.",
		analysisJson: "analysis.json",
		apiDefaultCtr: "(API default — CTR)",
		appliesWhileARenditionUsesTheImplicit:
			"Applies while a rendition uses the implicit video track",
		appliesWhileARenditionUsesTheImplicit2:
			"Applies while a rendition uses the implicit audio track",
		apply: "Apply",
		aqMode: "AQ mode",
		aqStrength: "AQ strength",
		arnrMaxFrames: "ARNR max frames",
		arnrStrength: "ARNR strength",
		arnrType: "ARNR type",
		aspectMode: "Aspect mode",
		assetDescriptionFilename: "Asset description filename",
		attachDolbyVisionMetadata: "Attach Dolby Vision metadata",
		attachFilter: "Attach filter",
		attachmentOrderMattersPositionIsTheCreate:
			"Attachment order matters — position is the create order on the stream. Filters are defined in the Ladder step's filter list.",
		audioGroupId: "Audio group id",
		audioInputFile: "Audio input file",
		audioLanguage: "Audio language",
		audioMediaUri: "Audio media uri",
		audioMuxingKind: "Audio muxing kind",
		audioRenditions: "Audio renditions",
		audioVariantStreams: "Audio variant streams",
		audioVideoSyncMode: "Audio/video sync mode",
		autoEnable: "Auto enable",
		autoLevelSetup: "Auto level setup",
		autoNull: "auto (null)",
		automaticAdPlacementAllsceneboundaries:
			"Automatic ad placement (allSceneBoundaries)",
		aisaSchedule: "Scheduled cue points",
		aisaDefaultLanguage: "English is the default analysis language.",
		aisaAdditionalLanguagesHelp:
			"Add up to three language codes separated by commas, for example ja, de. English does not need to be added.",
		aisaPosition: "Position (seconds)",
		aisaMaxDeviation: "Max deviation (seconds)",
		aisaDuration: "Duration (seconds, optional)",
		aisaAddCue: "Add cue point",
		aisaRemoveCue: "Remove cue point",
		aisaNeedsCue: "Add at least one cue point.",
		aisaNonnegativeNumber: "Enter a number greater than or equal to 0.",
		aisaScheduleHelp:
			"Deviation 0 disables scene-boundary adjustment; matching cut frames across codecs are not guaranteed.",
		autorepresentationsEmptyObjectEnablesDefault:
			"autoRepresentations (empty object enables defaults)",
		bFrames: "B-frames",
		back: "Back",
		base64PublicManifestMetadata: "Base64 — public manifest metadata",
		baselinePreset: "Baseline preset",
		basics: "Basics",
		beforeYouStartPresetChecklist: "Before you start — preset checklist",
		bitmovinAccount: "Bitmovin account",
		bitrateBps: "Bitrate (bps)",
		bitrateSelection: "Bitrate selection",
		blocked: "blocked",
		browseStorage: "Browse storage…",
		browseThePresetGallery: " Browse the preset gallery",
		bucket: "Bucket",
		buckets: "Buckets",
		bufsizeBits: "Bufsize (bits)",
		cabac: "CABAC",
		campaignAUhd: "campaign-a, uhd",
		change: "Change",
		channelLayout: "Channel layout",
		channelName: "Channel name",
		clEnumEmptyClStereo: "CL_* enum — empty = CL_STEREO",
		clientManifest: "Client manifest",
		closedCaptions: "Closed captions",
		cloudRegion: "Cloud region",
		codec: "Codec",
		codecBufsizeFactor: "Codec bufsize factor",
		codecMaxBitrateFactor: "Codec max bitrate factor",
		codecMinBitrateFactor: "Codec min bitrate factor",
		colorConfig: "Color config",
		colorPrimaries: "Color primaries",
		colorSpace: "Color space",
		colorTransfer: "Color transfer",
		commaSeparatedEncodingLabelsTagsThatGroup:
			"Comma separated — Encoding.labels tags that group results in Bitmovin statistics; empty = none",
		commaSeparatedInTheChosenUnit: "Comma-separated, in the chosen unit",
		compareYourBuiltPlanAgainstASample:
			"Compare your built plan against a sample or one of your saved presets",
		complexityFactor: "Complexity factor",
		configuredInSettingsBitmovinAccounts:
			"Configured in Settings → Bitmovin accounts",
		container: "Container",
		contentKeyVault: "Content key (vault)",
		contentKey32Hex: "Content key (32 hex chars)",
		contentKeyMustBe32Hex:
			"The key must be exactly 32 hex characters (16 bytes).",
		enterKeyDirectly: "Enter key directly…",
		inlineKeyDefaultLabel: "Wizard content key",
		inlineKeyStoredEncrypted:
			"Saved as a DRM_CENC credential — AES-256-GCM encrypted at rest, write-only afterwards. The plan carries only the reference.",
		saveKeyAndUse: "Save key and use it",
		contentKeysStayInTheVaultA:
			"DRM credentials stay encrypted in the vault; each row carries a credential reference. Encrypted outputs use the DRM destination.",
		contentReference: "Content reference",
		copyChromaLoc: "Copy chroma loc",
		copyColorRange: "Copy color range",
		copyColorSpace: "Copy color space",
		copyPreview: "Copy preview",
		copyPrimaries: "Copy primaries",
		copyTransfer: "Copy transfer",
		couldNotReadTheSelectedFile: "Could not read the selected file",
		couldNotSaveThePreset: "Could not save the preset.",
		cpuUsed: "CPU used",
		creationMode: "Creation mode",
		credential: "Credential",
		credentials: "Credentials",
		current: "current:",
		dashAdaptationSet: "DASH adaptation set",
		dashAdaptationSetRoutingAppearsHereOnce:
			"DASH adaptation-set routing appears here once a DASH manifest declares adaptation sets (Manifests step) — used by the dolby multi-ladder presets.",
		dashOptions: "DASH options",
		dashStreamMpd: "DASH (stream.mpd)",
		default: "(default)",
		default10: "Default 10",
		default6: "Default 6",
		defaultApi: "Default (API)",
		defaultEnWebvttSegNumberVtt: "Default en_webvtt_seg_%number%.vtt",
		defaultInitHdr: "Default init.hdr",
		defaultInitMp4: "Default init.mp4",
		defaultSegNumberChk: "Default seg_%number%.chk",
		defaultSegNumberTs: "Default seg_%number%.ts",
		addDeliveryMirror: "Add delivery mirror",
		deliveryMirror: "Delivery mirror",
		deliveryMirrors: "Additional delivery mirrors",
		defaultSegmentNumberM4s: "Default segment_%number%.m4s",
		defaultThumbnailNumberJpg: "Default thumbnail-%number%.jpg",
		defaultVodHighQuality: "Default VOD_HIGH_QUALITY",
		demoChannelJp: "Demo Channel JP",
		description: "Description",
		destinationPath: "Destination path",
		dialogueIntelligence: "Dialogue intelligence",
		diffVsPreset: "Diff vs preset",
		discardImport: "Discard import",
		dismissPresetNotice: "Dismiss preset notice",
		dolbyDvHdr10SdrLaddersRunAs:
			"Dolby DV/HDR10/SDR ladders run as sibling encodings (the API rejects mixed dynamic-range formats in one encoding) whose muxings merge into shared manifests. Multi-encoding plans are POST_ENCODING-only — JIT raises PLAN_MULTI_ENCODING_JIT in the preview. When rows exist, streams, renditions and keyframes gain an encoding select.",
		dolbyVisionMetadata: "Dolby Vision metadata",
		dolbyvisionBox: "DolbyVision box",
		drmCencCredentialTheKeyItselfNever:
			"DRM_CENC credential — the key itself never enters the plan",
		drmKind: "DRM kind",
		drmOutputOwnsTheDestination: "DRM output owns the destination",
		durationS: "Duration (s)",
		dvProfile: "DV profile",
		dvTrackSignalingOnTheMp4Box: "DV track signaling on the MP4 box",
		dynamicRangeFormat: "Dynamic range format",
		enableAiSceneAnalysisTheSamplesRun:
			"Enable AI Scene Analysis (the samples run it on encoder BETA)",
		enableKantarAudioWatermarking: "Enable Kantar audio watermarking",
		encoderVersion: "Encoder version",
		encoding: "Encoding",
		encodingLevelKeyframesCutSegmentsAtAd:
			"Encoding-level keyframes cut segments at ad-break times (seconds).",
		encodingMode: "Encoding mode",
		encodingStartOptions: "Encoding start options",
		encodingModePresetConflict:
			"When using a quality preset, set Encoding start options > Encoding mode back to (default).",
		mixedEncodingModeGuidance:
			"Prefer one video codec per job. Advanced mixed-codec jobs require explicit settings without presets and a common encoding mode.",
		onDemandClearDrmGuidance:
			"For clear OnDemand DASH, use MP4 muxings without DRM. Put clear and encrypted MP4 outputs in separate encoding plans.",
		encryptionMode: "Encryption mode",
		endPictureTiming: "End picture timing",
		endTimecode: "End timecode",
		enterManually: "Enter manually",
		fairplayIv32Hex: "FairPlay IV (32 hex)",
		fairplayUri: "FairPlay URI",
		false: "false",
		fileStream: "File stream",
		filename: "Filename",
		filenamePattern: "Filename pattern",
		filter: "Filter",
		filterKey: "Filter key",
		filtersDeinterlace: "Filters (ordered)",
		defineAndAttachDeinterlace: "Define a deinterlace filter and attach it",
		fixTheValidationIssuesAboveBeforeSaving:
			"Fix the validation issues above before saving — only a valid plan can be stored as a preset.",
		forcedRenditionAboveHighest: "Forced rendition above highest",
		forcedRenditionFactor: "Forced rendition factor",
		forcedRenditionMode: "Forced rendition mode",
		fragmentDurationMs: "Fragment duration (ms)",
		frameRateFps: "Frame rate (fps)",
		frameSelection: "Frame selection",
		gBRWpLMasteringMetadata: "G(…)B(…)R(…)WP(…)L(…) mastering metadata",
		generationTiming: "Generation timing",
		gridColumnsVtiles: "Grid columns (vTiles)",
		gridRowsHtiles: "Grid rows (hTiles)",
		groupId: "Group id",
		h264PictureTiming: "H264 picture timing",
		handleVariableInputFps: "Handle variable input FPS",
		handleVariableInputFpsMoreInformation:
			"Handle variable input FPS — more information",
		hdr: "HDR",
		heightP: "Height (p)",
		heightPx: "Height (px)",
		hideImport: "Hide import",
		highComplexityBoundary: "High-complexity boundary",
		hlsOptions: "HLS options",
		hlsStreamM3u8: "HLS (stream.m3u8)",
		hlsVariantLabel: "HLS variant label",
		host: "Host",
		hostPortLiveInTheSftpCredential: "host/port live in the SFTP credential",
		noCredentialNeeded: "No credential needed",
		httpsAuthFree: "HTTPS (auth-free)",
		iFramePlaylists: "I-frame playlists",
		imageFilename: "Image filename",
		imagesPerFile: "Images per file",
		implicitAudioReadsTheSameObjectAs:
			"Implicit audio reads the same object as the video by default. Point it at a different input file when the audio is a separate object (separate A/V).",
		implicitAudioTrackEncoding: "Implicit audio track → encoding",
		implicitSet: "(implicit set)",
		implicitVideoTrackEncoding: "Implicit video track → encoding",
		importPlanJson: "Import plan JSON…",
		importPlanJsonExpert: "Import plan JSON (expert)",
		incomplete: "incomplete",
		infrastructureAdvanced: "Infrastructure (advanced)",
		infrastructureId: "Infrastructure id",
		infrastructureRegion: "Infrastructure region",
		ingestTrackFileStreamOrDolbyStream:
			"Ingest track, file stream or Dolby stream from the Sources step",
		initSegment: "Init segment",
		initSegmentNameTemplate: "Init segment name template",
		framesPerCmafChunk: "Frames per CMAF chunk",
		cmafCompatibility:
			"CMAF: H264/AAC with DASH or Live Media Ingest. HLS and DRM are not supported.",
		injectedIntoBitmovinAccountidTheOneException:
			"Injected into bitmovin.accountId — the one exception to verbatim submission",
		inputAudioTrackImplicit: "Input audio track (implicit)",
		inputFile: "Input file",
		inputFile1PrimaryRequired: "Input file 1 — primary (required)",
		inputFiles: "Input files",
		inputFormat: "Input format",
		inputStreamNeedsAVisionMetadataSidecar:
			"INPUT_STREAM needs a VISION_METADATA sidecar stream",
		inputVideoTrackImplicit: "Input video track (implicit)",
		intervalDistance: "Interval (distance)",
		intervalStartRecommendedForTrickPlay:
			"INTERVAL_START recommended for trick-play",
		iv32HexChars: "IV (32 hex chars)",
		jobName: "Job name",
		jpgJpegPng: ".jpg / .jpeg / .png",
		justInTimeWithTheEncodingStart: "Just-in-time (with the encoding start)",
		k2RungH264AacJitHls: "2-rung H264 + AAC, JIT HLS",
		kantarChannelThisContentIsReportedUnder:
			"Kantar channel this content is reported under",
		kantarCredential: "Kantar credential",
		kantarLicenseIdInteger: "Kantar license id (integer)",
		kantarWatermarkingServiceEndpoint: "Kantar watermarking service endpoint",
		key: "Key",
		kid32HexChars: "kid (32 hex chars)",
		kidIsPublicNeverPasteTheContent:
			"kid is PUBLIC — never paste the content key here",
		kind: "Kind",
		label: "Label",
		labels: "Labels",
		ladder: "Ladder",
		lang: "Lang",
		language: "Language",
		level: "Level",
		levelHighTier: "Level high tier",
		licenseId: "License id",
		licenseUri: "License URI",
		loadFile: "Load file…",
		lossless: "Lossless",
		loudnessControlAtmos: "Loudness control (Atmos)",
		lowComplexityBoundary: "Low-complexity boundary",
		mainReferenceStream: "Main (reference stream)",
		manifestFilename: "Manifest filename",
		manifestType: "Manifest type",
		manifests: "Manifests",
		masterDisplay: "Master display",
		masterVersion: "Master version",
		maxBitrateBps: "Max bitrate (bps)",
		maxBitrateStepSize: "Max bitrate step size",
		maxCtuSize: "Max CTU size",
		maxKeyframeInterval: "Max keyframe interval",
		maxcll: "MaxCLL",
		maxfall: "MaxFALL",
		mediaUri: "Media uri",
		mediaVersion: "Media version",
		metadataInputFileOptional: "Metadata input file (optional)",
		metadataSource: "Metadata source",
		metadataStream: "Metadata stream",
		meteringMode: "Metering mode",
		minBitrateBps: "Min bitrate (bps)",
		minBitrateStepSize: "Min bitrate step size",
		minKeyframeInterval: "Min keyframe interval",
		mode: "Mode",
		motionEstimation: "Motion estimation",
		motionSearch: "Motion search",
		motionSearchRange: "Motion search range",
		multiLegPlansWhichLegThisManifest:
			"Multi-leg plans: which leg this manifest enumerates",
		mustBeReplacedWithYourRealObject:
			" must be replaced with your real object paths before starting.",
		mvPredictionMode: "MV prediction mode",
		mvSearchRangeMax: "MV search range max",
		myPresets: "My presets",
		namesThisLadderSVariantEntriesWhen:
			"Names this ladder's variant entries when the master multiplies variants per audio group — match it across the ladder (dv81 / sdr in the dolby-dv-hdr10-sdr presets). Single-audio-group HLS does not need it.",
		newVodJob: "New VOD Job",
		nexguardLicense: "NexGuard license",
		nexguardWatermarking: "NexGuard watermarking",
		next: "Next",
		noAudioRenditionsVideoOnlyPlansSkip:
			"No audio renditions — video-only plans skip the implicit audio ingest track.",
		noManifestsSelectedSegmentsWillBeWritten:
			"Segmented outputs are selected without a playable playlist. Select a manifest for these outputs.",
		noVideoRenditionsAudioOnlyPlansAre:
			"No video renditions — audio-only plans are valid (Dolby Atmos masters).",
		none: "(none)",
		noneAddOneToExtractJpegThumbnails:
			"None. Add one to extract JPEG thumbnails from a rendition at the given positions.",
		noneAddOneToGenerateATiled:
			"None. Add one to generate a tiled scrub-preview image plus a WebVTT index from a rendition, sampled at the given interval.",
		null: "null",
		offsetS: "Offset (s)",
		onDemandProfile: "ON_DEMAND profile",
		oneOrMoreContainerOutputsPerRendition:
			"One or more container outputs per rendition, each with its encryption configured inline. A stream can have several containers (e.g. fMP4 for DASH + TS for HLS, as in the per-title H264 samples) — each extra container gets its own resource key.",
		oneTileEveryNUnits: "One tile every N units",
		onlyNeededForMultiAudioGroupHls:
			"Only needed for multi-audio-group HLS (Dolby ladders) — see the dolby presets. With a single audio group the default placement is already correct and these stay unset.",
		optionalShownInThePresetGallery: "Optional — shown in the preset gallery",
		optionalVtt: "Optional, .vtt",
		output: "Output",
		outputLanguageCodes: "Additional analysis languages",
		outputPath: "Output path",
		packaging: "Packaging",
		paddingAfterS: "Padding after",
		paddingBeforeS: "Padding before",
		parity: "Parity",
		partitionedPlansMustAssignEveryRenditionTo:
			"Partitioned plans must assign every rendition to an encoding",
		pasteAFullEncodingplanEverySdkField:
			"Paste or load a plan JSON to edit it in the wizard. Plans with settings the wizard cannot preserve stay in JSON editing mode. Importing does not create or start a job; template saving and execution are separate actions.",
		perRenditionPlacementHlsGroupsDashSets:
			"Per-rendition placement (HLS groups / DASH sets)",
		perTitleAndMultiEncodingPlansMust:
			"Per-Title and multi-encoding plans must generate their manifests after encoding — the validation in the preview enforces it.",
		perTitleConfiguration: "Per-Title configuration",
		perTitleFixedResolutionBitrate: "Per-title fixed resolution & bitrate",
		perTitleLeavesBitrateToTheAlgorithm:
			"Per-title leaves bitrate to the algorithm (null)",
		perTitleSamplesPinRateToNull: "Per-title samples pin rate to null (auto)",
		perTitleTemplatesLeaveBitrateToThe:
			"Per-title templates leave bitrate to the algorithm (manifests are generated after encoding)",
		perTitleVariantUri: "Per-title variant uri",
		pinnedEncoderVersion: "Pinned encoder version",
		pinnedVersion: "Pinned version…",
		pinnedVersionEG22660: "Pinned version, e.g. 2.266.0",
		pixelFormat: "Pixel format",
		placeholder: "placeholder",
		placeholderPaths: "Placeholder paths",
		placeholdersResolved: "placeholders resolved",
		placementExtras: "Placement & extras",
		planDefault: "(plan default)",
		planIsIncomplete: "Plan is incomplete",
		planJson: "Plan JSON",
		planPreview: "Plan preview",
		playreadyLaUrl: "PlayReady LA URL",
		playreadyPssh: "PlayReady PSSH",
		position: "Position",
		positions: "Positions",
		postEncodingAfterFinished: "Post-encoding (after FINISHED)",
		preset: "preset:",
		preset2: "Preset",
		presetChecklist: "Preset checklist",
		presetConfiguration: "Preset configuration",
		presetName: "Preset name",
		chooseFromTemplates: "Choose from templates…",
		presetsAreThePythonSampleGoldenPlans:
			"Presets are ready-made sample configurations: swap the placeholder credentials and storage below for your own (managed under Settings → Credentials), then pick the Bitmovin account. Sample object paths that are not flagged here may still need adjusting to your bucket layout — discard and re-import the edited JSON for free-form changes.",
		preview: "Preview",
		previewWatchWhileEncodingManifestListsOn:
			"Preview = watch-while-encoding manifest lists on the start request",
		producesOnlyThePerVideoQcMirror:
			"Produces only the per-video QC mirror files (MP4, or WebM for VP9, under the qc/ output prefix), with no HLS/DASH muxings or manifests, audio outputs, thumbnails, sprites or DRM. This configuration is for VMAF/PSNR measurement. Choose the storage output where the QC mirrors will be written. Delivery format and manifest controls are disabled while this is on.",
		profile: "Profile",
		psnrDbRidesTheSameLibvmafPass:
			"PSNR (dB) rides the same libvmaf pass and shows alongside VMAF in the report.",
		psyRdo: "Psy RDO",
		psyRdoq: "Psy RDOQ",
		psyTrellis: "Psy trellis",
		publicInitializationVectorTheKeyStaysIn:
			"Public initialization vector — the key stays in the vault",
		qpMax: "QP max",
		qpMin: "QP min",
		quality: "Quality",
		rateOvershoot: "Rate overshoot %",
		rateUndershoot: "Rate undershoot %",
		rcLookahead: "RC lookahead",
		rePointToOutput: "Re-point to output",
		realObjectPathExt: "real/object/path.ext",
		referenceFrames: "Reference frames",
		relativeToBaseEmptyTheMuxingS:
			"Relative to base — empty = the muxing's derived path",
		relativeToTheBaseOutputPath: "Relative to the base output path",
		relativeToTheBaseOutputPathWhere:
			"Relative to the base output path — where Kantar's processing report is written",
		remove: "Remove",
		removeContainer: "Remove container",
		removeDolbyVisionMetadata: "Remove Dolby Vision metadata",
		removeEncryption: "Remove encryption",
		removeHlsMediaEntry: "Remove HLS media entry",
		removeNexguardWatermarking: "Remove NexGuard watermarking",
		renditionsJoinASetViaTheirDash:
			'Renditions join a set via their "DASH adaptation set" extra. Absent ⇒ the implicit video+audio pair.',
		replaceWithVaultCredential: "Replace with vault credential…",
		reportPath: "Report path",
		reports: "reports",
		representationType: "Representation type",
		requiredEGVideoMp4VideoIsmv: "Required — e.g. video.mp4 / video.ismv",
		review: "Review",
		reviewThePlanOnTheRightThe:
			"Review the plan preview — the operation list is exactly what will be executed, in order.",
		routesThisRenditionIntoTheMatchingSet:
			"Routes this rendition into the matching set declared under Manifests → DASH options (label routing) — how the dolby multi-ladder presets keep DV/HDR10/SDR ladders apart. Unset = the implicit video/audio pair.",
		runVmafQcAfterEncoding: "Run VMAF QC after encoding",
		runVmafQcAfterEncodingMoreInformation:
			"Run VMAF QC after encoding — more information",
		sameObjectAsTheVideo: "(same object as the video)",
		sameObjectAsTheVideoUnlessChanged:
			"Same object as the video unless changed",
		sampleRateHz: "Sample rate (Hz)",
		samples: "Samples",
		sao: "SAO",
		saveAsPreset: "Save as preset",
		savedItIsNowInThePreset:
			"Saved. It is now in the preset gallery under “My presets”.",
		saving: "Saving…",
		sceneCutThreshold: "Scene-cut threshold",
		segmentLengthS: "Segment length (s)",
		segmentNaming: "Segment naming",
		selectABaseline: "Select a baseline…",
		selectABitmovinAccountInStep1:
			"Select a Bitmovin account in step 1 before starting.",
		selectAccount: "Select account…",
		selectCredential: "Select credential…",
		selectFileStream: "Select file stream…",
		selectFilter: "Select filter…",
		selectInputFile: "Select input file…",
		selectSourceStream: "Select source stream…",
		selectStream: "Select stream…",
		selectingAnS3CredentialOpensTheBrowser:
			"Selecting an S3 credential opens the browser",
		selectionMode: "Selection mode",
		separateDolbyVisionMetadataSidecarEmptyEmbed:
			"Separate Dolby Vision metadata sidecar; empty = embedded",
		serverManifest: "Server manifest",
		serverUrl: "Server URL",
		set: "set",
		setWithManifestTypeForFragmentedMp4:
			"Set with manifest type for fragmented MP4; both empty = progressive",
		severalManifestsOfOneKindAreValid:
			"Several manifests of one kind are valid — the segment-timeline sample writes a TEMPLATE and a TIMELINE DASH manifest side by side.",
		showSummary: "Show summary",
		singleMp4SegmentbaseRepresentationsDashOnDem:
			"Single-MP4 SegmentBase representations (DASH_ON_DEMAND muxings)",
		skdLicenseTokenUri: "skd:// license token uri",
		slices: "Slices",
		sourceStream: "Source stream",
		sources: "Sources",
		speechThreshold: "Speech threshold (%)",
		sprite: "sprite",
		spriteJpg: "sprite.jpg",
		spriteJpgResourceName: "sprite.jpg (resource name)",
		spriteName: "Sprite name",
		spriteVtt: "sprite.vtt",
		spritesTrickPlay: "Sprites (trick-play)",
		startEncoding: "Start encoding",
		startEncodingImportedPlan: "Start encoding (imported plan)",
		startOptionsAdvanced: "Start options (advanced)",
		startPictureTiming: "Start picture timing",
		startPlacement: "Start placement",
		startRequestPertitleBlocksPairThemWith:
			"Pair the per-title start settings with per-title stream modes on the ladder. Generate manifests after encoding.",
		startTimecode: "Start timecode",
		startencodingrequestEncodingmodeEmptyApiDefa:
			"Encoding mode — leave blank to use the provider default.",
		startencodingrequestHandlevariableinputfpsDr:
			"Variable input frame rate — drop or duplicate frames to keep audio and video synchronized.",
		startencodingrequestTweaksFailsWithDolbyDigi:
			"Advanced encoder tweaks cannot be combined with Dolby Digital, Dolby Digital Plus or Dolby Atmos audio. The plan is checked before submission.",
		starting: "Starting…",
		stream: "Stream",
		streamMode: "Stream mode",
		modeMixed: "Mixed",
		modePerTitle: "Per-Title",
		modeStandard: "Standard",
		streamModeAll: "Stream mode (all video renditions)",
		strength: "Strength",
		subMe: "Sub-ME",
		subMeNumeric: "Sub-ME (numeric)",
		submitFailed: "Submit failed",
		subtitleTracksWebvtt: "Subtitle tracks (WebVTT)",
		subtitleWebvtt: "subtitle · WEBVTT",
		targetQualityCrf: "Target quality CRF",
		targetQualityQp: "Target quality QP",
		templateYaml: "Template YAML",
		theInputStreamThisTrimWraps: "The input stream this clip wraps",
		theObjectAStreamReadsWhenIt:
			"The object a Stream reads when it references this file",
		theObjectDeclaredInInputFilesThis:
			"The object (declared in Input files) this stream reads",
		thePlanIsSubmittedAsImportedThe:
			"The original JSON is preserved. Use Edit JSON to change it, save it as a template, or explicitly create the job. The selected account is used when the plan has none.",
		theProcessingReportIsOperationalDataSo:
			"The processing report is operational data, so it is normally written PRIVATE even when the delivery output is public. Unchecked, the report inherits the storage output's public/private setting like every other destination.",
		theseEncryptionRowsTargetAnOutputKey:
			"These encryption rows target an output key that no longer exists (its rendition was renamed or removed). Re-point them to a current output or remove them — otherwise the preview flags an unresolved reference.",
		thisPlanHasNoAudioRenditionAdd:
			"This plan has no audio rendition — add one on the Ladder step or the plan will be rejected (Kantar watermarks audio).",
		thisPlanReferencesNoVaultCredentials:
			"This plan references no vault credentials.",
		thumbnail: "thumbnail",
		thumbnailNumberJpg: "thumbnail-%number%.jpg",
		thumbnails: "Thumbnails",
		tileColumns: "Tile columns",
		tileHeightPx: "Tile height (px)",
		tileWidthPx: "Tile width (px)",
		timeBasedSeconds: "Time-based (seconds)",
		timeS: "Time (s)",
		timecodeTrackSmpte12m: "Timecode track (SMPTE-12M)",
		trellis: "Trellis",
		true: "true",
		tuInterDepth: "TU inter depth",
		tuIntraDepth: "TU intra depth",
		type: "Type",
		unassigned: "(unassigned)",
		unit: "Unit",
		unset: "(unset)",
		useInsteadOfRowsColumnsNotBoth: "Use instead of rows×columns, not both",
		valid: "Valid ✓",
		variantLabelsMostlyBelongOnVideoRenditions:
			"Variant labels mostly belong on video renditions; audio/subtitle placement happens via the media entry below.",
		variantsPerAudioGroup: "Variants per audio group",
		vaultCredentialTheLicenseItselfNeverEnters:
			"Vault credential — the license itself never enters a plan",
		vaultCredentialTheServiceLoginPasswordNever:
			"Vault credential — the service login/password never enter a plan",
		videoMuxingKind: "Video muxing kind",
		videoRenditions: "Video renditions",
		visionMetadataStreamsFromTheSourcesStep:
			"VISION_METADATA streams from the Sources step",
		vmafModel: "VMAF model",
		vmafOnlySkipDeliveryOutputs: "VMAF only (skip delivery outputs)",
		vmafOnlySkipDeliveryOutputsMoreInformation:
			"VMAF only (skip delivery outputs) — more information",
		vodDefault: "VOD (default)",
		vodPreview: "VOD + Preview",
		watermarkType: "Watermark type",
		webvttFileStreamsComeFromTheSources:
			"WEBVTT file streams come from the Sources step",
		webvttIndex: "WebVTT index",
		weightPredictionB: "Weight prediction (B)",
		weightPredictionP: "Weight prediction (P)",
		weightedPredictionP: "Weighted prediction (P)",
		widevinePssh: "Widevine PSSH",
		widthOrHeightRequired: "Width or height required",
		widthOrHeightRequiredOtherIsDerived:
			"Width or height required; other is derived",
		withColumnsOrUseImagesFile: "With columns; or use images/file",
		withRowsOrUseImagesFile: "With rows; or use images/file",
		wizardSteps: "Wizard steps",
		writeTheReportPrivatelyAclPrivate:
			"Write the report privately (ACL PRIVATE)",
		writeTheReportPrivatelyAclPrivateMore:
			"Write the report privately (ACL PRIVATE) — more information",
		yourIdentifierForThisAssetInKantar:
			"Your identifier for this asset in Kantar's reporting",
		yuv420p10leForMain10Hdr10: "YUV420P10LE for MAIN10/HDR10",
	},
	delivery: {
		galleryTitle: "Delivery presets",
		galleryIntro:
			"Curated file-delivery specs: a plan plus a machine-readable requirements table. Load one, and the wizard warns when your edits deviate from the spec. Export as a .bitovp-preset.json file to encode your own platform's delivery spec — we ship the mechanism and generic examples, never third-party specs.",
		importButton: "Import preset file",
		importing: "Importing…",
		importFailed: "Import failed: {error}",
		importSelfDeviations:
			"Imported with {count} self-deviation(s): the file's example plan does not fully satisfy its own constraints — review before relying on it.",
		requirementCol: "Requirement",
		exportButton: "Export JSON",
		suggestedGateLine: "Suggested QC gate: {metric} ≥ {gte} (advisory)",
	},
	wizardX: {
		importLoadedForEditing:
			"Plan loaded into the wizard. Review it before creating a job, or save it as a template.",
		importCannotEditWithoutLoss:
			"The wizard cannot preserve every setting in this plan. The original JSON remains active; use Edit JSON to change it.",
		importEditJson: "Edit JSON",
		muxedAudioCarrying: "Carrying {key} inside these segments.",
		qcDisabledCarriedBlock:
			"This plan carries a QC/VMAF block, but QC/VMAF is turned off for this deployment — starting it will be refused. Remove the block to continue, or enable QC/VMAF in Settings.",
		qcDisabledRemoveBlock: "Remove the QC block",
		// QC gate editor .
		qcGateHint:
			"Threshold rules over the VMAF/PSNR measurement. PER_RENDITION holds every rung to the bar; OVERALL judges the ladder mean. MARK_ONLY records the verdict; BLOCK_MANIFESTS holds manifest generation until the gate passes (or an operator forces delivery).",
		qcGateHintMoreInformation: "QC gate — more information",
		qcGateAddRule: "Add gate rule",
		qcGateRemoveRule: "Remove gate rule",
		qcGateTargets: "Target renditions (none selected = all)",
		qcGateOnFail: "On fail",
		qcGatePsnrOffOption: "{metric} (enable PSNR first)",
		qcGateBlockNeedsPost:
			"Blocking requires every manifest to be generated after encoding — just-in-time manifests exist before the measurement can run.",
		// Delivery-spec drift banner .
		deliverySpecLoaded: "Delivery spec: {name}",
		deliveryCommitmentLabel: "Enforcement",
		deliveryCommitNone: "Banner only (no commitment)",
		deliveryCommitWarn: "Record deviations and proceed (WARN)",
		deliveryCommitRefuse: "Refuse submission on deviation (REFUSE)",
		deliveryDrift: "Deviates from {name}: {count} item(s)",
		deliveryDriftShow: "Show deviations",
		deliveryDriftHide: "Hide deviations",
		deliveryDriftDismiss: "Dismiss",
		deliveryDriftRequirement: "Requirement",
		deliveryDriftFound: "Found",
		deliveryDriftAbsent: "(absent)",
		importLiveMustBeObject: "A live channel plan must be a JSON object",
		importMustBeObject: "A plan must be a JSON object",
		importNotValidJson: "Not valid JSON: {detail}",
		importParseError: "parse error",
		reasonUsesUnrepresentedOptions:
			"uses options the wizard form can't represent yet",
		reasonCannotBeRebuilt: "can't be rebuilt from the wizard form",
		reasonNotAValidPlan: "is not a valid encoding plan",
		adaptationSetsCount: "Adaptation sets ({count})",
		aiSceneAnalysis: "AI Scene Analysis",
		audioNBitrate: "Audio {n} bitrate",
		audioNSampleRate: "Audio {n} sample rate",
		audioWord: "audio",
		bitmovinAccountFromPlan: "Bitmovin account from plan:",
		c9PairsIvSize:
			"The IV size follows the encryption mode automatically: {pairing}",
		completeValidPlanToDiff:
			"Complete a valid plan to diff it against “{name}”.",
		concatenationKey: "Concatenation ({key})",
		concatenationStreamsCount: "Concatenation streams ({count})",
		couldNotLoadPreset: "Could not load preset",
		couldNotLoadPresetNamed: "Could not load preset “{name}”.",
		deinterlaceFiltersCount: "Filter definitions ({count})",
		// Multi-output delivery  — provenance lives HERE, not in
		// the rendered copy: an operator cannot resolve a registry number.
		deliveryMirrorsHint:
			"Every rendition and manifest is ALSO written to each mirror, at the same paths and ACL — one encode, several storages.",
		derivedPathHint:
			'Relative to the base output path — empty = derived "{path}". Per-title outputs need {uuidToken}/{bitrateToken} placeholders.',
		enableCodecPerTitle: "Enable {codec} per-title configuration",
		encryptionDrmCount: "Encryption / DRM ({count})",
		extraContainerOf: "extra container of {key}",
		fieldsDifferOne: "{count} field differs from “{name}” (preset → current).",
		fieldsDifferOther:
			"{count} fields differ from “{name}” (preset → current).",
		identicalToNamed: "Identical to “{name}”.",
		importedPlan: "Imported plan",
		inputFileN: "Input file {n}",
		inputFilesCount: "Input files ({count})",
		issueCountOne: "{count} issue",
		issueCountOther: "{count} issues",
		kantarAudioWatermarking: "Kantar audio watermarking",
		keyColon: "key:",
		keyframesAdCuesCount: "Keyframes — ad cues ({count})",
		labelsAndInfrastructure: "Labels & infrastructure",
		loadedPreset: "Loaded preset",
		loadedPresetTail:
			" into the wizard. The sample credentials were cleared — pick your own in the Sources and Output steps, then review each step before starting.",
		loadingNamed: "Loading “{name}”…",
		loadingPreset: "Loading preset",
		locationLabelForSection: "{label} for {section}[{index}]",
		mediaKey: "Media {key}",
		missingInputParen: "(missing input)",
		missingParen: "(missing)",
		multiEncodingPartitionCount: "Multi-encoding partition ({count})",
		noExtraOptionsFor: "No extra options for {label}.",
		notDeclaredParen: "(not declared)",
		onSuffix: " (on)",
		operationsCount: "{count} operations",
		placeholderTokensHint:
			"These tokens stand in for real object paths — fill in yours. Run-time placeholders like {height}/{bitrate}/{uuid} stay in the plan and are not listed.",
		placeholdersMustBeReplaced:
			"{count} placeholder value(s) must be replaced before starting",
		presetDoesNotExist: " — it does not exist.",
		presetFallbackReason:
			"This preset {reason}, which the step-by-step wizard form doesn't cover yet — it's loaded as an editable plan you can resolve below and submit directly.",
		qualityControlVmaf: "Quality control (VMAF)",
		removeAdaptationSetN: "Remove adaptation set {n}",
		removeAudioN: "Remove audio {n}",
		removeConcatenationStreamN: "Remove concatenation stream {n}",
		removeEncodingN: "Remove encoding {n}",
		removeFilterAttachmentN: "Remove filter attachment {n}",
		removeFilterN: "Remove filter {n}",
		removeInputFileN: "Remove input file {n}",
		removeKeyframeN: "Remove keyframe {n}",
		removeManifestN: "Remove manifest {n}",
		removeSourceN: "Remove source {n}",
		removeStreamKey: "Remove stream {key}",
		removeSubtitleN: "Remove subtitle {n}",
		removeTrimmingStreamN: "Remove input clip {n}",
		removeVideoN: "Remove video {n}",
		replacementCredentialFor: "Replacement credential for {id}",
		replacementFor: "Replacement for {token}",
		samplePlaceholderPaths: "{count} sample placeholder path(s)",
		schemaColon: "Schema:",
		setKeyConflictingTypes:
			'set key "{key}" has conflicting types across manifests — rename one; the validator will block type mismatches',
		setSuffix: " (set)",
		sourceN: "Source {n}",
		streamsCount: "Streams ({count})",
		subtitleWord: "subtitle",
		toResolveCount: "{count} to resolve",
		tokenPathsLabel: "Paths using {token}",
		tokenUsedAt: "{token} — used at {paths}",
		trimSourceKey: "Clip · {source} ({key})",
		trimmingStreamsCount: "Input clips ({count})",
		videoNBitrate: "Video {n} bitrate",
		videoNHeight: "Video {n} height",
		videoWord: "video",
		vmafV1DockerWorker: "{model} (VMAF v1 — bundled model)",
	},
	tokens: {
		active: "Active",
		dismissSecret: "I stored it — dismiss",
		expired: "Expired",
		expiresDays: "Expires in (days, optional)",
		expiresDaysHint: "Empty = never expires.",
		intro:
			"Bearer tokens authenticate scripts and CI against /api/* for the current organization. Tokens issued here have at most OPERATOR permissions, further limited by the issuer's current membership and role. The secret is stored only as a hash and shown exactly once. Tokens cannot mint tokens.",
		lastUsed: "last used",
		listHeading: "Tokens",
		mint: "Mint token",
		mintFailed: "Could not mint the token.",
		mintHeading: "Mint a token",
		mintedHint:
			"Stored as a hash only — this value cannot be shown again. Send it as: Authorization: Bearer <secret>",
		mintedOnce: 'Token "{name}" minted — copy the secret NOW:',
		name: "Name",
		never: "never",
		noneYet: "No tokens yet.",
		revoke: "Revoke",
		revokeFailed: "Revoking failed — the token is STILL ACTIVE. Retry.",
		revokeLatencyHint:
			"Once revocation is saved, subsequent token checks reject it. Requests already authorized may still complete.",
		confirmRevoke: "Revoke permanently?",
		created: "created",
		expires: "expires",
		listFailed: "Could not load the token list.",
		revoked: "Revoked",
		title: "API tokens",
	},
	users: {
		title: "Users",
		intro:
			"Per-user accounts with roles. VIEWER reads; OPERATOR runs jobs and channels; ADMIN also manages credentials, settings, and users. A created user gets a temporary password shown once — they must change it at first sign-in.",
		createHeading: "Create a user",
		email: "Email",
		emailHint: "The email address used to log in to this account.",
		displayName: "Display name",
		role: "Role",
		create: "Create user",
		createFailed: "Could not create the user.",
		createdOnce: 'User "{email}" created — copy the temporary password NOW:',
		createdHint:
			"Shown once. They sign in with it and must set their own password immediately. It expires in 72 hours.",
		dismissTempPassword: "I sent it — dismiss",
		listHeading: "Users",
		listFailed: "Could not load the user list.",
		noneYet: "No users yet.",
		active: "Active",
		inactive: "Inactive",
		lastLogin: "last sign-in",
		never: "never",
		mustChange: "must change password",
		deactivate: "Deactivate",
		reactivate: "Reactivate",
		resetPassword: "Reset password",
		resetConfirm: "Issue a new temporary password?",
		changeOwnPassword: "Change my password",
		changeRole: "Change role",
		actionFailed: "The change did not apply. Retry.",
		you: "you",
	},
	wizardDraft: {
		available: "Saved draft available",
		restore: "Restore",
		discard: "Discard",
		help: "Saved for 7 days on this browser. Secrets, URLs, DRM, filter settings and imported JSON are excluded. Review these before starting.",
	},
	templates: {
		savedDeliveryHeading: "Saved delivery presets",
		emptyDelivery:
			"No saved delivery presets yet. Import a delivery specification below to save one.",
		savedView: "Saved",
		deliveryView: "Delivery presets",
		samplesView: "Samples",
		retry: "Retry",
		loadVodFailed: "Could not load VOD templates.",
		loadLiveFailed: "Could not load live templates.",
		loadDeliveryFailed: "Could not load saved delivery presets.",
		deleteFailed: "Could not delete this template. Try again.",
		deliveryDeleteFailed: "Could not delete this preset. Try again.",
		deliveryDeleteBlockedByRules:
			"Watch rules reference this preset. Remove those references before deleting it.",
		heading: "Templates",
		intro:
			"A template is a hardened workflow saved for reuse: launching one asks only for the source files, the output prefix, and a name — everything else is the template's. Save one from the VOD wizard's preset panel.",
		loading: "Loading…",
		empty: "No templates yet.",
		emptyHint:
			"Build a job in the VOD wizard and save it as a preset — it appears here as a launchable template.",
		revision: "rev {n}",
		usesAndUpdated: "{uses} uses · updated {date}",
		launch: "Launch",
		createVodJob: "Create VOD job",
		createLiveChannel: "Create live channel",
		edit: "Edit",
		delete: "Delete",
		confirmDelete: "Really delete?",
		deleteBlockedByRules:
			"Watch rules reference this template — delete or repoint them first.",
		launchTitle: "Launch \u201C{name}\u201D",
		notAPlan: "This template's body is not a valid encoding plan.",
		sources: "Sources",
		sourceOriginal: "Template's own path — leave as-is to re-run it.",
		sourceMoved: "Overridden for this launch.",
		browse: "Browse",
		noSources: "This plan has no file sources (nothing to substitute).",
		outputPrefix: "Output prefix",
		outputPrefixPreview: "Rendered: {preview}",
		jobName: "Job name",
		create: "Create job",
		creating: "Creating…",
		editInWizard: "Edit details in the wizard instead",
		updateTemplate: "Update template",
		updating: "Updating…",
		editingBanner:
			"Editing template \u201C{name}\u201D — updating changes future launches; already-launched jobs keep their copies.",
		launchLiveTitle: "Launch channel from \u201C{name}\u201D",
		notALivePlan: "This template's body is not a valid live channel plan.",
		channelName: "Channel name",
		createChannel: "Create channel",
		filterAll: "All",
		filterJobs: "Job templates",
		filterChannels: "Channel templates",
		kindJob: "Job",
		kindChannel: "Channel",
		saveAsTemplate: "Save as template",
		templateName: "Template name",
		templateSaved: "Saved as template \u201C{name}\u201D.",
		saveTemplateFailed: "Save failed: {error}",
		livePrefixEmpty:
			"The output prefix rendered EMPTY — a launch writing at the template's own paths would overwrite the previous channel's output. Give it a non-empty prefix.",
		editConflict:
			"This template was modified since you loaded it — reload the page and re-apply your edit.",
	},
	ui: {
		aChannelWithoutAManifestHasNo:
			"A channel without a manifest has no playback surface — enable HLS and/or DASH.",
		aMovieFileNeedsItsVideoStream:
			"A movie file needs its video stream at position 0 and must match the live stream exactly (codec, resolution, framerate) plus the same audio layout. Images (PNG, JPEG, GIF, BMP, TIFF, WebP and more) have no intrinsic length, so durationInSeconds is REQUIRED when scheduling an image; for movies it is optional and truncates a longer file or loops a shorter one.",
		aTimeBasedRescheduleCloudConnectAccounts:
			" a time-based reschedule. Cloud Connect accounts are managed under Settings → Infrastructure.",
		accountDefaultRtmpInputResolvedByListing:
			"Account-default RTMP input — resolved by listing (the API has no create)",
		acquisitionPointIdentity: "Acquisition point identity",
		adAvailOffsetMs: "Ad avail offset (ms)",
		adBreakLengthSignalledToDownstreamSystems:
			"Ad-break length signalled to downstream systems",
		adInsertion: "Ad insertion",
		adMarkersSource: "Ad markers source",
		addAudio: "Add audio",
		addBackup: "Add backup",
		addIngestPoint: "Add ingest point",
		addStaticPoint: "Add static point",
		addVideo: "Add video",
		adinsertionsettingsEnableesammediapointinser:
			"adInsertionSettings.enableEsamMediaPointInsertion",
		all: "All",
		allLegs: "(all legs)",
		audioGroupId: "Audio group id",
		audioLanguage: "Audio language",
		audioMuxingPin: "Audio muxing pin",
		audioRenditionsAacDdDd: "Audio renditions (AAC / DD+ / DD)",
		autoRestart: "Auto-restart",
		autoShutdown: "Automatic stop",
		automaticallyRestartWhenTheEncodingHitsAn:
			"Automatically restart when the encoding hits an error. On for unattended self-healing channels; off if you want a failure to stop and surface for inspection.",
		availabilityStartTime: "Availability start time",
		back: "Back",
		backupSrtInputsFailover: "Backup SRT inputs (failover)",
		basics: "Basics",
		bitmovinAccount: "Bitmovin account",
		bitmovinAposS: "Bitmovin’s",
		bitmovinDialsYourSourceHost: "Bitmovin dials your source host",
		bitmovinListensYourEncoderCallsTheEncoder:
			"Bitmovin listens — your encoder calls the encoder IP",
		bitmovinOvp: "Bitmovin OVP",
		bitmovinPullsAnHlsSourceUrl: "Bitmovin pulls an HLS source URL",
		bitrateBps: "Bitrate (bps)",
		blocked: "blocked",
		browse: "Browse…",
		browseABucketAndChooseTheSource:
			"Browse a bucket and choose the source file.",
		browseStorageFillsCredentialBucketKeyThe:
			"Browse storage fills credential/bucket/key — the file is spooled locally at run time",
		bucket: "Bucket",
		bucketNameManual: "Bucket name (manual)",
		byDefaultAMarkerAppearsInThe:
			"By default a marker appears in the playlist before the break starts. AWS MediaTailor expects the marker only once the break begins — turn this on when MediaTailor (or a similar ad server) mis-times breaks.",
		bytesReadTimeoutS: "Bytes read timeout (s)",
		bytesWrittenTimeoutS: "Bytes written timeout (s)",
		c19WhenAnHlsManifestSetsA:
			"When an HLS manifest sets a program-date-time SOURCE, it must MATCH this mode — mismatching an HLS PDT source FAILS the encoding (set only one, or align both). Empty = not sent.",
		cacheControl: "Cache-Control",
		campaignAUhd: "campaign-a, uhd",
		cancel: "Cancel",
		cancelTheJobBeforeDeleting: "Cancel the job before deleting",
		carrierIsFmp4OnlyTsHasNo:
			"carrier is fMP4-only (TS has no emsg box), and DASH requires fMP4. Insert cues from the channel page once the channel is running.",
		cbcIv16Bytes: "CBC → IV_16_BYTES",
		channelLayout: "Channel layout",
		channelName: "Channel name",
		clockSynchronizationMode: "Clock synchronization mode",
		close: "Close",
		cloudRegion: "Cloud region",
		codec: "Codec",
		commaSeparatedEncodingLabelsTagsThatGroup:
			"Comma separated — Encoding.labels tags that group results in Bitmovin statistics; empty = none",
		completeTheRequiredFields: "— complete the required fields —",
		configuredInSettingsBitmovinAccounts:
			"Configured in Settings → Bitmovin accounts",
		confirm: "Confirm",
		container: "Container",
		copyPlanJson: "Copy plan JSON",
		create: "Create",
		createChannelImportedPlan: "Create channel (imported plan)",
		createFailed: "Create failed",
		createLiveChannel: "Create live channel",
		creating: "Creating…",
		credential: "Credential",
		ctrIv8Bytes: "CTR → IV_8_BYTES",
		curlUnavailable: "cURL unavailable",
		curlNoEndpoint: "No single Bitmovin endpoint maps to {kind}",
		curlUnresolvedPathParams:
			"Could not resolve all URL path parameters for {kind}",
		curlNoStepEntry: "The step entry is unavailable",
		dagaaaaaaaaapWdwaa: "/DAgAAAAAAAAAP/wDwAA…",
		dashDvrBudgetC8: "DASH DVR budget",
		dashManifest: "DASH manifest",
		dashManifestIntervalS: "DASH manifest interval (s)",
		dashManifestsUpdateTimeoutS: "DASH manifests update timeout (s)",
		dashPlayback: "DASH playback",
		dashTemplateManifest: "DASH template manifest",
		dashTimelineManifest: "DASH timeline manifest",
		decryptionType: "Decryption type",
		default: "(default)",
		defaultExtXDaterange: "(default EXT_X_DATERANGE)",
		defaultSinglePeriod: "(default SINGLE_PERIOD)",
		defaultXmlBin: "(default XML_BIN)",
		defaultsSinglePeriodXmlBin: "(defaults SINGLE_PERIOD / XML_BIN)",
		delayThresholdS: "Delay threshold (s)",
		delete: "Delete",
		deleteThisJob: "Delete this job?",
		deleteThisVmafReport: "Delete this VMAF report?",
		deleting: "Deleting…",
		disablePreAnnouncing: "Disable pre-announcing",
		disablePreAnnouncingMoreInformation:
			"Disable pre-announcing — more information",
		discardImport: "Discard import",
		dolbyDigital: "Dolby Digital+",
		dolbyDigital2: "Dolby Digital",
		dynamicRtmpEncoderIpApplication:
			"Dynamic (rtmp://<encoder-ip>/<application>)",
		eachInputFileIsOneObjectThe:
			"Each input file is one object the job reads — its own credential, bucket and object path. The first is the primary video source (required); add more for a separate audio master, Dolby sidecars, or subtitles. A Stream below references a file; its path is the file's, never re-entered.",
		eachMediaSegmentImmutableOnceWritten:
			"Each media segment — immutable once written",
		embedsAnInaudibleKantarWatermarkInThe:
			"Embeds an inaudible Kantar watermark in the AUDIO renditions — a video-only plan watermarks nothing and is rejected by the plan validator. This is an ENCODING-level singleton: one configuration per encoding, and it is applied to every sibling encoding of a multi-encoding ladder. The Kantar service login and password are vault-only (managed in Settings → Credentials under “Kantar audio watermarking”) — the plan carries the credential reference, never the login itself.",
		emptyClStereo: "Empty = CL_STEREO",
		emptyNoDvrWindowLiveEdgeOnly: "Empty = no DVR window (live edge only)",
		emsg: "emsg",
		enableEsamMediaPointInsertion: "Enable ESAM media-point insertion",
		enableEsamMediaPointInsertionInThe:
			"Enable ESAM media point insertion in the live wizard's start options BEFORE starting the channel; it cannot be turned on for an already-running encoding. Match time is when the signal should be matched into the stream (leave blank to insert as soon as possible); each signal's offset shifts it relative to that match, as an ISO 8601 duration such as PT10S or -PT1.5S.",
		enableScte35AdMarkers: "Enable SCTE-35 ad markers",
		encoderVersion: "Encoder version",
		encodingPlacementAdvanced: "Encoding placement (advanced)",
		endpointTakesOnlyAnInfrastructureIdIt:
			"endpoint takes ONLY an infrastructure id — it moves this encoding onto a different Cloud Connect (BYOC) infrastructure. It is ",
		esamMediaPointInsertionMoreInformation:
			"ESAM media-point insertion — more information",
		esamPoisScte250: "ESAM / POIS (SCTE-250)",
		eventStreamSignalling: "Event stream signalling",
		everySourceBeyondTheImplicitVideoAudio:
			"Every source beyond the implicit video/audio pair: extra ingest tracks, WebVTT subtitle sidecars, and Dolby Atmos / Vision / metadata inputs — one list. Each stream reads a declared input file; renditions and subtitle tracks reference them by label under Placement & extras.",
		// Explain restart triggers and viewer impact before the API minimum.
		everyTimeoutHasAnApiMinimumOf:
			"When an input loss, a stalled output or an unresponsive encoder is detected, the encoder restarts automatically. The broadcast is interrupted while it restarts, which viewers see as a break in the stream. Every timeout has an API minimum of 30s — shorter values are rejected, not rounded up.",
		extXDaterange: "#EXT-X-DATERANGE",
		failedToListObjects: "Failed to list objects",
		failedToLoadCredentials: "Failed to load credentials.",
		failoverDelayThresholdS: "Failover delay threshold (s)",
		ffmpegLoopFeedersReStreamLoop1:
			"Loop feeders that push a storage MP4 into this channel's ingest on repeat. Sessions are one-shot: stop, then create a new one.",
		ffprobeReturnedNoRecognizableFormatOrStream:
			"ffprobe returned no recognizable format or stream data — the raw output is below.",
		ffprobeStreams: "ffprobe streams",
		firstConnectTimeoutMin: "First-connect timeout (min)",
		fixTheValidationErrorsAboveToCompile:
			"— fix the validation errors above to compile the operation list —",
		fmp4InitMp4ImmutableForTheLife:
			"fMP4 init.mp4 — immutable for the life of the channel",
		framesWrittenTimeoutS: "Frames written timeout (s)",
		gateForInsertingEsamMediaPointsWhile:
			"Gate for inserting ESAM media points while the channel runs: the encoder keeps at least one SCTE-35 data stream so a POIS-driven media point can be applied. Without it the ESAM settings above only report signals.",
		generateCreatesOneAssignUsesAnAccount:
			"GENERATE creates one; ASSIGN uses an account StreamKey id",
		generatesDefaultVodManifestsOverThisChannel:
			"Generates default VOD manifests over this channel’s recording, written next to it in the output this channel already uses.",
		guardAudioRenditionsWithAudiostreamcountGt0:
			"Guard audio renditions with AUDIOSTREAMCOUNT > 0 (only output audio when the input has an audio stream)",
		guiFirstOnlineVideoPlatformExposingThe:
			"Encoding GUI with the goal of covering the full Bitmovin Encoding API",
		heightP: "Height (p)",
		hideImport: "Hide import",
		hint: "hint",
		hlsDvrBudgetC8: "HLS DVR budget",
		hlsManifest: "HLS manifest",
		hlsManifestIntervalIsDeliberatelyAbsentThe:
			"HLS manifest interval is deliberately absent — the Bitmovin API marks it unused (the master playlist re-uploads on every media-playlist change regardless).",
		hlsManifestsUpdateTimeoutS: "HLS manifests update timeout (s)",
		hlsMediaEntryWritesAnExtX:
			"HLS media entry — writes an EXT-X-MEDIA line for this rendition: group id ties the audio variants together, name is the player-facing label, uri the media playlist. Required per audio rendition when variants are multiplied per audio group (dolby presets); leave absent otherwise.",
		hlsMultiVariantPlaylist: "HLS multi-variant playlist",
		hlsPlayback: "HLS playback",
		hlsPull: "HLS pull",
		hlsVariantPlaylist: "HLS variant playlist",
		host: "Host",
		howMuchOfTheExistingDvrWindow:
			"How much of the existing DVR window survives the reset",
		howOftenTheTagRepeats: "How often the tag repeats",
		identifiesThisEncoderToThePoisScte:
			"Identifies this encoder to the POIS (SCTE-250 AcquisitionPointIdentity)",
		importPlanJson: "Import plan JSON…",
		importedPlanActiveTheFormIsBypassed:
			"Imported plan active — the form is bypassed and the JSON is submitted verbatim.",
		incomplete: "incomplete",
		// Automatic stop can end a broadcast before the planned end; billing continues until it completes.
		independentOfAutoRestartARestartDoes:
			"Stops the channel automatically when a condition is met: no input for a set time, the total run time reaching its limit, or no first connection within a set time. It can stop before the planned end of the program, and billing continues until the stop completes. Independent of auto-restart — a restart does NOT reset these timers.",
		infrastructureAdvanced: "Infrastructure (advanced)",
		infrastructureId: "Infrastructure id",
		infrastructureRegion: "Infrastructure region",
		ingestPointsExactlyOneModeTheSdk:
			"Ingest points (exactly one mode — mixing is not allowed)",
		initSegment: "Init segment",
		injectedIntoBitmovinAccountidTheOneException:
			"Injected into bitmovin.accountId — the one exception to verbatim submission",
		input: "Input",
		inputIdOrPasteOneFromAnother: "input id (or paste one from another org)",
		inputKind: "Input kind",
		inputName: "Input name",
		insertExtXProgramDateTimeTags: "Insert EXT-X-PROGRAM-DATE-TIME tags",
		intervalSeconds: "Interval (seconds)",
		intervalSegments: "Interval (segments)",
		job: "job",
		k128Aes128: "128 (AES-128)",
		k1Low: "1% low",
		k1LowMoreInformation: "1% low — more information",
		k256Aes256: "256 (AES-256)",
		k30sUnsetApiDefaultNeverSendsAn:
			"≥30s; unset = API default. “Never” sends an explicit null to disable re-uploads.",
		keyLength: "Key length",
		labels: "Labels",
		ladder: "Ladder",
		latencyMs: "Latency (ms)",
		leaveEveryBoxClearToSendThe:
			"Leave every box clear to send the default set. Add types only for a player/packager that needs them — extra tags are inert elsewhere.",
		lettersOnlyAZAZ3:
			"Letters only (a–z, A–Z), 3–20 characters — ^[a-zA-Z]{3,20}$",
		streamKeyManagedByStaticPoint:
			"Set by the static ingest point (GENERATE / ASSIGN); the start request's key is filled in automatically.",
		listenerBitmovinListensOrCallerBitmovinDials:
			"Listener (Bitmovin listens) or caller (Bitmovin dials your source)",
		listenerPort: "Listener port",
		listingUnavailableTypeBelow: "Listing unavailable — type below",
		noBucketsListedTypeBelow:
			"The listing succeeded but returned no buckets — the account may have none, or this key cannot see them. Type a bucket name below to open it directly.",
		liveChannelPlanJson: "Live channel plan JSON",
		liveEdgeOffsetS: "Live edge offset (s)",
		liveEncodingMode: "Live encoding mode",
		livePresets: "Live presets",
		loadInWizard: "Load in wizard",
		loadPlan: "Load plan",
		loadingYourPresets: "Loading your presets…",
		localTimeSentAsUtc: "Local time, sent as UTC",
		localTimeSentAsUtcBlankInserts:
			"Local time, sent as UTC — blank inserts as soon as possible",
		locationPresets: "Location presets:",
		loopOffsetConfidenceDrift: "loop offset · confidence · drift",
		manifestName: "Manifest name",
		manifests: "Manifests",
		maxAcceptedTransmissionLatencyBothPartiesMax:
			"Max accepted transmission latency — both parties' max wins",
		maximumOverallStreamDuration: "Maximum overall stream duration",
		meanVmafVsBitrate: "mean VMAF vs bitrate",
		meanVmafVsBitrateOneCurvePer: "mean VMAF vs bitrate · one curve per report",
		mediaSegment: "Media segment",
		millisecondsAddedToTheStreamtimePtsOf:
			"Milliseconds added to the StreamTime/PTS of outbound signals — negative pulls the signal earlier",
		min: "Min",
		minBitrateBps: "Min bitrate (bps)",
		minMoreInformation: "Min — more information",
		minimumUpdatePeriodMs: "Minimum update period (ms)",
		mode: "Mode",
		moreInformation: "More information",
		mostRecentOutputSegmentsToAlign10:
			"Most-recent output segments to align (10–600s)",
		moveFailed: "Move failed",
		movflagsFaststart: "-movflags +faststart",
		mpdWrittenForSegmenttemplateRepresentations:
			"MPD written for SegmentTemplate representations",
		mpdWrittenForSegmenttimelineRepresentations:
			"MPD written for SegmentTimeline representations",
		multipleIngestPointsWithAutomaticFailover:
			"Multiple ingest points with automatic failover",
		mustMatchTheVaultedPassphrase12816:
			"Must match the passphrase saved in the credential (AES-128: 16 characters; AES-256: 32 characters).",
		muxingInitFileIntervalS: "Muxing init-file interval (s)",
		myPresets: "My presets",
		namedBucketPrefixShortcutsOfferedAsOne:
			" — named bucket+prefix shortcuts offered as one-click choices in the VOD wizard’s “Browse storage…” pickers.",
		navigateToTheDestinationPrefixThenUse:
			"Navigate to the destination prefix, then use it as the output base.",
		neverReUploadNull: "never re-upload (null)",
		newLiveChannel: "New Live Channel",
		next: "Next",
		noBackupsTheSingleSrtConnectionIs:
			"No backups — the single SRT connection is the only source.",
		noPassphrase: "No passphrase",
		noVideoRenditionsAudioOnlyChannelsAre:
			"No video renditions — audio-only channels are unusual; add at least one video rung for playback.",
		none: "None",
		none2: "(none)",
		not: "not",
		oncePerPlaylistWritesOneTagPer:
			"ONCE_PER_PLAYLIST writes one tag per playlist; the *_INTERVAL modes repeat it",
		onlyValidWhenNoCodecConfigSets:
			"Only valid when no codec config sets an encoding mode",
		open: "Open",
		operations: "Operations",
		optionalEmptyTheAccountDefaultResolveBy:
			"Optional. Empty = the account-default resolve-by-list above; a pinned id is used verbatim (no listing) — set it when the account carries several RTMP inputs.",
		optionalStreamPathId: "Optional stream path/id",
		optionalZoneRegionTagSentWithEvery:
			"Optional zone/region tag sent with every signal",
		orTypeBucket: "or type bucket",
		outOfBandAdSignalingTheEncoder:
			"Out-of-band ad signaling: the encoder reports every detected SCTE-35 message to a POIS and applies the response. POIS basic auth rides a POIS_ENDPOINT vault credential referenced by id — manage it in Settings → Credentials; the username/password never enter the plan and resolve at start. Runtime media-point insertion additionally needs the ad-insertion gate below.",
		outputCredential: "Output credential",
		outputFolder: "Output folder",
		outputsScte35MarkersSoAnInserted:
			"Outputs SCTE-35 markers so an inserted cue is visible downstream. HLS works with both fMP4 and TS — the",
		overview: "Overview",
		p1MoreInformation: "p1 — more information",
		passphraseCredential: "Passphrase credential",
		pasteALivechannelplanEGALive:
			"Paste a LiveChannelPlan — submitted verbatim",
		path: "Path",
		pdtSource: "PDT source",
		perArtifact: "Per-artifact",
		perRenditionMediaPlaylistsRefreshedEverySegm:
			"Per-rendition media playlists — refreshed every segment on live",
		periodOption: "Period option",
		pickALivePresetTheValidatorWarns:
			"Pick a LIVE_* preset — the validator warns on VOD presets",
		pickAnInputObject: "Pick an input object",
		pickAnOutputPrefix: "Pick an output prefix",
		pickOneOfThisProviderSInfrastructures:
			"Pick one of this provider's infrastructures, or paste an id from another organisation.",
		pickOrTypeABucket: "Pick or type a bucket.",
		pinOneFamilyWhenRenditionsCarryFmp4:
			"Pin one family when renditions carry FMP4 + TS legs",
		pinThisEncodingOntoACloudConnect:
			"Pin this encoding onto a Cloud Connect (BYOC) infrastructure — Cloud Connect accounts are managed in Settings → Infrastructure. Both fields are required together; the region here is the one INSIDE the infrastructure, and the encoding’s own cloud region switches to EXTERNAL automatically (Bitmovin requires it for Cloud Connect).",
		pinThisEncodingOntoACloudConnect2:
			"Pin this encoding onto a Cloud Connect (BYOC) infrastructure — Cloud Connect accounts are managed in Settings → Infrastructure. Both fields are required together; the region here is the one INSIDE the infrastructure, and the channel’s own cloud region switches to EXTERNAL automatically (Bitmovin requires it for Cloud Connect).",
		pinnedEncoderVersion: "Pinned encoder version",
		pinnedVersion: "Pinned version…",
		pinnedVersionEG22660: "Pinned version, e.g. 2.266.0",
		placementMode: "Placement mode",
		planJson: "Plan JSON",
		planLevelFilterResourcesAttachThemPer:
			"Plan-level filter resources — attach them per rendition under Placement & extras.",
		playerFailedToLoad: "Player failed to load",
		playlistTagsAreWrittenAtTheManifest:
			"playlist tags are written at the manifest level. The in-segment",
		poisCredentialId: "POIS credential id",
		poisEndpoint: "POIS endpoint",
		poisEndpointVaultCredentialUsernamePasswordI:
			"POIS_ENDPOINT vault credential (username + password) — id only; empty = unauthenticated POIS",
		port: "Port",
		prefixBreadcrumb: "Prefix breadcrumb",
		preset: "Preset",
		programDateTimeSettings: "Program-date-time settings",
		psnrDb: "PSNR (dB)",
		psnrDb2: "PSNR dB",
		psnrMeanMoreInformation: "PSNR mean — more information",
		publicMaxAge0NoCache: "public, max-age=0, no-cache",
		rawRequest: "Request",
		rawResponse: "Response",
		rawSnapshots: "Raw request/response",
		rawSnapshotsLabel: "Step {step} — persisted snapshots (redacted)",
		reUploadSettings: "Re-upload settings",
		redundantRtmp: "Redundant RTMP",
		refs: "refs",
		relativeToTheChannelSOutputEmpty:
			"Relative to the channel's output; empty = the recording's own folder. Bitmovin requires a default manifest to sit ABOVE every muxing it lists, so only that folder or one of its parents is accepted.",
		remove: "Remove",
		representationType: "Representation type",
		reprioritizeFailed: "Reprioritize failed",
		requiredForImageContentTruncatesLoopsMovies:
			"Required for image content; truncates/loops movies",
		requiredForLiveFixedLaddersOnly: "Required for live — fixed ladders only",
		reschedule: "reschedule",
		reservedInSettingsInfrastructureConsumedWhen:
			"Reserved in Settings → Infrastructure; consumed when the encoding is CREATED — an already-USED IP puts the encoding in ERROR",
		resourceId: "resource id",
		resources: "Resources",
		responseUnavailableStepRanButNoResponse:
			"response unavailable (step ran but no response was recorded)",
		restartIfDashManifestsStopUpdatingFor:
			"Restart if DASH manifests stop updating for this long (min 30s). Set when DASH is a primary output.",
		restartIfHlsManifestsStopUpdatingFor:
			"Restart if HLS manifests stop updating for this long (min 30s). Set when HLS is your primary delivery and a frozen playlist is the failure you care about.",
		restartIfNoDataAtAllIs:
			"Restart if no data at all is written for this long (min 30s). A coarser stall guard that catches any output stoppage.",
		restartIfNoFramesAreEncodedFor:
			"Restart if no frames are encoded for this long (min 30s). Catches a decode/pipeline stall upstream of muxing.",
		restartIfNoSegmentsAreWrittenFor:
			"Restart if no segments are written for this long (min 30s). The most direct 'output stalled' watchdog for segmented output.",
		restartOnEncoderError: "Restart on encoder error",
		restartOnEncoderErrorMoreInformation:
			"Restart on encoder error — more information",
		review: "Review",
		reviewThePlanOnTheRightThe:
			"Review the plan preview — the operation list is exactly what will be provisioned, in order. The channel is created and provisioning starts immediately; stop and restart are actions on the channel afterwards.",
		rtmp: "RTMP",
		rtmpEncoderIpLive: "rtmp://<encoder-ip>/live",
		rtmpInputId: "RTMP input id",
		running: "running",
		s3AzureBlobSftpLiveSegmentsAnd:
			"S3 / Azure Blob / SFTP — live segments and manifests land here",
		sameForAudioLegs: "Same for audio legs",
		samplePresets: "Sample presets",
		sampleRateHz: "Sample rate (Hz)",
		scheduleExpression: "Schedule expression",
		schemaDefaultVodWarns: "(schema default — VOD, warns)",
		sdkPassthroughEGAes128: "Passed to the Bitmovin API as-is, e.g. AES_128",
		searchPresets: "Search presets",
		searchTitleDescriptionFamily: "Search title, description, family…",
		secondsWithoutSignalBeforeSwitchingIngestPoi:
			"Seconds without signal before switching ingest points",
		secondsWithoutSignalBeforeSwitchingToA:
			"Seconds without signal before switching to a backup",
		segmentLengthS: "Segment length (s)",
		segmentsWrittenTimeoutS: "Segments written timeout (s)",
		segmenttemplateVsSegmenttimeline: "SegmentTemplate vs SegmentTimeline",
		selectABitmovinAccountInStep1:
			"Select a Bitmovin account in step 1 before creating.",
		selectAccount: "Select account…",
		selectBucket: "Select bucket…",
		selectCredential: "Select credential…",
		// Owner request 2026-08-19: register a credential without abandoning
		// a half-filled wizard. The copy says NEW TAB because the form's
		// state does not survive a route change.
		addCredentialNewTab: "Add a credential (opens a new tab)",
		sharedByEveryMuxingFeedsTheC8:
			"Shared by every muxing — feeds the DVR element budget",
		shiftAppliedToTheWindowStart: "Shift applied to the window start",
		showingTheFirst500InputsOnlyPaste:
			"Showing the first 500 inputs only — paste the id if yours is not listed.",
		shutDownAfterNoInputBytesFor:
			"Shut down after no input bytes for this long",
		shutDownIfNoEncoderEverConnects: "Shut down if no encoder ever connects",
		signalProcessingUrlTheEncoderPostsA:
			"Signal-processing URL — the encoder POSTs a SignalProcessingEvent whenever it detects a SCTE-35 message",
		signalingDeliveryAdvanced: "Signaling & delivery (advanced)",
		singlePeriodKeepsOneContinuousPeriodMulti:
			"SINGLE_PERIOD keeps one continuous period; MULTI_PERIOD splits a new period at every cue (needed by some ad servers, harder on players)",
		sourceHost: "Source host",
		sourcePort: "Source port",
		sourceUrl: "Source URL",
		srt: "SRT",
		srtIsCallerOnlyTheFeederDials:
			"SRT is caller-only: the feeder dials Bitmovin's listener",
		srtListenerPortsAreRestrictedTo2088:
			"SRT LISTENER ports are restricted to 2088–2091 (a Bitmovin constraint)",
		start: "Start",
		starting: "starting…",
		staticIpId: "Static IP id",
		staticRtmpsIngest: "Static ({url})",
		stitchOrderedSourceInputStreamsIntoOne:
			"Stitch ordered source input streams into one. Exactly one source must be marked main (the reference for scaling, aspect ratio, FPS and sample rate). A rendition reads the result by selecting it under Placement & extras.",
		stop: "Stop",
		stream: "Stream",
		streamKey: "Stream key",
		streamKeyConfig: "Stream key config",
		streamTimeoutMin: "Stream timeout (min)",
		streamkeyId: "StreamKey id",
		suggestedFromTheChannelEditable: "Suggested from the channel — editable",
		suggestedPresentationDelayMs: "Suggested presentation delay (ms)",
		systemClockTheEncoderClockEmbeddedTimestamps:
			"SYSTEM_CLOCK = the encoder clock; EMBEDDED = timestamps carried in the ingest",
		theBitmovinInputResourceHoldingTheFile:
			"The Bitmovin input resource holding the file — pick one, or paste an id",
		theChannelNameIsAppendedAutomaticallyOutputs:
			"The channel name is appended automatically — outputs land under <folder>/<channel name> (video/{heightToken}p, audio/{bitrateToken}; manifests at the base).",
		theMasterM3u8UsuallyShortLivedRendition:
			"The master .m3u8 — usually short-lived (rendition list can change)",
		thisReportFinishedWithNoRenditionResults:
			"This report finished with no rendition results.",
		thisSessionOnlyMediaPointsAreNot:
			"(this session only — media points are not recorded in the step log; see the API audit log for history)",
		timeshiftDvrWindowS: "Timeshift / DVR window (s)",
		trimASourceInputStreamToA:
			"Clip a source input stream to a sub-range (the modern input-stream path, independent of the start request's `trimming` field). A rendition reads the clip by selecting it under Placement & extras.",
		ts: "TS",
		tsHlsOnlyAacOnly: "TS = HLS-only, AAC-only",
		tsHlsOnlyH264Only: "TS = HLS-only, H264-only",
		type: "Type",
		unsetApiDefaultsToTheSegmentDuration:
			"Unset = API defaults to the segment duration",
		unsetNotWrittenToTheMpd: "Unset = not written to the MPD",
		searchInputsByName: "Search inputs by name",
		search: "Search",
		prewarmedPoolIds: "Prewarmed pool ids (this plan)",
		perPlanPoolPinningHint:
			"Pin THIS encoding onto prewarmed pools — overrides nothing; account defaults still apply when empty",
		couldNotListInfrastructures: "Could not list infrastructures",
		infrastructureFamiliesSkipped:
			"Some families could not be listed ({families}) — paste the id if yours is there",
		noInfrastructuresInAccount:
			"No Cloud Connect infrastructures in this account",
		infrastructuresInAccount: "Infrastructures in this account",
		infrastructureIdCopyLabel: "infrastructure id",
		couldNotListStaticIps: "Could not list static IPs",
		noStaticIpsInAccount: "No static IPs reserved in this account",
		staticIpsTruncated:
			"Showing {shown} of {total} static IPs — paste the id if yours is not listed",
		staticIpsInAccount: "Static IPs in this account",
		staticIpIdCopyLabel: "static IP id",
		useCurrentPrefix: "Use current prefix",
		useTheUseAsInputActionOn: "Use the “Use as input” action on a file row.",
		usesTheAccountSDefaultRtmpInput:
			"Uses the account's default RTMP input, resolved by listing — if the account has none, or more than one, provisioning fails with a clear error instead of guessing.",
		usingAPastedIdNotInThe: "Using a pasted id — not in the list above.",
		validateAmpLoad: "Validate & load",
		validateSaveAmpCompare: "Validate, save & compare",
		vaultSrtPassphraseRefResolvedAtSpawn:
			"Vault SRT_PASSPHRASE ref — resolved at spawn, never persisted",
		vaultSrtPassphraseRefThePassphraseItself:
			"Vault SRT_PASSPHRASE ref — the passphrase itself never enters a plan",
		vaultZixiRefPasswordAndOrDecryption:
			"Vault ZIXI ref (password and/or decryption key) — required",
		videoMuxingPin: "Video muxing pin",
		videoRenditionsH264H265: "Video renditions (H264 / H265)",
		vmafLab: "VMAF Lab",
		vmafLab2: "← VMAF Lab",
		vodPresetsLivePresetVodWarning: "VOD presets (LIVE_PRESET_VOD warning)",
		waitForTheReportToFinishBefore:
			"Wait for the report to finish before deleting",
		whenBothAreSetMismatchedModesFail:
			"when both are set — mismatched modes FAIL the encoding.",
		whereScte35MarkersAreReadFrom: "Where SCTE-35 markers are read from",
		whereThePdtWallClockComesFrom:
			"Where the PDT wall-clock comes from and how often it is written. A source set here must MATCH the start request’s ad insertion",
		wizardSteps: "Wizard steps",
		xmlBinCarriesTheBinarySpliceInfo:
			"XML_BIN carries the binary splice info as Signal.Binary; XML writes the parsed SCTE-35 as XML elements",
		zixi: "Zixi",
		zixiBroadcasterPull: "Zixi broadcaster pull",
		zixiCredential: "Zixi credential",
		zixiFeederExampleCom: "zixi-feeder.example.com",
		zoneIdentity: "Zone identity",
	},
	origin: {
		// Name the output side being monitored.
		title: "Output monitoring",
		explainer:
			"Read directly from the media playlists at the output destination — a check independent of the encoder's self-report.",
		lastFetch: "read {at}",
		noneYet:
			"Output monitoring has not started yet — it begins within seconds of the channel running.",
		unavailable:
			"The output state cannot be confirmed. Check the output destination and its access permissions.",
		summaryUnavailable: "Origin observation unavailable",
		playlistReadLimitReached:
			"Some HLS checks are incomplete (256 KiB read limit).",
		playlistReadLimitHelp:
			"The last origin check reached the read limit for at least one playlist. Its completeness and progress cannot be determined; incomplete content is not used to judge staleness or ENDLIST. Check manifest size and DVR settings. Push/Poll reports are separate evidence.",
		stale: "STALE",
		advancing: "advancing",
		edgeDelay: "edge delay {s}s",
	},
	startup: {
		reSaveForAccount:
			"no Bitmovin account — re-save this destination to pick the account probes run under",
		runsUnder: "runs under {account}",
		account: "Bitmovin account",
		pickAccount: "Pick an account…",
		title: "Startup times",
		explainer:
			"How long each region takes from start to RUNNING, measured on this installation's own channel starts. Queue time isolates Bitmovin's encoder allocation from our resource-creation calls.",
		window: "Window",
		windowDays: "Last {days} days",
		loadFailed: "Could not load startup profiles.",
		empty: "No samples yet — profiles appear after the first channel start.",
		region: "Region",
		source: "Source",
		failures: "Failures",
		censored: "Censored",
		max: "Max",
		sourceChannel: "Channel",
		sourceProbe: "Probe",
		smallNNote:
			"Rows without P50/P90 have too few samples for percentiles to be honest (fewer than 20) — max and counts are shown instead.",
		probeDestination: "Probe destination",
		probeDestinationExplainer:
			"Startup probes write ONLY to this explicitly designated area — never to any customer output. Saving verifies the credential can DELETE here (a sentinel-key check): probe cleanup is the app's only destructive storage operation and a list-only credential must fail now, not after ten probes.",
		abandonAfter: "abandon after {minutes} min",
		noDestinationYet: "No probe destination designated yet.",
		credential: "Credential",
		pickCredential: "Pick a credential…",
		bucket: "Bucket",
		prefix: "Prefix",
		prefixHint: "8+ chars — short prefixes are refused",
		abandonDeadline: "Abandon deadline (min)",
		verifyingDelete: "Verifying delete permission…",
		saveDestination: "Verify & save",
		designationFailed: "Could not save the probe destination.",
		deleteVerified: "Delete permission verified and saved.",
		runProbes: "Run startup probes",
		runProbesExplainer:
			"Each probe starts a REAL minimal live encoder in the region, measures time to RUNNING, stops it and deletes its output. Probes bill; they run serially, and results carry the probe's 1-rendition shape.",
		probeCount: "Probes",
		worstCaseLine:
			"Worst case: {count} probes × up to {perProbe} min each (abandon deadline + stop wait) ≈ {minutes} min total encoder time if every probe hangs to its deadline.",
		acknowledgeWorstCase: "I acknowledge the worst-case cost above.",
		launchProbes: "Launch probes",
		destinationFirst: "Designate a destination first.",
		launchFailed: "Could not enqueue the probe batch.",
		probesEnqueued:
			"Probe batch enqueued — results appear in the table above as samples land.",
		probeList: "Probes",
		noProbesYet: "No probes have run yet.",
		strandedProbe: "stop unconfirmed — open and retry stop (blocks data reset)",
		openProbe: "Open",
	},
	runs: {
		loadFailed: "Could not load the channel run history.",
		loading: "Loading run history…",
		empty: "No runs yet — this channel has never been started.",
		seq: "Run #{n}",
		window: "{from} → {to}",
		queueSeconds: "queue {s}s",
		heading: "Runs",
	},
	uiX: {
		matchCountOne: "{count} match",
		matchCountOther: "{count} matches",
		opPayloadLabel: "Step {step} — operation payload",
		opsListFailed: "Could not load the operation list.",
		opsListLabel: "{name} — compiled operations",
		scanningThePrefix: "Scanning the prefix…",
		downsampledExportFull:
			"downsampled for display · export for the full {frames}-frame series",
		perFrameVmaf: "Per-frame VMAF",
		addOrCheckCredentials: "Add or check them in Settings → Credentials.",
		cacheControlHint:
			"headers written on upload. Honoured on S3 / GCS / Azure outputs only — other providers ignore them (the plan validator warns). Empty = the provider default.",
		couldNotStartNewRun: "Could not start a new run",
		enterTheBucketName: "— enter the bucket name:",
		failedToLoadDnsMappings: "Failed to load DNS mappings",
		failedToLoadRegisteredContent: "Failed to load registered content",
		failedToLoadSchedule: "Failed to load the schedule",
		heartbeatHistoryHint:
			"Per-poll packet deltas over the last {minutes} minutes (30s sweep). Dots mark ingest-status changes (green = connected, amber = otherwise). Lifetime totals are in the current-state panel above.",
		heartbeatHistoryRunHint:
			"Per-poll packet deltas for this ENTIRE run (30s sweep). Dots mark ingest-status changes (green = connected, amber = otherwise).",
		logTailAutoRefreshing: ", auto-refreshing",
		logTailShowing: "(last {count} scrubbed lines{suffix})",
		loopBoundariesShowing:
			"(showing last {shown} of {total} — wall clock vs source stream time; VMAF alignment input)",
		thisJobIsUnchanged: " This job is unchanged.",
		vmafOnlyManifestsNote:
			"VMAF only is on (Encoding options → Quality control): this encode produces just the per-video QC mirror files (MP4, or WebM for VP9), so HLS/DASH muxings and manifests are skipped. Turn VMAF only off to configure delivery manifests.",
		vmafOnlyPackagingNote:
			"VMAF only is on (Encoding options → Quality control): this encode emits just the per-video QC mirror files (MP4, or WebM for VP9), so delivery muxings, thumbnails and sprites are skipped. Turn VMAF only off to configure them.",
		pickTwoReportsTail: ", tick two or more reports, then choose “{label}”.",
		libvmafModelTooltip:
			"Use the same model for reports you compare. The standard viewing condition is recommended for most comparisons.",
		dashRepushTooltip:
			"How often to re-push the DASH manifest (min 30s, or 'never' = explicit null to disable). Set when an MPD must refresh on a fixed cadence behind a cache that won't otherwise revalidate.",
		encodingsHoldingAKey:
			"Encodings holding a key, and this app's live channels",
		initRepushTooltip:
			"How often to re-upload the fMP4 init segment (min 30s, or 'never'). Set to recover from an origin/CDN that may drop or corrupt the init file mid-stream.",
		inputIdNoun: "input id",
		inputsInThisAccount: "Inputs in this account",
		jobOutputPathHint:
			"The job name is appended automatically — outputs land under <folder>/<job name> (video/{heightToken}p, audio/{bitrateToken}).",
		noInputsInAccount:
			"No inputs in this Bitmovin account — create one (or run an encoding) first, or paste an id below.",
		objectPath: "Object path",
		outputFolderLabel: "Output folder",
		outputStep: "Output",
		restartOnFixedSchedule:
			"Restart on a fixed schedule (Unix crontab). For planned maintenance restarts of a 24/7 channel — not tied to any failure.",
		shutDownNeverConnects:
			"Shut down if the source never connects within this window after start. Reclaims a channel started early whose encoder never showed up.",
		shutDownNoInput:
			"Shut down if no input arrives for this long. Use this to limit idle runtime after the source disconnects.",
		shutDownTotalRuntime:
			"Shut down after this total runtime regardless of input. Use this to limit runtime for an event of known duration.",
		defaultEn: 'Default "en"',
		defaultEnglishSample: 'Default "english - sample"',
		defaultStreamIsm: 'Default "stream.ism"',
		defaultStreamIsmc: 'Default "stream.ismc"',
		defaultSubtitle: 'Default "SUBTITLE"',
		defaultSubtitlesEnM3u8: 'Default "subtitles_en.m3u8"',
		emptyAudio: 'Empty = "audio"',
		emptyEnLang: 'Empty = "en"',
		emptyHlsInput: 'Empty = "HLS Input"',
		emptyRedundantRtmpInput: 'Empty = "Redundant RTMP Input"',
		emptySrtInput: 'Empty = "SRT Input"',
		dvrBudgetTooltip:
			"Live DVR/timeshift manifests list every still-available segment; Bitmovin holds ~54,000 elements total. Each rendition adds (timeshift ÷ segment length) segments, so a longer window, shorter segments, or more renditions raise the count. Keep the window under ~3h (10,800s) — larger manifests slow updates. This gauge never clamps your value; it only warns past ~80% of budget.",
		liveEdgeOffsetTooltip:
			"How far behind the newest segment players start. Recommended ~10–12s (about 2–3 segment durations — Bitmovin's reference samples use 10–12). Larger = more latency but more buffer headroom against ingest/CDN jitter; smaller = lower latency but higher rebuffer risk near the live edge.",
		hlsLiveEdgeOffsetTooltip:
			"Buffer in seconds before HLS manifest segment publication, not the player's playback start position. A smaller value reduces publication delay but leaves less headroom for input and delivery jitter.",
		hlsLiveEdgeOffsetDefaultHint:
			"Empty uses the service default (120 seconds), which may add publication delay. Enter seconds before starting to change it.",
		hlsTimeshiftDefaultHelp:
			"Empty uses the service default; it does not mean no DVR.",
		emptyStreamM3u8: 'Empty = "stream.m3u8"',
		emptyStreamMpd: 'Empty = "stream.mpd"',
		emptyZixiInput: 'Empty = "Zixi Input"',
		iso6391CommaSeparated: 'ISO 639-1, comma separated — "en" is implicit',
		unixCrontabExample: 'Unix crontab, e.g. "0 5 * * 1"',
		fixValidationForTemplateYaml:
			"— fix the validation errors above to export Template YAML (Plan JSON stays available) —",
		cancelSelected: "Cancel selected",
		cancelSelectedCount: "Cancel selected ({count})",
		driftDetectedFullOne:
			"Drift detected: the offset spans {count} frame across the window (per-segment offsets {offsets}). The encoder/clock skew shifted the alignment over the capture — scores near the window edges are less reliable.",
		driftDetectedFullOther:
			"Drift detected: the offset spans {count} frames across the window (per-segment offsets {offsets}). The encoder/clock skew shifted the alignment over the capture — scores near the window edges are less reliable.",
		esamRejectsTail: "— Bitmovin rejects the insertion otherwise.",
		ffprobeNoData:
			"ffprobe returned no recognizable format or stream data — the raw output is below.",
		ffprobeStreamsCaption: "ffprobe streams",
		inspectBoundedTailRest:
			", or just run the encoding — that reads the full input.",
		liveToVodTail:
			" recording, so a manifest generated while segments are still being written would be truncated. (status: {status})",
		noBrowsableCredential:
			"No browsable credential — add an AWS S3 credential in Settings.",
		asOfSweep: "as of {when} (30s sweep)",
		credentialsUnavailable: "Credentials unavailable — see the error above.",
		deletePresetLabel: "Delete preset {label}",
		failedCount: "· {count} failed",
		feederSession: "Feeder session",
		feedersAttachRunningOnly:
			"Feeders attach to RUNNING or PROVISIONING channels only (status: {status}) — the create will be rejected.",
		ffprobeBoundedTitle:
			"{bucket}/{key} — ffprobe over a bounded read (a capped head, plus at most one capped retry slice). Overall bitrate is shown as — because a bounded read cannot establish it. Per-stream values and raw JSON remain ffprobe observations.",
		healthy: "healthy",
		sampleStale:
			"Sample is stale — the last sweep is older than the vouching window.",
		ingestStatusBadge: "ingest {status}",
		lastCueInsertedAt: "Last cue inserted at",
		lastMediaPointInsertedAt: "Last media point inserted at",
		logTail: "Log tail",
		loopBoundaries: "Loop boundaries",
		newJobQueued: "New job queued.",
		openJobId: "Open {id} →",
		pickTwoReportsHead:
			"Pick at least two finished VMAF reports to compare — open the",
		pidValue: "Process ID {pid}",
		priorityRangeHint:
			"{min}–{max} (default {dflt}). Higher priority runs first among your organisation's queued encodings, so it only has an effect while the run is still waiting for capacity.",
		readBytes: "read {bytes}",
		scanTruncated:
			"{matches} so far — the scan stopped after {scanned} objects, so there may be more. Keep scanning with “Load more”, or open a narrower folder.",
		scanWholePrefix:
			"{matches} — {scanned} objects scanned, whole prefix covered.",
		selectCredentialToBrowse: "Select a credential to start browsing.",
		startedStopped: "started {started} · stopped {stopped}",
		stepsFraction: "{done}/{total}",
		targetProtocolMasked: "Target ({protocol}; stream key masked)",
		thisPollLifetime: "this poll · lifetime {total}",
		timeshiftResetRunningOnly:
			"Timeshift can only be reset on a RUNNING channel (status: {status}).",
		unhealthy: "unhealthy",
		concurrentCount: "{count} concurrent",
		coresCountOne: "{count} core",
		coresCountOther: "{count} cores",
		driftSpreadTail: "; spread ≤ 1 frame).",
		noDriftHead: "No drift detected (per-segment offsets",
		bitrateAxis: "bitrate",
		bitrateAxisWithUnit: "bitrate (kbps)",
		captureRejected: "Capture rejected: {message}",
		capturedFramesLine:
			"{captured} captured frames · {source}-frame source @ {fps}",
		copyCoordinate: "Copy {label}",
		copyLabelledValue: "Copy {label}: {value}",
		copyUriFor: "Copy URI for {name}",
		copyValue: "Copy {value}",
		couldNotListInputs: "Could not list this account's inputs",
		deleteJobNamed: "Delete “{name}”?",
		deleteNJobsOne: "Delete {count} job?",
		deleteNJobsOther: "Delete {count} jobs?",
		deleteNReportsOne: "Delete {count} report?",
		deleteNReportsOther: "Delete {count} reports?",
		deletePresetNamed: "Delete preset {name}",
		downsampledSeries: "downsampled · {shown} of {total} series",
		driftDetectedOne:
			"Drift detected: the offset spans {count} frame across the window — VMAF is aligned per segment, not globally.",
		driftDetectedOther:
			"Drift detected: the offset spans {count} frames across the window — VMAF is aligned per segment, not globally.",
		encodingIdLine: "encoding {id}",
		fromEncodingJob: "from encoding job",
		heightAxis: "height",
		heightAxisWithUnit: "height (px)",
		hlsPlaybackFailed: "HLS playback failed ({type})",
		idNoun: "id",
		insertionRejected: "Insertion rejected: {message}",
		libvmafThreadsOne: "{count} libvmaf thread",
		libvmafThreadsOther: "{count} libvmaf threads",
		loadingList: "Loading {list}",
		loopsInWindowOne: "{count} loop in window",
		loopsInWindowOther: "{count} loops in window",
		noDriftDetected:
			"No drift detected (per-segment offsets {offsets}; spread ≤ 1 frame).",
		noPresetsMatch:
			"No presets match “{query}” — try a family name like “dolby” or “per-title”.",
		onlyRunningCanBeMoved: "Only a running job can be moved (status: {status})",
		onlyRunningCanBeReprioritized:
			"Only a running job can be reprioritized (status: {status})",
		opsCount: "{count} ops",
		pasteAnIdBelow: "{message} — paste an id below.",
		presetCountOne: "{count} preset",
		presetCountOther: "{count} presets",
		psnrForRendition: "{rendition} PSNR",
		removeSignalN: "Remove signal {n}",
		reportCountOne: "{count} report",
		reportCountOther: "{count} reports",
		renditionCountOne: "{count} rendition",
		renditionCountOther: "{count} renditions",
		renditionsOmittedOne:
			"{count} rendition without a {axis} omitted from the ladder.",
		renditionsOmittedLabel: "Omitted from the ladder",
		renditionsOmittedOther:
			"{count} renditions without a {axis} omitted from the ladder.",
		reportShortId: "Report {id}",
		requestResponseAt: "request / response ({when})",
		insertionAccepted: "Insertion accepted",
		insertionUnverified: "Outcome unverified",
		insertionProtocol: "Acceptance record (advanced)",
		insertionAcceptedHelp:
			"This records acceptance of the insertion request, not successful video or audio delivery. For the current run, check the provider reservations and the actual output. Once a reservation disappears from the provider, its outcome is not retained in this history.",
		resourceCreatedByStep: "{id} (created by {step})",
		runningOn: "Running on {parts}",
		savedCount: "{count} saved",
		scenariosCount: "{count} scenarios",
		scoredUnitsOne: "Scored {done}/{total} unit",
		scoredUnitsOther: "Scored {done}/{total} units",
		scte35BinaryMax: "SCTE-35 binary (base64, ≤{max})",
		selectJobNamed: "Select {name}",
		selectReport: "Select report {label}",
		selectReportUnavailable:
			"Select report {label} (unavailable — still {status})",
		selectedCount: "{count} selected",
		selectedJobsCount: "{count} selected jobs",
		selectedReportsCount: "{count} selected reports",
		seriesCount: "{count} series",
		seriesShown: "Series ({shown}/{total} shown)",
		skippedReportsOne: "Skipped {count} report that failed to load:",
		skippedReportsOther: "Skipped {count} reports that failed to load:",
		stepsProgress: "{done}/{total} steps",
		stoppedSiblingsOne:
			"Stopped {count} sibling encoding (still billing when this step failed)",
		auditErrorLabel: "Bitmovin call error",
		stoppedSiblingsLabel: "Stopped sibling encodings (ids)",
		stoppedSiblingsOther:
			"Stopped {count} sibling encodings (still billing when this step failed)",
		toggleSeries: "Toggle series {label}",
		upToNJobsPerBulk: "Up to {max} jobs per bulk request",
		upToNReportsCompared:
			"Up to {max} reports can be compared — deselect a few",
		upToNReportsPerBulk: "Up to {max} reports per bulk request",
		applicationName: "application name",
		audioRendition: "Audio rendition",
		backup: "Backup",
		bitmovinAccountFromPlan: "Bitmovin account from plan:",
		couldNotDuplicateInvalidPlan:
			"Couldn't duplicate channel {name} — its stored plan is no longer a valid live plan. Starting from a blank form.",
		couldNotDuplicateUnrepresentedOptions:
			"Couldn't duplicate channel {name} — its plan uses options the step-by-step form can't represent, so opening it here would build a different channel. Starting from a blank form.",
		couldNotLoadChannelToDuplicate:
			"Could not load channel {id} to duplicate. Check the link and retry.",
		countOfLabel: "{label} ({count})",
		dashSignalling: "DASH signalling",
		duplicatedFromNamed:
			"Duplicated from “{name}”. Edit any fields — fix the account, input, or stream key — then create a fresh channel.",
		dvrPerLegLabel: "Segments per rendition leg",
		dvrLegName: "leg {n}",
		dvrLegSegments: "{count} segments",
		dvrMathMixed:
			"Σ ceil({timeshift}s / segmentLength) over {renditions} renditions = {total} of ~{budget} elements",
		dvrMathUniform:
			"ceil({timeshift}s / {segment}s) = {segments} segments × {renditions} renditions = {total} of ~{budget} elements",
		dvrMathUniformOne:
			"ceil({timeshift}s / {segment}s) = {segments} segments × {renditions} rendition = {total} of ~{budget} elements",
		hlsPlaylistMarkers: "HLS playlist markers",
		ingestPoint: "Ingest point",
		intervalRequiredFor: "interval is required for {mode}",
		maxInBudgetTimeshift: "Max in-budget timeshift for this ladder:",
		modeField: "mode",
		moreInformationFor: "{label} — more information",
		nameField: "name",
		namedNField: "{item} {n} {field}",
		noDvrWindowHint:
			"DVR budget is not estimated. Empty timeshift uses the service default. Set a positive timeshift and valid segment configuration to estimate the manifest-element budget (~{budget} elements).",
		overBudgetBlocks:
			"Over the ~{budget}-element budget — validation blocks this plan. Shorten the timeshift, lengthen segments, or trim the ladder (values are never clamped for you).",
		overBudgetPct: "+{pct}% over budget",
		pctOfBudget: "{pct}% of budget",
		recommendedSecTail: "({sec}s) — Bitmovin recommends ≤ 3h.",
		removeNamedN: "Remove {item} {n}",
		staticPoint: "Static point",
		videoRendition: "Video rendition",
	},
	ingest: {
		availableOnceRunning: "— available once the channel is RUNNING —",
		backupListenerN: "Backup listener {n}",
		bitmovinCallsHost: "Bitmovin calls {host}:{port}",
		dynamicIngestPointHint:
			"Dynamic ingest point — failover switches automatically",
		encoderIp: "Encoder IP",
		fullRtmpTarget: "Full RTMP target",
		fullRtmpTargetHint:
			"URL + stream key combined (players/encoders that take one string)",
		hlsSourceHint: "Bitmovin pulls this HLS source",
		hlsSourceUrl: "HLS source URL",
		ingestPointNamed: "Ingest point {name}",
		rtmpPushUrl: "RTMP push URL",
		rtmpPushUrlHint:
			"Point the encoder here; the stream key below is the stream name",
		srtCallerHint: "Encoder runs in caller mode",
		srtCallerHintWithPassphrase:
			"Encoder runs in caller mode; the vaulted passphrase must match",
		srtCallerTarget: "SRT caller target (Bitmovin listens)",
		srtSourceBitmovinCalls: "SRT source (Bitmovin calls you)",
		srtSourceHint:
			"Run your encoder in listener mode at this address — Bitmovin dials it",
		startRequestStreamKeyHint:
			"Start-request stream key (not the SRT passphrase)",
		staticIngestPointHint:
			"Fixed-FQDN ingress; the stream key comes from the StreamKey resource",
		staticIngestPointNamed: "Static ingest point {name}",
		streamKey: "Stream key",
		zixiSource: "Zixi source",
		zixiSourceHint:
			"Bitmovin pulls from this Zixi broadcaster (credentials from the vault)",
	},
	presetGallery: {
		// Family labels + one title/description pair per SAMPLE_PRESETS name
		// (keys ARE the stable preset names — : core is UI-free, the
		// copy lives here; the gallery's totality test fails on a missing pair).
		family: {
			"ai-scene-analysis": "AI Scene Analysis",
			"audio-only": "Audio-only",
			"dash-timeline": "DASH segment timeline",
			dolby: "Dolby Vision & Atmos",
			drm: "DRM",
			filters: "Filters",
			"fixed-bitrate": "Fixed bitrate",
			"forensic-watermark": "Forensic watermark",
			hdr10: "HDR10",
			keyframes: "Keyframes (ad cues)",
			pertitle: "Per-Title",
			webvtt: "WebVTT subtitles",
		},
		"ai-scene-analysis-batch-item": {
			title: "AI Scene Analysis — batch-runner item",
			description:
				"One parameterized instantiation of the AISA batch driver: per-title H264 + asset description, HLS+DASH.",
		},
		"ai-scene-analysis-passthrough": {
			title: "AI Scene Analysis — MP4 passthrough",
			description:
				"Minimal video-only H264 MP4 plus an AI Scene Analysis asset description with ja/ko outputs (encoder BETA).",
		},
		"ai-scene-analysis-passthrough-test": {
			title: "AI Scene Analysis passthrough (test-run variant)",
			description:
				"Structural clone of the AISA passthrough as executed by the test_ script (paths redacted).",
		},
		"ai-scene-analysis-pertitle": {
			title: "AI Scene Analysis — per-title H264",
			description:
				"H264 per-title ladder with automatic ad-placement cue tags and multi-language AISA output, HLS+DASH post-encoding.",
		},
		"ai-scene-analysis-pertitle-test": {
			title: "AI Scene Analysis per-title (test-run variant)",
			description:
				"Structural clone of the per-title AISA run as executed by the test_ script (paths redacted).",
		},
		"audio-only-aac-fmp4-hls-dash": {
			title: "Audio-only AAC → fMP4 HLS+DASH",
			description:
				"AAC-only ladder with no video track — audio-only adaptation sets and HLS_V6 audio variant streams.",
		},
		"cenc-cbc-drm-on-aws": {
			title: "CENC cbcs DRM (Widevine+PlayReady+FairPlay) on fMP4, DASH+HLS",
			description:
				"Five-rung H264 ladder; every fMP4 muxing encrypted with CENC CBC carrying Widevine PSSH, PlayReady LA-URL and FairPlay iv/uri (16-byte IV).",
		},
		"dash-hls-sftp-output-just-in-time": {
			title: "SFTP origin output — JIT manifests",
			description:
				"H264+AAC fMP4 to an SFTP origin with HLS+DASH generated just-in-time with the encoding start.",
		},
		"dash-hls-sftp-output-post-encoding": {
			title: "SFTP origin output — post-encoding manifests",
			description:
				"The SFTP pair's POST_ENCODING half: the same plan with manifests generated after FINISHED.",
		},
		"dash-template-and-timeline-on-aws": {
			title: "DASH SegmentTemplate vs SegmentTimeline, side by side",
			description:
				"One encoding, two DASH manifests — template.mpd (TEMPLATE) and timeline.mpd (TIMELINE) over the same fMP4 muxings.",
		},
		"deinterlace-filter": {
			title: "Deinterlace filter chain",
			description:
				"A DEINTERLACE filter (auto-enable META_DATA_AND_CONTENT_BASED) attached to the video stream before encoding.",
		},
		"dolby-atmos-progressive-mp4": {
			title: "Dolby Atmos → progressive MP4",
			description:
				"Audio-only Atmos DAMF master muxed into a single progressive MP4 download — no manifests.",
		},
		"dolby-audio-only-atmos-adm": {
			title: "Audio-only Dolby Atmos (ADM) → HLS+DASH",
			description:
				"ADM BWF Atmos master to a 448k DOLBY_ATMOS rendition with HLS_V8 audio-variant streams and DASH.",
		},
		"dolby-audio-only-atmos-damf": {
			title: "Audio-only Dolby Atmos (DAMF) → HLS+DASH",
			description:
				"DAMF Atmos master to a 448k DOLBY_ATMOS rendition with HLS_V8 audio-variant streams and DASH.",
		},
		"dolby-dv-3ladder-profile5-dash-ondemand": {
			title: "DV P5 three-ladder → DASH OnDemand",
			description:
				"Three sibling encodings merged into a single-MP4 SegmentBase DASH OnDemand manifest (DVH1 sample entries, no HLS).",
		},
		"dolby-dv-atmos-adm": {
			title: "Dolby Vision + Atmos ADM, fMP4 DASH+HLS",
			description:
				"DV mezzanine (embedded metadata) to a DOLBY_VISION H265 rendition plus ADM Atmos audio.",
		},
		"dolby-dv-atmos-adm-https": {
			title: "Dolby Vision + Atmos ADM over HTTPS input",
			description:
				"The DV+ADM flow fed from an auth-free HTTPS host input instead of S3.",
		},
		"dolby-dv-atmos-damf": {
			title: "Dolby Vision + Atmos DAMF, fMP4 DASH+HLS",
			description:
				"DV mezzanine (embedded metadata) to a DOLBY_VISION H265 rendition plus DAMF Atmos audio.",
		},
		"dolby-dv-atmos-damf-aac": {
			title: "Dolby Vision + Atmos DAMF + AAC fallback",
			description:
				"Adds an AAC ladder beside the Atmos group — multi-audio-group HLS with media entries per group.",
		},
		"dolby-dv-atmos-damf-https": {
			title: "Dolby Vision + Atmos DAMF over HTTPS input",
			description:
				"The DV+DAMF flow fed from an auth-free HTTPS host input instead of S3.",
		},
		"dolby-dv-ddp-multi-audio": {
			title: "Dolby Vision + DD+/DD/AAC multi-audio",
			description:
				"DV H265 ladder with Atmos-sourced DDPLUS, DD and AAC fallbacks across HLS audio groups and DASH sets.",
		},
		"dolby-dv-embedded-ddp": {
			title: "Dolby Vision (embedded metadata) + DD+",
			description:
				"DV with container-embedded metadata and a DDPLUS 5.1 track, fMP4 DASH+HLS.",
		},
		"dolby-dv-hdr10-sdr-2ladder-profile81": {
			title: "DV P8.1 + SDR two-ladder multi-encoding",
			description:
				"Two sibling encodings (Dolby Vision Profile 8.1 and SDR) merged into shared DASH adaptation sets and a variants-per-audio-group HLS master with Atmos+AAC.",
		},
		"dolby-dv-hdr10-sdr-2ladder-profile81-test": {
			title: "DV P8.1 + SDR two-ladder (test-run variant)",
			description:
				"Structural clone of the 2-ladder run as executed by the test_ script (paths redacted).",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs": {
			title: "DV P5 / HDR10 / SDR three-ladder (DV + SDR inputs)",
			description:
				"Three sibling encodings fed by separate DV and SDR mezzanines, merged manifests post-encoding.",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs-test": {
			title:
				"DV P5 / HDR10 / SDR three-ladder, DV+SDR inputs (test-run variant)",
			description:
				"Structural clone of the DV+SDR-inputs 3-ladder run as executed by the test_ script (paths redacted).",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-single-input": {
			title: "DV P5 / HDR10 / SDR three-ladder (single input)",
			description:
				"Three sibling encodings derived from one DV mezzanine, merged into one DASH+HLS manifest pair post-encoding.",
		},
		"dolby-dv-hdr10-sdr-3ladder-profile5-single-input-test": {
			title:
				"DV P5 / HDR10 / SDR three-ladder, single input (test-run variant)",
			description:
				"Structural clone of the single-input 3-ladder run as executed by the test_ script (paths redacted).",
		},
		"dolby-dv-separated-metadata-adm": {
			title: "Dolby Vision separated metadata + Atmos ADM",
			description:
				"DV video plus a standalone VISION_METADATA XML sidecar read from a second S3 input — the multi-input scenario.",
		},
		"fixed-bitrate-dash-hls-streamcondition-on-aws": {
			title: "Fixed-bitrate DASH+HLS + audio guard (AWS S3)",
			description:
				"HLS and DASH manifests over the guarded H264+AAC fMP4 ladder.",
		},
		"fixed-bitrate-dash-hls-streamcondition-on-azure": {
			title: "Fixed-bitrate DASH+HLS + audio guard (Azure Blob)",
			description:
				"The dual-manifest guarded ladder on Azure Blob input/output.",
		},
		"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws": {
			title: "Fixed-bitrate DASH+HLS + thumbnails (AWS S3)",
			description:
				"The guarded dual-manifest ladder plus a per-stream thumbnail extraction.",
		},
		"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-azure": {
			title: "Fixed-bitrate DASH+HLS + thumbnails (Azure Blob)",
			description: "The thumbnail variant on Azure Blob input/output.",
		},
		"fixed-bitrate-hls-on-aws": {
			title: "Fixed-bitrate H264+AAC → HLS (AWS S3)",
			description:
				"The canonical starter: 2-rung H264 ladder + 2 AAC tracks, fMP4 segments, one just-in-time HLS manifest on S3.",
		},
		"fixed-bitrate-hls-on-azure": {
			title: "Fixed-bitrate H264+AAC → HLS (Azure Blob)",
			description:
				"The starter ladder with Azure Blob input and output instead of S3.",
		},
		"fixed-bitrate-hls-streamcondition-on-aws": {
			title: "Fixed-bitrate HLS + audio guard (AWS S3)",
			description:
				"Adds Condition(AUDIOSTREAMCOUNT > 0) on every audio rendition so inputs without an audio stream skip audio outputs.",
		},
		"fixed-bitrate-hls-streamcondition-on-azure": {
			title: "Fixed-bitrate HLS + audio guard (Azure Blob)",
			description:
				"The AUDIOSTREAMCOUNT-guard variant on Azure Blob input/output.",
		},
		"fixed-bitrate-hls-vtt-on-aws": {
			title: "WebVTT subtitles on fMP4 HLS (AWS S3)",
			description:
				"Sidecar .vtt file stream → WEBVTT rendition → chunked-text muxing + subtitles media entry in the HLS master.",
		},
		"fixed-bitrate-hls-vtt-on-azure": {
			title: "WebVTT subtitles on fMP4 HLS (Azure Blob)",
			description: "The WebVTT sidecar chain on Azure Blob input/output.",
		},
		"hdr10-pertitle": {
			title: "HDR10 per-title (H265 MAIN10 + PQ)",
			description:
				"MAIN10/PQ/BT.2020 with mastering metadata (master display, MaxCLL/MaxFALL) and per-title autoRepresentations, HLS_V8 + DASH.",
		},
		"keyframes-segment-aligned": {
			title: "Ad-cue keyframes — segment-aligned",
			description:
				"Encoding-level keyframes at ad-break times that land on the segment grid (clean cuts, unchanged segment count).",
		},
		"keyframes-segment-non-aligned": {
			title: "Ad-cue keyframes — non-aligned",
			description:
				"Ad-break keyframes off the segment grid, splitting segments mid-stream.",
		},
		"mp4-fixed-bitrate-hls-on-aws": {
			title: "MP4 byte-range HLS (AWS S3)",
			description:
				"One progressive MP4 per rendition enumerated via EXT-X-BYTERANGE — the non-segmented HLS path.",
		},
		"mp4-fixed-bitrate-hls-on-azure": {
			title: "MP4 byte-range HLS (Azure Blob)",
			description: "The byte-range HLS path on Azure Blob input/output.",
		},
		"mp4-fixed-bitrate-hls-vtt-on-aws": {
			title: "WebVTT subtitles on MP4 byte-range HLS (AWS S3)",
			description:
				"The WebVTT sidecar chain over the single-MP4 byte-range HLS variant.",
		},
		"mp4-fixed-bitrate-hls-vtt-on-azure": {
			title: "WebVTT subtitles on MP4 byte-range HLS (Azure Blob)",
			description: "The byte-range WebVTT variant on Azure Blob input/output.",
		},
		"nexguard-watermarking": {
			title: "NexGuard forensic watermarking (A/B outputs)",
			description:
				"FileMarker OTT watermarking per video stream producing A/B variant outputs; the license stays in the vault.",
		},
		"pertitle-h264-fmp4-ts-dash-hls-on-aws": {
			title: "Per-Title H264 — dual fMP4+TS legs, DASH+HLS",
			description:
				"Per-title templates with fixed-resolution pins; every rendition muxes to fMP4 (DASH) and TS (HLS) under {height}/{bitrate}/{uuid} placeholder paths.",
		},
		"pertitle-h264-fmp4-ts-drm-on-aws": {
			title: "Per-Title H264 + CENC and FairPlay dual legs",
			description:
				"CENC on the fMP4 leg (DASH) and FairPlay on the TS leg (HLS) over a per-title H264 ladder.",
		},
		"pertitle-h264-mp4-smooth-drm-on-aws": {
			title: "Per-Title H264 → Smooth Streaming + PlayReady",
			description:
				"SMOOTH-type MP4 muxings with PlayReady CENC and .ism/.ismc SmoothStreaming manifests.",
		},
		"pertitle-h264-openapi": {
			title: "Per-Title H264 — dual-output reference",
			description:
				"An H264 Per-Title ladder with two delivery outputs, based on the provider's standard reference configuration.",
		},
		"pertitle-h264-separate-av-inputs": {
			title: "Per-Title H264 — separate video/audio source files",
			description:
				"Video-only and audio-only files feed distinct video/audio ingest tracks from one S3 input — the separate-A/V multi-path scenario.",
		},
		"pertitle-h265-fmp4-dash-hls-on-aws": {
			title: "Per-Title H265 — fMP4 DASH+HLS, 3-pass encoding",
			description:
				"Seven-step H265 Per-Title ladder combining automatically sized and fixed-resolution renditions, with detailed x265 settings and 3-pass encoding.",
		},
		"pertitle-h265-fmp4-drm-on-aws": {
			title: "Per-Title H265 + CENC and FairPlay on fMP4",
			description:
				"Per-title H265 ladder with CENC (Widevine+PlayReady) plus standalone FairPlay legs on the same fMP4 muxings.",
		},
		"pertitle-vp9-webm-cenc-drm-on-aws": {
			title: "Per-Title VP9 WebM + Widevine CENC, DASH",
			description:
				"VP9 per-title WebM muxings encrypted with CENC (Widevine) beside fMP4 audio — DASH only.",
		},
		"pertitle-vp9-webm-fmp4-dash-on-aws": {
			title: "Per-Title VP9 — WebM video + fMP4 audio, DASH",
			description:
				"VP9 per-title WebM muxings beside AAC fMP4 audio in a DASH-only manifest.",
		},
	},
	/**
	 * (c): authored zod sentences, EN verbatim from the two schema
	 * files — the FORM-layer choke point (zod-issue-message.ts) maps the raw
	 * English sentence to its key by exact match, so the schemas stay
	 * untouched and API routes keep English (the standing policy). zerr.z*
	 * are the maps for zod's own common issue codes.
	 */
	rateCard: {
		label: "Live rate card (JSON)",
		hint: "Your contract's live encoding rates by output height — feeds the run cost estimate. Emptying this removes the card.",
		insertExample: "Insert example",
		exampleBanner: "Example values — replace with your contract's rates.",
	},
	estimate: {
		invalidDuration: "Enter a positive number of minutes to estimate.",
		title: "Run cost estimate",
		wizardExplainer:
			"Arithmetic over your rate card for a hypothetical duration — not billing truth.",
		minutesLabel: "Minutes",
		line: "≈ {total} {currency} ({perHour} {currency}/h, tier ≤{tier}p)",
		noRateCard:
			"No rate card configured — add one in Settings → Bitmovin to see estimates.",
		noVideoLadder: "No video renditions with a fixed height to price.",
		exceedsTiers:
			"The ladder ({ladder}p) is taller than every rate-card tier (max {max}p) — no estimate.",
		invalidMinutes: "Enter a positive number of minutes.",
		assumeEncodingOnly: "encoding minutes only (no egress/storage/feeder)",
		assumeNoIncrements: "no minimum billing increments",
		assumeNullHeights: "free-scaling renditions ignored for tier",
	},
	schedule: {
		upcomingCaption: "Reserved schedule actions, next 7 days",
		// The planned input feed time is separate from channel creation, which starts provisioning.
		// The three schedule times describe the input feed, program start and channel stop.
		enableAtCreation: "Set the planned input feed, program and stop times",
		// Always visible, enabled or not: the one sentence separating the
		// planned time from the start time.
		provisionsNote:
			"The channel begins starting up as soon as it is created (it does not wait for the planned input feed time).",
		// Also derived from PROVISIONS_AT_CREATE: "WITHOUT a slot the channel
		// provisions immediately" reads as "with one it does not", which is the
		// same false belief `streamUpHint` carried. Scheduling a slot changes
		// what RUNS, never when the channel comes up.
		disabledHint: `${PROVISIONS_AT_CREATE}. Scheduling does not delay provisioning. Without scheduled times, manual stop and configured shutdown limits still apply. These settings are also available later on the channel detail page.`,
		streamUpAt: "Planned input feed time",
		// Share PROVISIONS_AT_CREATE with rampHint to keep the lifecycle explanation consistent.
		streamUpHint: `${PROVISIONS_AT_CREATE}. These are the planned input feed, program and stop times, not when the channel starts. Have your feed arriving at the input endpoint by the planned input feed time. If enabled, the slate is scheduled to play from that time until the program starts.`,
		programStartAt: "Planned program start",
		programStartHint:
			"The planned program start. The slate, if enabled, is scheduled to play until this time.",
		programEndAt: "Planned channel stop",
		programEndHint:
			"Requests a channel stop at this time. A runtime limit is also set as a fallback if the scheduled stop cannot run.",
		enableSlate: "Insert a slate until the program starts",
		slateSource: "Slate clip",
		slateSourceHint:
			"Choose a clip from your storage. It is registered after the channel is running and scheduled to play until the planned program start.",
		slatePickPlaceholder: "Pick a clip via Browse",
		capPreview:
			"Runtime-limit estimate: {minutes} min. The actual limit is calculated when the channel is created; reaching it requests a stop.",
		errIncomplete: "All three slot times are needed.",
		errUpAfterStart:
			"The planned input feed time must not be after the planned program start.",
		errEndBeforeStart:
			"The planned channel stop must be after the program starts.",
		errNoSlateSource: "Pick a slate clip, or turn the slate off.",
		errZeroSlateWindow:
			"A slate needs the planned input feed time strictly before the planned program start — there is no window to cover.",
		// Describe the consequence of automatic shutdown before the planned end rather than its raw property name.
		errStreamTimeoutShorterThanSlot:
			"Automatic stop after {minutes} minutes of total run time is shorter than this {slot}-minute slot, so the channel stops before the planned end — every stop, slate and file-input action scheduled after it would run against a stopped channel. Raise the limit on the Automatic restart and stop step, or shorten the slot.",
		autoShutdownConditionalNote:
			"Automatic shutdown {knobs} can still end the run early — an idle or never-connected input has no fixed time, so the slot is not checked against it.",
		timelineIncomplete: "The timeline draws once all three times are set.",
		timelineUnordered: "Times are out of order — fix them to see the timeline.",
		timelineAria:
			"Broadcast slot: input feed {up}, program start {start}, stop {end}",
		slateCover: "Slate inserted",
		preAirNoSlate: "Before the program, no slate",
		programWindow: "Program",
		nowMarker: "Now",
		streamUpShort: "Feed",
		onAirShort: "Program",
		endShort: "Stop",
		reviewLine: "Planned: feed {up} · program {start} · stop {end}{slate}",
		reviewSlateSuffix: " · slate inserted",
		//  (2026-08-15 incident): the three sentences the operator
		// needed BEFORE the black stream, not after.
		slateNeedsIngest:
			"The reserved slate is waiting for a CONNECTED input. A slate needs a flowing input. Connect your feed (or a file input). Once the clip is ready and the insertion window is open, insertion is requested automatically.",
		rampHint: `${PROVISIONS_AT_CREATE}. The planned input feed time anchors the slate, the stop and the runtime cap. Start-up takes a few minutes before the channel accepts a feed.`,
		slateIngestHint:
			"A slate covers a CONNECTED input — it cannot render on an empty channel. Have your feed (or a file input) connected by the planned input feed time, or the slate waits and is marked not run (MISSED) when the window closes.",
		// File-fed programs are configured separately from external input scheduling; point operators to that screen.
		feederPointer:
			"Pushing a clip from your own bucket as the program, instead of connecting a live input? That is a file input (pseudo-live), created on its own screen — this step sets the planned feed time for an external input and its slate.",
		// Show the operator action first and its raw code second. These are upstream file-input actions,
		// separate from the MediaLive Input prepare and switch APIs.
		actionFeederStart: "Start file input — slate loop (FEEDER_START)",
		actionFeederSwitch: "Switch input source — program (FEEDER_SWITCH)",
		upcomingTitle: "Upcoming broadcasts",
		upcomingEmpty: "No scheduled slots in the next 7 days.",
		upcomingAt: "{action} at {at}",
		cancelFailed: "Cancel failed: {error}",
		// Use schedule-action terms in customer copy rather than worker implementation details.
		title: "Schedule actions",
		timelineEvents: "Schedule events",
		explainer:
			"Schedules are one-off actions, checked approximately every 30 s and dispatched when due. A start or slate that is too late is marked not run to avoid disrupting the program. Stops remain eligible even when late.",
		action: "Action",
		actionStart: "Start channel (START)",
		actionStop: "Stop channel (STOP)",
		actionSlate: "Insert slate (SLATE_IN)",
		fireAt: "Run at",
		airAt: "Air time (deadline alert)",
		autoLead: "Auto-lead (derive run time)",
		autoLeadExplainer:
			"The scheduled start is calculated as air time minus this region's measured start-up time (90th percentile) minus a margin. A default lead is used when there are too few measurements. An earlier manually selected start time takes precedence.",
		autoLeadResolvedP90:
			"Auto-lead calculation: {at} (based on {n} recorded start-ups in this region: 90th percentile {p90}s plus a margin). An earlier manual time takes precedence.",
		autoLeadResolvedDefault:
			"Auto-lead calculation: {at} (insufficient data; default lead {lead}s). An earlier manual time takes precedence.",
		deadlineMargin: "Deadline margin (seconds)",
		invalidAirAt: "Enter a valid air time",
		airAtLine: "on air {at}",
		airAtExplainer:
			"Air time is optional and separate from the run time: the run time is when the start command runs, air time is when the program must be live. If the channel is not running by air time minus the margin (default 5 minutes), one alert event is raised while there is still time to act.",
		content: "Insertable content",
		contentPlaceholder: "Choose READY content…",
		contentNoneReady: "No READY content on this encoding",
		durationSeconds: "Duration (seconds)",
		slateNeedsAccount:
			"Slate schedules need a Bitmovin account on this channel.",
		slateExplainer:
			"Slates cut READY insertable content over the live program at the scheduled time. Content lives on the current encoding — register and wait for READY in Content insertion below.",
		armButton: "Arm schedule",
		arming: "Arming…",
		armFailed: "Arming the schedule failed",
		invalidFireAt: "Enter a valid run time",
		fireAtPast: "The run time must be in the future",
		cancel: "Cancel",
		upcoming: "Upcoming",
		noneUpcoming: "Nothing armed.",
		history: "History",
		noneHistory: "Nothing has run yet.",
		// Distinguish unconfirmed, pushing, connected and delivered outcomes. A provider-armed slate or a feed
		// that has only started pushing must not imply confirmed delivery.
		outcomePending: "Requested — outcome not confirmed yet",
		outcomePushing: "Pushing — provider has not confirmed the ingest yet",
		outcomeIngestConnected:
			"Ingest connected — the provider is receiving the feed",
		outcomeSlateArmed:
			"Slate armed — provider accepted it; airing not confirmed",
		outcomeDelivered: "Delivered",
		outcomeLegacyUnverified: "Legacy data — delivery not verified",
		outcomeFailed: "Requested but did NOT deliver",
		outcomeUnknown: "Requested — outcome never confirmed",
		// : armed for one airing, refused against another. Not an
		// error — the guard working — so the wording says what it protected.
		statusSkippedStaleGeneration: "Skipped — armed for an earlier airing",
		// Display a readable status before its raw code.
		statusArmed: "Reserved",
		statusFired: "Requested",
		statusCompleted: "Completed",
		statusCanceled: "Cancelled",
		statusMissed: "Not run",
		statusError: "Error",
		outcomesFailedOne: "{count} fired schedule did not deliver",
		outcomesFailedOther: "{count} fired schedules did not deliver",
		// : a FEEDER_SWITCH row separates "scheduled" from "ready" —
		// its source is staged ahead of the fire time, and only a ready
		// session switches; the seam is the measured cost of the swap.
		switchScheduled: "scheduled — not staged yet",
		switchStaging: "staging the source",
		switchReady: "ready to switch",
		// rev367 S-2: the staged session ended (or is gone) — only a READY
		// session switches, so this row will land MISSED at its fire time.
		switchStageFailed: "stage failed — will not switch",
		switchSeam: "seam {ms} ms",
		slateDurationLine: "{seconds}s slate",
		capTitle: "Maximum run time",
		capExplainer:
			"Safety cap: once the channel has been running this many minutes it is stopped automatically — measured from observed running, so a late start does not eat the window. Empty = no cap.",
		capLabel: "Minutes",
		capNonePlaceholder: "no cap",
		capSave: "Save cap",
		capSaveFailed: "Saving the cap failed",
		// : the arm form and the fired history are disclosures now —
		// the panel opens with the timeline and the upcoming rows.
		armDisclose: "Schedule an action",
		armDiscloseClose: "Hide the scheduling form",
		historyDisclose: "Show past and cancelled rows",
		historyDiscloseClose: "Hide past and cancelled rows",
		capSummary: "cap {minutes} min",
		capNone: "no cap",
		capInvalid: "The cap must be between 1 and 10080 minutes",
		capActiveNote: "Applies to the current run within ~30s.",
		nextFire: "Next: {action} {time}",
	},
	watch: {
		deleteConfirm: "Delete watch folder “{name}”?",

		title: "Watch folders",
		explainer:
			"Hot-folder rules: we list a prefix in YOUR bucket, wait for new objects to stabilize, and auto-submit encoding jobs from a FULL_PLAN preset.",
		noWritesPromise:
			"Contract: this app only ever LISTS your bucket. It never writes, moves, or marks a single object there — processed-state lives in this app's own database.",
		name: "Rule name",
		location: "Watched location",
		pickLocation: "Choose bucket / prefix…",
		noLocation: "no location chosen",
		pickLocationFirst: "Choose the bucket and prefix to watch first.",
		preset: "Job template (FULL_PLAN preset)",
		presetPlaceholder: "Choose a preset…",
		extensions: "Extensions",
		extensionsHint: "Comma-separated allowlist; empty = every object.",
		outputTemplate: "Output prefix template",
		outputTemplateHint:
			"Tokens (write them in curly braces): basename, ext, date, uuid, rule — outputs land under this per-object prefix.",
		createButton: "Create rule",
		createFailed: "Creating the rule failed",
		noRules: "No watch rules yet — new objects go unnoticed until one exists.",
		countsErrorsOne: "{errors} error",
		countsErrorsOther: "{errors} errors",
		reArmConfirm: "Really re-encode? Click again",
		reArmFailed: "Re-encode failed: {message}",
		enabled: "enabled",
		disabled: "disabled",
		errorBadge: "sweep error",
		countsLine: "{submitted} submitted · {pending} pending",
		redetectConfirmTitle: "Re-detect everything under this prefix?",
		redetectConfirmBody:
			"“{name}” was disarmed by the data reset, which deleted its memory of already-encoded objects. Enabling it re-detects EVERY object under the prefix as new and submits a billable encoding for each.",
		redetectConfirmEnable: "Enable and re-detect",
		lastSweep: "swept {time}",
		neverSwept: "never swept",
		objects: "Objects",
		collapse: "Hide",
		enable: "Enable",
		disable: "Disable",
		delete: "Delete",
		noObjects: "Nothing seen under this prefix yet.",
		jobLink: "job: {status}",
		reArm: "Re-encode",
	},
	alerts: {
		// Keep alert configuration and resolved history in Diagnostics, separate from the current monitoring readout.
		rulesTitle: "Alert rules & resolved history",
		title: "Alerts",
		openBannerLineOne: "{count} alert firing — see the Alerts section below.",
		openBannerLineOther:
			"{count} alerts firing — see the Alerts section below.",
		fetchFailed: "Alerts could not be loaded: {message}",
		resolveButton: "Resolve",
		resolveFailed: "Resolve failed: {message}",
		deleteCascadeWarning:
			"Deleting the rule also deletes its ENTIRE alert history (cascade). Disable instead to keep the history.",
		noneOpen: "No alerts firing.",
		history: "Resolved history",
		noneHistory: "Nothing has fired yet.",
		openedAt: "opened {time}",
		addChannelRule: "Add a rule for THIS channel",
		addRuleButton: "Add channel rule",
		addGlobalRuleButton: "Add global rule",
		addFailed: "Adding the rule failed",
		metric: "Metric",
		metricInputDisconnected: "Input disconnected",
		metricHeartbeatStale: "Heartbeat stale",
		metricBitrateBelow: "Bitrate below",
		metricFpsBelow: "FPS below",
		metricProgramStartNoIngest: "No ingest at program start",
		metricOriginManifestStale: "Output manifest stale",
		metricOriginEndlistPresent: "ENDLIST in a live playlist",
		metricOriginEdgeDelayAbove: "Output delay above threshold",
		metricProviderWarning: "Encoder warning/error event",
		providerMessage: "Encoder message",
		subjectIngest: "input",
		subjectDelivery: "output",
		provenanceHelp:
			"An encoder-sourced signal is the encoder's own report; an output-sourced signal is measured directly from the output destination's playlists and stands even when the encoder's report disagrees.",
		threshold: "Threshold",
		severity: "Severity",
		windowPolls: "Window (polls)",
		windowLineOne: "{polls} poll",
		windowLineOther: "{polls} polls",
		settingsTitle: "Live alert rules",
		settingsExplainer:
			"Evaluated inside the 30s heartbeat sweep — detection latency is at least the sweep interval × window. Global rules apply to every channel; channel-scoped ones come from each channel's page. Deleting a rule also deletes its alert history.",
		noRules: "No rules yet — alerts are silent until one exists.",
		scopeGlobal: "global",
		scopeChannel: "channel",
		disabled: "disabled",
		enable: "Enable",
		disable: "Disable",
		delete: "Delete",
		confirmDelete: "Delete rule + history?",
	},
	zerr: {
		spekeBasicPair: "Provide both Basic authentication username and password",
		spekeGatewayRegion: "Gateway region is required with roleArn",
		spekeRoleArn: "AWS role settings require roleArn",
		spekeCustomExternalId: "CUSTOM external ID mode requires externalId",
		spekeGeneratedExternalId:
			"GENERATED external ID mode cannot set externalId",
		diagnosticsSrtInputOnly: "srtInputId is only supported for SRT diagnostics",
		diagnosticsHttpsDownload:
			"Expected an HTTPS download URL without credentials",

		ociNamespaceCharset: "OCI namespace is lowercase alphanumeric",
		ociRegionShape: "OCI region looks like ap-osaka-1",
		hostBareHostname: "Host must be a bare hostname (no scheme, path or port)",
		watchRuleName: "Rule names are lowercase letters, digits and hyphens",
		watchTemplateToken:
			"Template must contain the basename or uuid token — outputs would overwrite each other",
		offsetIso8601:
			"offset must be an ISO 8601 duration (e.g. PT10S, -PT1.500S)",
		binaryRequired: "binary is required",
		binaryBase64: "binary must be base64-encoded SCTE-35 data",
		signalsMin: "At least one signal is required",
		inputPathRequired: "inputPath is required",
		inputsMin: "At least one input is required",
		// C36 (WP-A1): the two body shapes of a slate registration / preflight.
		inputsOrSource: "Provide exactly one of inputs or source",
		sourceOrInput: "Provide exactly one of source or input",
		streamKeyMin: "A manual stream key must be at least 8 characters",
		streamKeyCharset:
			"A manual stream key may only contain letters, digits, dot, underscore and dash",
		subdomainRequired: "subdomain is required",
		subdomainMax: "subdomain must be at most 63 characters",
		subdomainCharset:
			"subdomain may only contain lowercase letters, digits and dashes",
		encodingTemplateRequired: "encodingTemplate is required",
		nameRequired: "name is required",
		targetPoolSizeMin: "targetPoolSize must be at least 1",
		targetPoolSizeMax: "targetPoolSize must be at most 100",
		accessSecretTogether: "accessKey and secretKey must be provided together",
		gcsEitherOr:
			"Provide EITHER serviceAccountCredentials OR serviceAccountEmail/privateKey/projectId — not both",
		gcsAllOfTriple:
			"Provide serviceAccountCredentials, or ALL of serviceAccountEmail, privateKey and projectId",
		requiredUnlessJson: "Required unless serviceAccountCredentials is provided",
		customDataTooLarge:
			"customData is too large ({size} chars serialized; max {max})",
		apiTokenRequired: "API token is required",
		awsAccountNumberRequired: "AWS account number is required",
		compartmentOcidRequired: "Compartment OCID is required",
		encoderVersionRequired: "Encoder version is required",
		networkRequired: "Network is required",
		networkNameRequired: "Network name is required",
		resourceGroupIdRequired: "Resource group id is required",
		securityGroupIdRequired: "Security group id is required",
		subnetOcidRequired: "Subnet OCID is required",
		subnetIdRequired: "Subnet id is required",
		subnetNameRequired: "Subnet name is required",
		subscriptionIdRequired: "Subscription id is required",
		tenancyOcidRequired: "Tenancy OCID is required",
		tenantIdRequired: "Tenant id is required",
		credKeyHex: "16-byte content key as 32 hex chars",
		credAccessKeyIdRequired: "Access key id is required",
		credAccountKeyRequired: "Account key is required",
		credAccountNameRequired: "Account name is required",
		credBucketNameRequired: "Bucket name is required",
		credHmacAccessKeyRequired: "HMAC access key is required",
		credHmacSecretRequired: "HMAC secret is required",
		credHostRequired: "Host is required",
		credMslStreamId: "Stream ID must be a positive integer",
		credMslEventName: "Event name is required",
		credLabelRequired: "Label is required",
		credLoginRequired: "Login is required",
		credServiceAccountJson:
			"Must be a service-account key JSON (client_email, private_key)",
		credIamRoleArn:
			"Must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)",
		credValidJson: "Must be valid JSON",
		credNamespaceRequired: "Namespace is required",
		credNexguardLicenseRequired: "NexGuard license is required",
		credPasswordRequired: "Password is required",
		credPasswordOrDecryptionKey:
			"Provide at least one of password / decryptionKey",
		credMslDigestBothOrNeither:
			"Provide both the Digest username and password, or neither — a half pair is rejected by Bitmovin at provisioning",
		credMslEdgeTooLong: "Edge base URL must be at most 512 characters",
		credMslEdgeInvalid:
			"Edge base URL must be an absolute https URL (https://host/path)",
		credMslEdgeScheme:
			"Edge base URL must use https — viewers load the stream over TLS only",
		credMslEdgeUserinfo:
			"Edge base URL must not embed credentials (user:pass@host) — every viewer receives this link",
		credMslEdgeQuery:
			"Edge base URL must not carry a query or fragment — supply the event root, not a signed playback URL",
		credMslEdgeTrailingSlash:
			"Edge base URL must not end with a slash — the app appends the manifest name itself",
		credMslEdgePrivateHost:
			"Edge base URL must name a public host — localhost and private or link-local addresses cannot be reached by viewers",
		credRegionRequired: "Region is required",
		credSecretAccessKeyRequired: "Secret access key is required",
		credUsernameRequired: "Username is required",
		scheduleFeederDerivedOnly:
			"Feeder rows are derived by the program schedule at creation — they cannot be armed manually",
		scheduleAirAtStartOnly: "Air-time deadlines only apply to START schedules",
		scheduleAirAtAfterFireAt: "Air time must be after the fire time",
		scheduleFireAtRequired: "Fire time is required unless auto-lead derives it",
		scheduleAutoLeadStartOnly: "Auto-lead only applies to START schedules",
		scheduleAutoLeadNeedsAirAt: "Auto-lead needs an air time to derive from",
		scheduleSlateContent: "Slate schedules need insertable content",
		scheduleSlateDuration: "Slate schedules need a duration",
		scheduleSlateAccount: "Slate schedules need the Bitmovin account",
		scheduleContentFieldsSlateOnly: "Content fields apply to SLATE_IN only",
		alertThresholdRequired: "Numeric alert rules need a threshold",
		alertThresholdNotAllowed:
			"Only BITRATE_BELOW and FPS_BELOW take a threshold",
		zTooSmallItemsOne: "Must have at least 1 item",
		zTooSmallItems: "Must have at least {minimum} items",
		zTooBigItemsOne: "Must have at most 1 item",
		zTooBigItems: "Must have at most {maximum} items",
		zRequired: "Required",
		zTooSmallChars: "Must be at least {minimum} characters",
		zTooBigChars: "Must be at most {maximum} characters",
		zTooSmallNumber: "Must be at least {minimum}",
		zTooBigNumber: "Must be at most {maximum}",
		zInvalidType: "Invalid value (expected {expected}, received {received})",
		// {detail} carries zod's own specific default ("Invalid UUID") — en
		// renders it byte-identical; ja frames it.
		zInvalidFormat: "{detail}",
	},
} as const;

/**
 * The shape every locale must satisfy: same keys, any strings.
 *
 * `satisfies Messages` on a locale catches a MISSING key (assignability) and a
 * misspelled one (excess-property check on an object literal), which is the pair
 * that matters — those are the two ways a translation silently goes absent.
 */
export type Messages = Widen<typeof en>;

type Widen<T> = {
	[K in keyof T]: T[K] extends string ? string : Widen<T[K]>;
};

/**
 * Dotted paths into the catalogue (`"nav.dashboard"`), computed rather than
 * hand-listed so a new key is usable immediately and a removed one breaks its
 * call sites.
 */
export type MessageKey = LeafPaths<typeof en>;

type LeafPaths<T, Prefix extends string = ""> = {
	[K in keyof T & string]: T[K] extends string
		? `${Prefix}${K}`
		: LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
