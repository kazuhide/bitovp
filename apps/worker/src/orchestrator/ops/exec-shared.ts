/**
 *  half 2: executor.ts module helpers moved VERBATIM. The types
 * they reference (ExecutorContext, StepResult, …) still live in executor.ts —
 * imported type-only, so the executor ↔ ops cycle is erased at runtime.
 * ExecStepContext is the shared prep the dispatch passes each domain
 * executor: the executor's own closure trio, by the same names the case
 * bodies always used.
 */

import {
	type CompiledOperation,
	loadEnv,
	ociCompatHost,
	parseSecretEgressAllowlist,
	relativeSegmentPath,
} from "@bitovp/core";
import type { ExecutorContext } from "../executor";
import type {
	AvMuxingKind,
	ColorConfigParams,
	Destination,
	LiveDashStartOptions,
	LiveHlsStartOptions,
	MuxingSummary,
	TaskStatusResult,
} from "../sdk-ops";

export type ExecStepContext = {
	ctx: ExecutorContext;
	request: Record<string, unknown>;
	startedDuringCrashWindow: (
		getStatus: () => Promise<TaskStatusResult>,
	) => Promise<TaskStatusResult | null>;
};

/**
 * Typed cancel signal: distinct from a normal step error so the processor can
 * tell "the user canceled mid-await" apart from "the step failed". Thrown only
 * by awaitTask when ctx.shouldCancel resolves true; the processor catches it,
 * skips the ERROR/stop-siblings path, and runs the CANCELED finalize instead.
 */
export class CancelRequested extends Error {
	constructor(
		step: string,
		readonly beforeSend = false,
	) {
		super(`${step} interrupted: cancel requested`);
		this.name = "CancelRequested";
	}
}

/** Provider-confirmed Live cancellation, not a failed encode or a VOD cancel request. */
export class LiveEncodingCanceled extends Error {
	constructor(
		readonly encodingId: string,
		readonly task: TaskStatusResult,
		message: string,
	) {
		super(message);
		this.name = "LiveEncodingCanceled";
	}
}

export class MissingRefError extends Error {
	constructor(step: string, key: string) {
		super(`step "${step}" needs ref "${key}" but it has not resolved yet`);
		this.name = "MissingRefError";
	}
}

/**
 * Make a live-start failure self-diagnosing. Bitmovin error 2025 ("the input
 * with the id … could not be found") at live/start means the encoding's ingest
 * input stream references an input id that does not resolve in the organization
 * the start runs under — typically a stale id frozen into a retried channel, or
 * a sub-organization tenant/org mismatch (the default RTMP input is auto-
 * provisioned PER organization, so its id is org-specific). The raw message
 * names the MISSING id; we append the id(s) the encoding actually references
 * plus the account's currently-resolvable RTMP input ids, so the mismatch is
 * visible at a glance and the fix (recreate the channel, or correct the
 * account's tenant org) is obvious. Best-effort and input-failures only: any
 * probe error or unrelated failure passes the original through untouched.
 */
export async function diagnoseLiveStartFailure(
	err: unknown,
	ctx: ExecutorContext,
	encodingId: string,
): Promise<Error> {
	const base = err instanceof Error ? err : new Error(String(err));
	// Input-not-found only (Bitmovin 2025): require BOTH an input mention and a
	// not-found phrase so benign "invalid input parameter" errors pass through.
	const msg = base.message;
	if (!/input/i.test(msg) || !/could not be found|not found/i.test(msg)) {
		return base;
	}
	// GROUND TRUTH: the inputId frozen into the encoding's ingest input streams
	// is what Bitmovin validates at start — distinct from what THIS run resolved
	// into ctx.ids. Read all three so a mismatch is unambiguous.
	let baked = "could not be listed";
	try {
		const streams = await ctx.sdk.listIngestInputStreams(encodingId);
		const ids = [
			...new Set(
				streams
					.map((s) => s.inputId)
					.filter((id): id is string => id !== undefined && id !== ""),
			),
		];
		baked = ids.length ? ids.join(", ") : "(none)";
	} catch {
		// best-effort probe
	}
	let resolvable = "could not be listed";
	try {
		const rtmp = await ctx.sdk.listRtmpInputs();
		resolvable = rtmp.length ? rtmp.map((i) => i.id).join(", ") : "(none)";
	} catch {
		// best-effort probe
	}
	const resolvedNow =
		[...ctx.ids.entries()]
			.filter(([step]) => step.startsWith("live-input"))
			.map(([, id]) => id)
			.join(", ") || "unknown";
	return new Error(
		`${base.message} | live-start input diagnosis — encoding's ingest streams reference [${baked}]; account RTMP inputs currently resolvable [${resolvable}]; this run resolved [${resolvedNow}]. If the baked id is not in the resolvable set, the account's RTMP input id changed/was replaced between provisioning and start (an unstable or MULTIPLE default RTMP input) — recreating the channel won't help until the account has exactly one stable RTMP input. If account shows >1 RTMP input, resolve-by-list is ambiguous and must be disambiguated.`,
	);
}

