import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Next only loads .env from the app directory; this monorepo keeps ONE
// .env at the repo root (README quickstart). Pull it in at server boot —
// loadEnvFile never overrides variables already set in the shell. Without
// this, MASTER_KEY & friends silently never reach route handlers.
// The root is located by the pnpm-workspace.yaml marker so this works no
// matter which directory Next is launched from.
function findRepoRootEnv(): string | null {
	let dir = process.cwd();
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
			const envFile = resolve(dir, ".env");
			return existsSync(envFile) ? envFile : null;
		}
		const parent = resolve(dir, "..");
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
	return null;
}

const rootEnvFile = findRepoRootEnv();
if (rootEnvFile) {
	process.loadEnvFile(rootEnvFile);
}

const nextConfig: NextConfig = {
	// Do not generate framework-specific agent instruction files.
	agentRules: false,
	transpilePackages: ["@bitovp/core", "@bitovp/db", "@bitovp/storage"],
	/**
	 * `@bitmovin/api-sdk` must NOT be bundled into server output .
	 *
	 * Bundled, it returned `r.call is not a function` from any route that touches the
	 * SDK. `r` was DEFINED BUT NOT CALLABLE — an ESM/CJS interop namespace wrapper —
	 * not an undefined superclass, which an earlier version of this comment claimed:
	 * V8 says "Cannot read properties of undefined" for that case, `__extends` throws
	 * its own TypeError before `_super.call` can run, and `BitmovinError` (itself an
	 * `__extends` subclass) constructed fine while REPORTING the error, so the class
	 * machinery was working (review catch, each point measured). The likely subjects
	 * are the plain-function CJS deps the SDK requires in the request path —
	 * `es6-promise.polyfill`, `urljoin`, `isomorphic-fetch` — which resolve
	 * natively once node's own `require` does the resolving.
	 *
	 * It cost the per-title backfill route (a hard 502 in production) and put two live
	 * routes that call paginated `.list` at the same risk —
	 * `/api/live/rtmp-inputs`, `/api/live/standby-pools` — neither of which had ever
	 * run against real credentials. `server-only`-guarded, so leaving it external
	 * cannot widen what reaches the browser.
	 *
	 * `@google-cloud/storage` and `@azure/storage-blob` joined 2026-08-17 (ledger
	 * #112): Next's default externals list carries `@aws-sdk/client-s3` but NEITHER
	 * of these, so both were verified INLINED into the server chunk — the same
	 * interop class as #74, on exactly the two storage drivers that have never run
	 * against real credentials (#12). No throw was observed (the row grades this
	 * suspect a HYPOTHESIS); externalizing is cheap regardless, and
	 * `assert-sdk-external.sh` now asserts all three artefacts.
	 */
	serverExternalPackages: [
		"@bitmovin/api-sdk",
		"@google-cloud/storage",
		"@azure/storage-blob",
	],
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "Referrer-Policy", value: "same-origin" },
				],
			},
		];
	},
};

export default nextConfig;
