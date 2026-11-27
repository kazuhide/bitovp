/** Fixed product faults, qualified against identical complete suites. No provider or media work. */
const controls = [
	{
		id: "tenant-dispatch-ownership",
		purpose:
			"Foreign organization/resource pairs must not reach a worker processor.",
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/tenant/consumer.test.ts": 21,
		},
		source: "apps/worker/src/tenant/consumer.ts",
		anchor: "await assertTenantJobOwned(deps.prisma, key, envelope.payload);",
		replacement: "void envelope.payload;",
		cases: [
			"tenant consumer admission unwraps only after checking the owning row and retains BullMQ identity",
			"tenant consumer admission a forged org/resource pair never reaches the processor or provider",
			"tenant consumer admission missing context fails closed; an explicit legacy admission is default-org only",
			"tenant consumer admission a manually named sweep cannot invoke the system dispatcher",
			"liveChannel rejects foreign primary identity before processor",
			"vmafRunner rejects foreign primary identity before processor",
			"feederManager rejects foreign primary identity before processor",
			"storageInspect rejects foreign primary identity before processor",
			"vodInputPreview rejects foreign primary identity before processor",
			"slateNormalize rejects foreign primary identity before processor",
			"usageStatistics rejects foreign primary identity before processor",
			"notify rejects foreign primary identity before processor",
			"startup batch cannot use another tenant's saved configuration",
			"trusted repeatables visit each organization without sharing mutable scope",
			"reserves one feeder STOP slot globally, delays excess starts and releases capacity",
			"fresh inactive metadata suppresses pending VOD before SDK execution and persists ERROR",
			"inactive multi-encoding VOD that 'owns a durable STOP' follows scoped cleanup admission",
			"inactive multi-encoding VOD that 'has an accepted cancel' follows scoped cleanup admission",
			"inactive multi-encoding VOD that 'belongs to another organization' follows scoped cleanup admission",
			"an ordinary Cancel winning the inactive VOD terminal CAS keeps its only delivery",
			"inactive organization still accepts STOP and in-flight provider continuation",
		],
		failures: {
			"tenant consumer admission unwraps only after checking the owning row and retains BullMQ identity":
				'AssertionError: expected "vi.fn()" to be called with arguments: [ { …(2) } ]',
			"tenant consumer admission a forged org/resource pair never reaches the processor or provider":
				'Error: promise resolved "{ …(3) }" instead of rejecting',
			"liveChannel rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"vmafRunner rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"feederManager rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"storageInspect rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"vodInputPreview rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"slateNormalize rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"usageStatistics rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"notify rejects foreign primary identity before processor":
				'Error: promise resolved "undefined" instead of rejecting',
			"startup batch cannot use another tenant's saved configuration":
				'Error: promise resolved "undefined" instead of rejecting',
			"fresh inactive metadata suppresses pending VOD before SDK execution and persists ERROR":
				'Error: promise resolved "undefined" instead of rejecting',
			"inactive multi-encoding VOD that 'belongs to another organization' follows scoped cleanup admission":
				"Error: expected [Function] to throw error including 'Tenant resource unavailable' but got 'Organization is inactive; new work wa…'",
			"an ordinary Cancel winning the inactive VOD terminal CAS keeps its only delivery":
				'AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times',
		},
		timeoutMs: 60000,
	},
	{
		id: "paid-start-single-send",
		purpose:
			"An ambiguous START response must not trigger another paid request.",
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/orchestrator/retrying-fetch.test.ts": 26,
		},
		source: "apps/worker/src/orchestrator/retrying-fetch.ts",
		anchor: "return !/\\/(live\\/)?start\\/?$/.test(path);",
		replacement: "return true;",
		cases: [
			"closes a refused child POST response when its durable journal loses the lease",
			"journals a real child POST refusal before its response body breaks and never follows a redirect",
			"createRetryingFetch refuses RTMP reassignment retries with URL query/trailing slash, while preserving reads",
			"createRetryingFetch retries a transport rejection and returns the eventual response",
			"createRetryingFetch retries only reads on an attempt-owned manifest request (POST)",
			"createRetryingFetch retries only reads on an attempt-owned manifest request (DELETE)",
			"createRetryingFetch retries only reads on an attempt-owned manifest request (GET)",
			"createRetryingFetch gives up after the attempt budget and rethrows the LAST error",
			"createRetryingFetch does NOT retry a response that arrived, whatever its status",
			"createRetryingFetch backs off exponentially from the base delay",
			"createRetryingFetch attempts: 1 disables retrying entirely",
			"createRetryingFetch reports GET when init carries no method",
			"createRetryingFetch never blind-retries a verification-stamped create whose response was lost",
			"createBitmovinSdkOps wiring survives a dropped connection on a real ops call",
			"createHlsManifest reconciliation adopts an existing manifest instead of creating a second one",
			"createHlsManifest reconciliation does NOT adopt a manifest at a DIFFERENT path on the same output",
			"createHlsManifest reconciliation creates anyway when the lookup itself fails — a 503 must not fail the step",
			"createHlsManifest reconciliation is not masked by an id-less match earlier on the page",
			"createHlsManifest reconciliation creates when nothing matches this output",
			"createHlsManifest reconciliation adopts after a lost response — the exact failure seen in production",
			"createHlsManifest reconciliation rethrows when the create failed AND nothing exists",
			"a START is never retried — VOD or live sends live/start exactly ONCE and propagates the rejection",
			"a START is never retried — VOD or live sends live/hd/start exactly ONCE and propagates the rejection",
			"a START is never retried — VOD or live sends a VOD start exactly ONCE too",
			"a START is never retried — VOD or live still retries the create that motivated the retry in the first place",
			"a START is never retried — VOD or live classifies the shapes a URL can take, so a guard cannot be slipped past",
		],
		failures: {
			"a START is never retried — VOD or live sends live/start exactly ONCE and propagates the rejection":
				"AssertionError: a live start must be attempted once: expected 3 to be 1 // Object.is equality",
			"a START is never retried — VOD or live sends live/hd/start exactly ONCE and propagates the rejection":
				"AssertionError: a live start must be attempted once: expected 3 to be 1 // Object.is equality",
			"a START is never retried — VOD or live sends a VOD start exactly ONCE too":
				"AssertionError: expected 3 to be 1 // Object.is equality",
			"a START is never retried — VOD or live classifies the shapes a URL can take, so a guard cannot be slipped past":
				"AssertionError: expected true to be false // Object.is equality",
		},
		timeoutMs: 60000,
	},
	{
		id: "hdr-result-segregation",
		purpose:
			"Imported reports must group every result by its retained measurement context.",
		workspace: "@bitovp/web",
		directory: "apps/web",
		files: {
			"src/app/qc/compare/compare-views.test.tsx": 34,
		},
		source: "apps/web/src/app/qc/compare/compare-client.tsx",
		anchor: "const context = hdrMeasurementContext(job, item.result);",
		replacement: "const context = hdrMeasurementContext(job, job.results[0]);",
		cases: [
			"CompareClient embeds three source outputs while keeping HDR and SDR score panels separate",
			"CompareClient does not silently omit a live report from source-output playback",
			"CompareClient separates incompatible HDR measurement contexts (HLG=false)",
			"CompareClient separates incompatible HDR measurement contexts (HLG=true)",
			"CompareClient separates mixed contexts within an imported report",
			"CompareClient keeps an unverified HDR model separate from retained HDR measurement evidence",
			"CompareClient keeps incompatible measurement preview candidates in their own panels",
			"CompareClient compares CAMBI-only reports without a VMAF clock and disambiguates shared result IDs",
			"CompareClient rejects mixed metric selections instead of silently dropping the CAMBI-only report",
			"CompareClient shows CAMBI for only the visible combined-report VMAF series",
			"CompareClient connects selected reports to their on-demand comparison videos",
			"CompareClient overlays one line per (job × rendition) series for the fetched jobs",
			"CompareClient hides a series' line when its legend checkbox is unticked",
			"CompareClient shows the guard when fewer than two ids are supplied",
			"CompareClient dedupes repeated ids — two distinct ids required after dedupe",
			"CompareClient skips a 404 job and notes it while still rendering the rest",
			"CompareClient notes a job that loaded with zero results",
			"CompareClient disambiguates two distinct jobs that share an encoding name (re-runs) with the short id",
			"CompareClient — reference display sizes warns when same-generation reports use different reference display sizes",
			"CompareClient — reference display sizes stays quiet for equal square-pixel canvases across old and new reports",
			"CompareClient — mixed scoring generations warns when the loaded reports span generations",
			"CompareClient — mixed scoring generations treats a report with no version as generation 1",
			"CompareClient — mixed scoring generations stays quiet for a uniform set",
			"compare — mixed VMAF models warns when the loaded reports were scored with different models",
			"compare — mixed VMAF models is a separate warning from the generation one, and both can show at once",
			"compare — mixed VMAF models stays quiet when every report shares a model",
			"compare — mixed frame subsampling warns when a subsampled report is charted against a full-precision one",
			"compare — mixed frame subsampling stays quiet when both reports are full precision, however that is spelled",
			"compare — mixed frame subsampling shows all three warnings at once when all three axes differ",
			"compare — attributing a model to each report puts the model in every series label when the set is mixed",
			"compare — attributing a model to each report leaves labels short when every report shares a model",
			"ladder chart — the omitted renditions are NAMED (ux inventory #11) opens the dropped list on click, each name once — not doubled",
			"resets series selection when the URL changes to a different comparison",
			"lets an operator retry failed comparison reads without discarding loaded reports",
		],
		failures: {
			"CompareClient separates mixed contexts within an imported report":
				'TestingLibraryElementError: Unable to find an accessible element with the role "region" and name `/clip-low.*HDR PQ/`',
		},
		timeoutMs: 60000,
	},
	{
		id: "abort-retains-process-ownership",
		purpose:
			"A child abort/error must not resolve work before its close event.",
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/feeder/process-runner-abort.test.ts": 20,
		},
		source: "apps/worker/src/feeder/process-runner.ts",
		anchor: "aborted = true;",
		replacement:
			"aborted = true;\nresolve({ code: null, stdout, stderr: err.message });",
		cases: [
			"streaming process exit keeps a spawned publisher owned after both termination signals are denied",
			"one-shot abort grace ownership holds an opted-in child when its first SIGTERM attempt emits a normal error",
			"one-shot abort grace ownership sends one hard kill at the deadline but retains ownership until close",
			"one-shot abort grace ownership clears the deadline on exit even while stdio keeps close pending",
			"one-shot abort grace ownership does not schedule a stale kill when abort follows exit",
			"one-shot abort grace ownership clears the deadline after a fast aborted close",
			"one-shot abort grace ownership does not create a deadline for the default SIGTERM-only behavior",
			"one-shot abort grace ownership settles an unspawned child without an abort deadline",
			"one-shot abort grace ownership retains ownership after hard-kill failure (emit)",
			"one-shot abort grace ownership retains ownership after hard-kill failure (throw)",
			"one-shot abort grace ownership retains ownership after hard-kill failure (return false)",
			"one-shot abort grace ownership does not restart the deadline after another abort error",
			"one-shot abort grace ownership accepts the largest safe timer without wrapping to an immediate kill",
			"one-shot abort grace ownership rejects an invalid grace before creating a child (0)",
			"one-shot abort grace ownership rejects an invalid grace before creating a child (-1)",
			"one-shot abort grace ownership rejects an invalid grace before creating a child (0.5)",
			"one-shot abort grace ownership rejects an invalid grace before creating a child (NaN)",
			"one-shot abort grace ownership rejects an invalid grace before creating a child (Infinity)",
			"one-shot abort grace ownership rejects an invalid grace before creating a child (2147483648)",
			"does not spawn when cancellation was already observed at the launch boundary",
		],
		failures: {
			"one-shot abort grace ownership holds an opted-in child when its first SIGTERM attempt emits a normal error":
				"AssertionError: a failed initial signal must not release a live child: expected true to be false // Object.is equality",
			"one-shot abort grace ownership sends one hard kill at the deadline but retains ownership until close":
				"AssertionError: expected true to be false // Object.is equality",
			"one-shot abort grace ownership clears the deadline on exit even while stdio keeps close pending":
				"AssertionError: expected true to be false // Object.is equality",
			"one-shot abort grace ownership retains ownership after hard-kill failure (emit)":
				"AssertionError: expected true to be false // Object.is equality",
			"one-shot abort grace ownership retains ownership after hard-kill failure (throw)":
				"AssertionError: expected true to be false // Object.is equality",
			"one-shot abort grace ownership retains ownership after hard-kill failure (return false)":
				"AssertionError: expected true to be false // Object.is equality",
		},
		timeoutMs: 60000,
	},
];
export const CONTROLS = Object.freeze(
	controls.map((control) =>
		Object.freeze({
			...control,
			files: Object.freeze(control.files),
			cases: Object.freeze(control.cases),
			failures: Object.freeze(control.failures),
		}),
	),
);