export function refId(
	op: CompiledOperation,
	ctx: ExecutorContext,
	key: string,
): string {
	const target = op.refs[key];
	if (typeof target !== "string") {
		throw new MissingRefError(op.step, key);
	}
	const resolved = ctx.ids.get(target);
	if (!resolved) {
		throw new MissingRefError(op.step, key);
	}
	return resolved;
}

/** refId for refs that may legitimately be absent (e.g. drmId). */
export function optRefId(
	op: CompiledOperation,
	ctx: ExecutorContext,
	key: string,
): string | undefined {
	return op.refs[key] === undefined ? undefined : refId(op, ctx, key);
}

export function refIdList(
	op: CompiledOperation,
	ctx: ExecutorContext,
	key: string,
): string[] | undefined {
	const target = op.refs[key];
	if (target === undefined) {
		return undefined;
	}
	const steps = Array.isArray(target) ? target : [target];
	return steps.map((step) => {
		const resolved = ctx.ids.get(step);
		if (!resolved) {
			throw new MissingRefError(op.step, key);
		}
		return resolved;
	});
}

export function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function num(value: unknown, fallback: number): number {
	return typeof value === "number" ? value : fallback;
}

/**
 * Optional passthroughs: the compiler emits explicit `null` for "unset"
 * on some fields (per-title bitrate, h265 level) — those become undefined
 * here so the SDK model treats them as absent.
 */
/** Shape guard for the compiler-produced InfrastructureSettings payload. */
export function optInfrastructure(
	value: unknown,
): { infrastructureId: string; cloudRegion: string } | undefined {
	if (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { infrastructureId?: unknown }).infrastructureId ===
			"string" &&
		typeof (value as { cloudRegion?: unknown }).cloudRegion === "string"
	) {
		return value as { infrastructureId: string; cloudRegion: string };
	}
	return undefined;
}

/** A required numeric payload field — a missing/NaN value throws, never defaults. */
export function requireNum(
	op: CompiledOperation,
	field: string,
	value: unknown,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(
			`step "${op.step}": payload field "${field}" must be a number (got ${JSON.stringify(value)})`,
		);
	}
	return value;
}

