import { z } from "zod";

/**
 * Server-side environment. Local URLs name the restricted runtime role;
 * db:runtime:prepare supplies its private password. Secrets (Bitmovin API keys, storage
 * credentials) are NOT env vars — they live encrypted in Postgres
 * (ARCHITECTURE §10); only the MASTER_KEY that wraps them is env-provided,
 * and it is validated where it is consumed (packages/core crypto, P0 PR2).
 */
const envSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	DATABASE_URL: z
		.string()
		.min(1)
		.default("postgresql://bitovp_runtime@localhost:5432/bitovp"),
	REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
	/**
	 * Webhook signature MASTER secret (WP-G G-1). Optional on purpose: when
	 * unset, the app generates 32 random bytes at first use and keeps them
	 * AES-encrypted under MASTER_KEY in `AppSetting` — the env value wins
	 * whenever it is present. Per-registration keys are derived from it
	 * (`packages/core/src/webhooks/keys.ts`); it is also the key the LEGACY
	 * receiver at `/api/webhooks/bitmovin` verifies hand-registered hooks with.
	 */
	BITMOVIN_WEBHOOK_SECRET: z.string().min(1).optional(),
	/**
	 * Public base URL — the `static` ingress mode's answer (WP-G G-1). Read by
	 * the WORKER's ingress monitor, which persists the resolved value under
	 * `AppSetting[ingress.current]`; the web app reads that row, never this
	 * variable, so registration, the Host allowlist and the settings screen
	 * cannot disagree. Also the users-mode TLS commitment (apps/web auth
	 * config) and the notify bus's absolute-link base.
	 */
	PUBLIC_BASE_URL: z.string().min(1).optional(),
	/**
	 * How the public ingress is discovered (WP-G G-1): `static` (default —
	 * PUBLIC_BASE_URL as-is), `quick-tunnel` (ask the cloudflared sidecar's
	 * metrics endpoint for its *.trycloudflare.com hostname), `named-tunnel`
	 * (INGRESS_HOSTNAME, https), `none`. Validated where it is consumed
	 * (`parseIngressConfig`) so a typo fails the worker loudly rather than
	 * silently turning webhooks off.
	 */
	INGRESS_MODE: z.string().min(1).optional(),
	/** `named-tunnel`: the public hostname the tunnel serves (no scheme). */
	INGRESS_HOSTNAME: z.string().min(1).optional(),
	/**
	 * `quick-tunnel`: where the sidecar's `/quicktunnel` endpoint is. Default
	 * `http://ingress:20241/quicktunnel` (the compose service); a host
	 * `pnpm dev` worker beside a compose sidecar uses the published loopback
	 * port, `http://127.0.0.1:20241/quicktunnel`.
	 */
	INGRESS_QUICKTUNNEL_METRICS_URL: z.string().min(1).optional(),
	/** ffmpeg/ffprobe binaries (P3 feeder, P4 VMAF). PATH lookup by default. */
	FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
	FFPROBE_PATH: z.string().min(1).default("ffprobe"),
	/** Feeder source spool directory (default: <os tmpdir>/bitovp-feeder). */
	FEEDER_SPOOL_DIR: z.string().min(1).optional(),
	/** VMAF runner working directory (default: <os tmpdir>/bitovp-vmaf). */
	VMAF_WORKDIR: z.string().min(1).optional(),
	/**
	 * Directory holding the libvmaf model JSONs (Dockerfile sets it to
	 * /opt/vmaf/model). The runner uses `model=version=` (compiled-in models)
	 * by default; this is only needed if a plan ever names a model the build
	 * does not embed, addressed by `model=path=$VMAF_MODEL_DIR/<model>.json`.
	 */
	VMAF_MODEL_DIR: z.string().min(1).optional(),
	/** Experimental local VOD decoding; CPU is unchanged unless explicitly enabled. */
	VMAF_DECODE_BACKEND: z.enum(["cpu", "auto", "cuda"]).default("cpu"),
	/** External experimental VMAFx build; the bundled libvmaf CPU scorer is the default. */
	VMAF_SCORING_BACKEND: z.enum(["cpu", "vmafx-cuda"]).default("cpu"),
	/** CUDA ordinal among the devices visible to this worker. */
	VMAF_GPU_DEVICE: z.coerce.number().int().nonnegative().safe().default(0),
	/** Optional local VOD binary, independent of the Live feeder and cloud image. */
	VMAF_FFMPEG_PATH: z.string().min(1).optional(),
	/**
	 * Local quality settings: CONCURRENCY caps simultaneous mirrors and THREADS
	 * fixes libvmaf threads per pair. Missing values are selected from the CPU
	 * quota, memory headroom and probed video metadata. Neither changes quality
	 * settings or frame sampling; memory admission can reduce actual overlap.
	 */
	VMAF_CONCURRENCY: z.coerce.number().int().positive().optional(),
	/**
	 * How many worker deaths a long-running job survives before BullMQ retires
	 * it . Validated here rather than parsed with bare `Number`
	 * at the call site: `Number("")` is 0, which BullMQ reads as "never fail" —
	 * the exact inverse of the invariant the stall policy states — and `??`
	 * does not catch the empty string a `KEY=` line in a .env produces. That is
	 * what `loadEnv`'s own blank-stripping above exists for.
	 */
	WORKER_MAX_STALLED_COUNT: z.coerce.number().int().positive().optional(),
	VMAF_THREADS: z.coerce.number().int().positive().optional(),
	/** : age-based prune of StorageInspection rows (days). The rows
	    hold CUSTOMER data (bucket, key, probed media metadata) and accumulated
	    forever; the prune rides the heartbeat sweep. 0 disables. */
	INSPECTION_RETENTION_DAYS: z.coerce.number().int().nonnegative().optional(),
	/**
	 * Frame subsample stride (libvmaf `n_subsample`); default unset = full
	 * precision. When > 1, libvmaf scores every Nth frame — faster, but a sparser
	 * per-frame series and a less-reliable min (the pooled mean is barely
	 * affected). Opt-in: scoring accuracy is unchanged unless this is set.
	 */
	VMAF_SUBSAMPLE: z.coerce.number().int().positive().optional(),
	/**
	 * Hostnames allowed to receive vaulted credentials (COVERAGE C22): the
	 * encoder POSTs the Kantar login/password and ESAM POIS pair to whatever
	 * host the plan names, so this is the only setting that stops a plan author
	 * choosing the destination. Comma-separated; exact hostnames, or
	 * `.example.com` for subdomains. Unset = no restriction, and plan validation
	 * says so out loud rather than passing quietly (see plan/egress.ts).
	 */
	SECRET_EGRESS_ALLOWED_HOSTS: z.string().optional(),
	/** Internal deployment opt-in; never inferred from an account label. */
	BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID: z.uuid().optional(),
	/** Retained to reject retired or unknown deployment configuration at startup. */
	DEPLOYMENT_PROFILE: z.literal("UNRESTRICTED").default("UNRESTRICTED"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
	// Blank lines in .env templates (KEY=) mean "unset", not "empty string"
	// — otherwise copying .env.example crashes on optional vars.
	const cleaned = Object.fromEntries(
		Object.entries(source).filter(
			([, value]) => value !== undefined && value !== "",
		),
	) as NodeJS.ProcessEnv;
	const parsed = envSchema.safeParse(cleaned);
	if (!parsed.success) {
		throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
	}
	if (
		parsed.data.VMAF_SCORING_BACKEND === "vmafx-cuda" &&
		(!parsed.data.VMAF_FFMPEG_PATH || !parsed.data.VMAF_MODEL_DIR)
	)
		throw new Error(
			"VMAF_SCORING_BACKEND=vmafx-cuda requires explicit VMAF_FFMPEG_PATH and VMAF_MODEL_DIR",
		);
	if (parsed.data.NODE_ENV === "production") {
		const missing = (["DATABASE_URL", "REDIS_URL"] as const).filter(
			(key) => !cleaned[key],
		);
		if (missing.length > 0) {
			throw new Error(
				`Missing required env vars in production: ${missing.join(", ")} ` +
					"(development defaults are never used in production)",
			);
		}
	}
	return parsed.data;
}
