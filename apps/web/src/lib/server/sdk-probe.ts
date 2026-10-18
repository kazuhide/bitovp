/**
 * : the DEPLOYED artefact proves its own SDK packaging.
 *
 * `assert-sdk-external.sh` validates the artefact at BUILD time and says
 * nothing about what is running — a container built before the #74 fix
 * 502s all 35 SDK routes with nothing naming the cause, and the modes the
 * row lists as expected breakage (`output: "standalone"`, a symlink-
 * dereferencing copy, `pnpm prune --prod` between build and run) all break
 * AFTER the build gate passed. This probe runs the same resolution the
 * routes depend on, once, in the server runtime that is actually deployed:
 * if the shim tree did not ship, the dynamic import rejects; if the SDK
 * was inlined or mangled, the constructor shape check fails. /api/health
 * surfaces the result, so the first request names the packaging defect
 * instead of the thirty-five routes 502ing around it.
 */

let cached: Promise<string | null> | null = null;

/** Resolves null when the SDK is usable; otherwise the failure, named. */
export function probeSdkExternal(): Promise<string | null> {
	cached ??= (async () => {
		try {
			const mod = (await import("@bitmovin/api-sdk")) as unknown as {
				default?: unknown;
			};
			// Same shape-agnostic interop as sdk-ops.ts: bundlers hand the class
			// itself as `default`; tsx/Node native interop hands the CJS module
			// namespace ({ default: class, ...named }) one level deeper.
			const d = mod.default;
			const ctor =
				typeof d === "function" ? d : (d as { default?: unknown })?.default;
			return typeof ctor === "function"
				? null
				: "@bitmovin/api-sdk resolved but no constructor shape — inlined or mangled packaging";
		} catch (err) {
			return `@bitmovin/api-sdk failed to resolve at runtime: ${err instanceof Error ? err.message : String(err)}`;
		}
	})();
	return cached;
}

/** Test seam: the probe memoizes (one import per process) — reset between cases. */
export function resetSdkProbeForTests(): void {
	cached = null;
}