export function optStr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function optNum(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

export function optBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function numList(value: unknown): number[] {
	return Array.isArray(value)
		? value.filter((v): v is number => typeof v === "number")
		: [];
}

export type ResolvedCred = {
	provider: string;
	config: Record<string, unknown>;
	secret: Record<string, string>;
};

/**
 * The three providers a GENERIC_S3 plan input/output may resolve to — all are
 * S3-compatible with V4 signing (C10). Any other provider is a config error
 * the executor rejects (it would otherwise read the wrong secret fields).
 */
export const GENERIC_S3_PROVIDERS = new Set([
	"AKAMAI_OBJECT_STORAGE",
	"OCI_OBJECT_STORAGE",
	"GENERIC_S3",
]);

/**
 * Credentials store signatureVersion as the WIRE value ("S3_V4"/"S3_V2"), but
 * the SDK's S3SignatureVersion enum keys are V4/V2 (and sdk-ops maps NAME →
 * value via sdkEnumValue). Translate wire → NAME here; default to V4.
 */
export function sigVersionName(wire: string | undefined): string {
	return wire === "S3_V2" ? "V2" : "V4";
}

/**
 * Required-secret accessor: a missing/empty value THROWS rather than failing
 * open (an unauthenticated Bitmovin input/output would be a silent
 * mis-encode). Mirrors the SRT/ZIXI/DRM gate — never `?? ""` for a secret.
 */
export function requireSecret(
	cred: ResolvedCred,
	field: string,
	step: string,
	label: string,
): string {
	const value = cred.secret[field];
	if (!value) {
		throw new Error(`step "${step}": ${label} credential carries no ${field}`);
	}
	return value;
}

/**
 * Resolves the GenericS3 endpoint host EXACTLY like packages/storage's
 * factory.ts (the browse path) so encoding I/O and browsing always target the
 * same bucket: Akamai/GenericS3 use config.host, OCI derives the S3-compat
 * host from namespace+region (C10). signatureVersion defaults to S3_V4
 * (Akamai/OCI are always V4); GenericS3 may pin S3_V2 via its config.
 */
export function genericS3Endpoint(
	cred: ResolvedCred,
	step: string,
): {
	host: string;
	port?: number;
	ssl?: boolean;
	signatureVersion: string;
} {
	const provider = cred.provider;
	if (provider === "OCI_OBJECT_STORAGE") {
		const namespace = str(cred.config.namespace);
		const region = str(cred.config.region);
		if (!namespace || !region) {
			throw new Error(
				`step "${step}": OCI_OBJECT_STORAGE credential is missing namespace/region`,
			);
		}
		// OCI S3-compat is HTTPS, virtual-host-incompatible → always V4.
		return {
			host: ociCompatHost(namespace, region),
			signatureVersion: "S3_V4",
		};
	}
	// AKAMAI_OBJECT_STORAGE and GENERIC_S3 both carry the host on config.
	const host = str(cred.config.host);
	if (!host) {
		throw new Error(`step "${step}": ${provider} credential is missing host`);
	}
	if (provider === "AKAMAI_OBJECT_STORAGE") {
		/**
		 * Akamai (Linode) is V4-only (C10) — and HTTPS on 443, which has to be SAID.
		 *
		 * Omitting `port`/`ssl` does not mean "use the defaults for this host", it means Bitmovin
		 * applies the GenericS3 defaults. A real run proved which: the encoder tried
		 * `bitmovin-api-jp-osa-1-input.jp-osa-1.linodeobjects.com:8000` and got
		 * `Connection refused`, reported as
		 * `Download of input file failed. File not found on your GENERIC_S3 storage.` — a
		 * "file not found" for a port that was never open.
		 *
		 * Linode Object Storage serves S3 over HTTPS on 443, so both are now explicit. Still
		 * overridable from the credential for an install behind a proxy.
		 */
		return {
			host,
			port: optNum(cred.config.port) ?? 443,
			ssl: optBool(cred.config.ssl) ?? true,
			signatureVersion: "S3_V4",
		};
	}
	// GENERIC_S3: port/ssl/signatureVersion are all credential-configured.
	return {
		host,
		port: optNum(cred.config.port),
		ssl: optBool(cred.config.ssl),
		signatureVersion:
			typeof cred.config.signatureVersion === "string"
				? cred.config.signatureVersion
				: "S3_V4",
	};
}

/**
 * Muxing/DRM/manifest output target. DRM-owned-output muxings carry no
 * outputId ref — the SDK call then goes out without an outputs array.
 */
export function destinationOf(
	op: CompiledOperation,
	ctx: ExecutorContext,
): Destination | undefined {
	if (op.refs.outputId === undefined) {
		return undefined;
	}
	const mirrors = refIdList(op, ctx, "mirrorOutputIds");
	// : per-mirror wire paths ride the payload, aligned with the
	// mirror refs (an MSL mirror of a storage primary needs `/folder/`).
	const mirrorPaths = Array.isArray(op.payload.mirrorOutputPaths)
		? (op.payload.mirrorOutputPaths as unknown[]).map((p) =>
				typeof p === "string" ? p : undefined,
			)
		: undefined;
	return {
		outputId: refId(op, ctx, "outputId"),
		outputPath: str(op.payload.outputPath),
		acl: optStr(op.payload.acl),
		// : mirrors resolve HERE so every consumer between this
		// and the facade's outputs stays signature-identical.
		...(mirrors && mirrors.length > 0 ? { mirrorOutputIds: mirrors } : {}),
		...(mirrors && mirrors.length > 0 && mirrorPaths
			? {
					mirrorOutputPaths: mirrors.map(
						(_id, i) => mirrorPaths[i] ?? str(op.payload.outputPath),
					),
				}
			: {}),
	};
}

export function colorConfigOf(value: unknown): ColorConfigParams | undefined {
	// Compiler-validated plan shape; the facade maps enum NAMES inside.
	return value === undefined || value === null
		? undefined
		: (value as ColorConfigParams);
}

export function avMuxingKindOf(op: CompiledOperation): AvMuxingKind {
	const kind = str(op.payload.muxingKind);
	if (
		kind !== "CMAF" &&
		kind !== "FMP4" &&
		kind !== "TS" &&
		kind !== "MP4" &&
		kind !== "WEBM"
	) {
		throw new Error(`step "${op.step}" has unsupported muxingKind "${kind}"`);
	}
	return kind;
}

export function drmKindOf(
	op: CompiledOperation,
): "CENC" | "FAIRPLAY" | "SPEKE" | undefined {
	const drm = op.payload.drm as { kind?: unknown } | undefined;
	if (!drm) {
		return undefined;
	}
	const kind = str(drm.kind);
	if (kind !== "CENC" && kind !== "FAIRPLAY" && kind !== "SPEKE") {
		throw new Error(`step "${op.step}" has unsupported drm kind "${kind}"`);
	}
	return kind;
}

/** Keep run-time Per-Title references consistent with static manifests. */
export function stripBasePath(path: string, base: string): string {
	return relativeSegmentPath(path, base);
}

/** core joinFilePath semantics (smooth mediaFile = dir + filename). */
export function joinFilePath(dir: string, filename: string): string {
	if (dir === "") {
		return filename;
	}
	return dir.endsWith("/") ? `${dir}${filename}` : `${dir}/${filename}`;
}

/**
 * Per-title expansion source row: one PER_TITLE_RESULT muxing with its
 * (optional) DRM. The segment base comes from the DRM's encrypted output
 * when DRM is pinned (the muxing itself has no destination then) —
 * mirroring the python scripts' `drm[0].outputs[0].output_path`.
 */
export type ExpansionMuxing = {
	muxing: MuxingSummary;
	codecConfigId: string;
	drmId?: string;
	basePath: string;
};

export async function listPerTitleMuxings(
	op: CompiledOperation,
	ctx: ExecutorContext,
	encodingId: string,
): Promise<ExpansionMuxing[]> {
	const muxingKind = avMuxingKindOf(op);
	const drmKind = drmKindOf(op);
	const modeFilter = str(op.payload.streamModeFilter);
	const results: ExpansionMuxing[] = [];
	for (const muxing of await ctx.sdk.listMuxings(encodingId, muxingKind)) {
		const stream = await ctx.sdk.getStreamContext(encodingId, muxing.streamId);
		if (stream.mode !== modeFilter) {
			continue; // STANDARD/template muxings are statically compiled
		}
		let drmId: string | undefined;
		let drmOutputPath: string | undefined;
		if (drmKind) {
			const drms = await ctx.sdk.listMuxingDrm(
				encodingId,
				muxing.id,
				muxingKind,
				drmKind,
			);
			if (drms.length > 1) {
				// Two same-kind DRMs on one RESULT muxing = two encrypted copies at two
				// paths. One manifest entry references one base path; `drms[0]` would
				// silently omit every other copy's segments from the manifest (review of
				// PR #147 — the same first-of-many shape the repo has now hit four
				// times). No fixture and no real encoding produces this today, which is
				// exactly why it must fail loudly the day one does.
				throw new Error(
					`step "${op.step}": ${muxingKind} muxing ${muxing.id} carries ${drms.length} ${drmKind} DRMs — a manifest entry can reference only one encrypted base path`,
				);
			}
			const drm = drms[0];
			if (!drm) {
				continue; // python: skip result muxings without the pinned DRM
			}
			drmId = drm.id;
			drmOutputPath = drm.outputPath;
		}
		const basePath = drmKind ? drmOutputPath : muxing.outputPath;
		if (basePath === undefined) {
			throw new Error(
				`step "${op.step}": ${muxingKind} muxing ${muxing.id} has no output path to derive a manifest entry from`,
			);
		}
		results.push({
			muxing,
			codecConfigId: stream.codecConfigId,
			drmId,
			basePath,
		});
	}
	return results;
}

/**
 * The operator's credential-egress allowlist (COVERAGE C22 rail 3), read per
 * step so a restart is not needed to tighten it.
 *
 * Always an ARRAY, never undefined: `undefined` means "not the enforcement
 * point" in the plan validator, and the worker is unconditionally the
 * enforcement point — it is the process that POSTs the pair. Unset resolves to
 * `[]`, which warns rather than blocks (see the schema doc for why no built-in
 * vendor list exists).
 */
export function egressAllowlist(): string[] {
	return parseSecretEgressAllowlist(loadEnv().SECRET_EGRESS_ALLOWED_HOSTS);
}

/** Only retry failed read requests; provider terminal statuses are handled below. */
function transientStatusRead(error: unknown): boolean {
	const networkCodes = new Set([
		"ECONNRESET",
		"ECONNREFUSED",
		"ETIMEDOUT",
		"EPIPE",
		"EAI_AGAIN",
		"ENETUNREACH",
		"EHOSTUNREACH",
		"UND_ERR_CONNECT_TIMEOUT",
		"UND_ERR_HEADERS_TIMEOUT",
		"UND_ERR_BODY_TIMEOUT",
		"UND_ERR_SOCKET",
	]);
	// BitmovinCallError preserves the original transport exception as cause.
	for (
		let depth = 0;
		depth < 4 && typeof error === "object" && error !== null;
		depth++
	) {
		const value = error as {
			httpStatusCode?: unknown;
			code?: unknown;
			cause?: unknown;
		};
		if (typeof value.httpStatusCode === "number") {
			return [429, 502, 503, 504].includes(value.httpStatusCode);
		}
		if (typeof value.code === "string" && networkCodes.has(value.code))
			return true;
		error = value.cause;
	}
	return false;
}

export async function awaitTask(
	op: CompiledOperation,
	ctx: ExecutorContext,
	getStatus: () => Promise<TaskStatusResult>,
): Promise<TaskStatusResult> {
	const deadline = Date.now() + ctx.poll.timeoutMs;
	let consecutiveReadFailures = 0;
	for (;;) {
		let task: TaskStatusResult;
		try {
			task = await getStatus();
			consecutiveReadFailures = 0;
		} catch (error) {
			// Scope recovery to VOD GET status: never retry START/CREATE or manifest awaits.
			if (op.kind !== "AWAIT_ENCODING" || !transientStatusRead(error))
				throw error;
			if (ctx.shouldCancel && (await ctx.shouldCancel()))
				throw new CancelRequested(op.step);
			// Five additional reads at the normal poll interval, within the existing deadline.
			if (++consecutiveReadFailures > 5 || Date.now() >= deadline) throw error;
			await ctx.poll.sleep(
				Math.min(ctx.poll.intervalMs, deadline - Date.now()),
			);
			if (Date.now() >= deadline) throw error;
			continue;
		}
		if (task.status === "FINISHED") {
			return task;
		}
		if (
			task.status === "ERROR" ||
			task.status === "CANCELED" ||
			task.status === "TRANSFER_ERROR"
		) {
			const detail = task.messages?.length
				? `: ${task.messages.join("; ")}`
				: "";
			throw new Error(`${op.step} ended ${task.status}${detail}`);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`${op.step} timed out after ${Math.round(ctx.poll.timeoutMs / 1000)}s (last status ${task.status})`,
			);
		}
		// Cooperative cancel . Checked AFTER the terminal-state and
		// timeout checks so a natural FINISHED/ERROR on this poll still wins (we
		// never cancel an encoding that just completed); only a genuinely-still-
		// waiting await is interrupted, once per poll interval. Throws the typed
		// signal so the processor takes the CANCELED finalize, not the ERROR path.
		if (ctx.shouldCancel && (await ctx.shouldCancel())) {
			throw new CancelRequested(op.step);
		}
		await ctx.poll.sleep(ctx.poll.intervalMs);
	}
}

/**
 * AWAIT_LIVE_RUNNING: RUNNING is the live channel's STEADY state and the
 * success condition (VOD's awaitTask succeeds on FINISHED, a terminal
 * state). Polling is an ALLOWLIST — only CREATED/QUEUED are en-route
 * states; everything else fails fast. That covers the explicit failures
 * (ERROR/TRANSFER_ERROR), typed cancellation (CANCELED), FINISHED (a live encoding FINISHED
 * before RUNNING stopped before coming up), and any state outside the
 * startup path (IDLE, or a future SDK addition) — polling those would
 * wedge the job until the multi-hour timeout.
 */
export async function awaitLiveRunning(
	op: CompiledOperation,
	ctx: ExecutorContext,
	getStatus: () => Promise<TaskStatusResult>,
	encodingId: string,
): Promise<TaskStatusResult> {
	const deadline = Date.now() + ctx.poll.timeoutMs;
	for (;;) {
		if (ctx.shouldCancel && (await ctx.shouldCancel()))
			throw new CancelRequested(op.step);
		const task = await getStatus();
		if (task.status === "RUNNING") {
			return task;
		}
		if (task.status !== "CREATED" && task.status !== "QUEUED") {
			const detail = task.messages?.length
				? `: ${task.messages.join("; ")}`
				: "";
			const message = `${op.step} ended ${task.status} before reaching RUNNING${detail}`;
			if (task.status === "CANCELED") {
				throw new LiveEncodingCanceled(encodingId, task, message);
			}
			throw new Error(message);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`${op.step} timed out after ${Math.round(ctx.poll.timeoutMs / 1000)}s (last status ${task.status})`,
			);
		}
		await ctx.poll.sleep(ctx.poll.intervalMs);
	}
}

/**
 * START_LIVE_ENCODING zip contract (compiler header): refs carry the
 * manifest create steps in plan order ("manifest:<key>"), the payload
 * carries per-manifest start options keyed by PLAN manifest key — ref
 * position i pairs with the options entry of its own key. The compiler
 * emits an entry for every referenced manifest (empty = API defaults), so
 * a missing entry is a corrupt payload, not a default.
 */
export function zipLiveManifests<
	T extends LiveHlsStartOptions | LiveDashStartOptions,
>(
	op: CompiledOperation,
	ctx: ExecutorContext,
	refKey: string,
	options: Record<string, T> | undefined,
): ({ manifestId: string } & T)[] | undefined {
	const target = op.refs[refKey];
	if (target === undefined) {
		return undefined;
	}
	const steps = Array.isArray(target) ? target : [target];
	return steps.map((step) => {
		const manifestId = ctx.ids.get(step);
		if (!manifestId) {
			throw new MissingRefError(op.step, refKey);
		}
		const planKey = step.startsWith("manifest:")
			? step.slice("manifest:".length)
			: step;
		const startOptions = options?.[planKey];
		if (!startOptions) {
			throw new Error(
				`step "${op.step}": no start options entry for manifest key "${planKey}" (compiler contract violated)`,
			);
		}
		return { manifestId, ...startOptions };
	});
}

/** START_* statuses proving the start already happened (crash recovery). */
export const STARTED_STATUSES = new Set(["QUEUED", "RUNNING", "FINISHED"]);
