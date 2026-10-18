import "server-only";
import {
	parseStorageEndpointAllowlist,
	type SourceIdentity,
} from "@bitovp/core";
import {
	type BrowserCredential,
	createBrowserForCredential,
	describeStorageError,
	type ObjectStorageBrowser,
	storageErrorText,
	UnsupportedBrowseError,
} from "@bitovp/storage";
import { customerErrorDetails } from "@/lib/customer-error";
import type { getServerContext } from "./context";
import { jsonError } from "./http";

/** undefined = variable absent (unrestricted, warned); throws on set-but-empty. */
function storageEndpointAllowlist(): readonly string[] | undefined {
	const raw = process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS;
	if (raw === undefined) {
		return undefined;
	}
	return parseStorageEndpointAllowlist(raw);
}

let warnedUnrestrictedEndpoint = false;
function warnUnrestrictedEndpointOnce(message: string): void {
	if (warnedUnrestrictedEndpoint) {
		return;
	}
	warnedUnrestrictedEndpoint = true;
	console.warn(`[storage] ${message}`);
}

/**
 * Resolves a credential row + decrypted secret into a browsing driver.
 * Returns null when the credential does not exist. Callers must invoke
 * browser.dispose?. in a finally block (socket pools).
 */
export async function browserForCredentialId(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	credentialId: string,
): Promise<ObjectStorageBrowser | null>;
export async function browserForCredentialId(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	credentialId: string,
	stopIf: undefined,
	options: { readTimeoutMs: number },
): Promise<ObjectStorageBrowser | null>;
export async function browserForCredentialId(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	credentialId: string,
	stopIf: (config: Record<string, unknown>) => boolean,
): Promise<ObjectStorageBrowser | null | "stopped">;
export async function browserForCredentialId(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	credentialId: string,
	/**
	 * Inspect the non-secret config and stop, BEFORE the secret is decrypted.
	 *
	 * The CORS check needs to know whether a `publicBaseUrls` entry makes the
	 * bucket the wrong host to ask about, and that decision needs config only. Its
	 * first version did a separate `findUnique` first, which bought the early exit
	 * on the declared path at the cost of a THIRD read on the common one — this
	 * store already does two (`get` + `revealSecret`). Passing the decision in
	 * costs nothing on either path: declared exits after one read with no
	 * decryption, and not-declared stays at two (review catch).
	 */
	stopIf?: (config: Record<string, unknown>) => boolean,
	options?: { readTimeoutMs: number },
): Promise<ObjectStorageBrowser | null | "stopped"> {
	// Overloads above: a caller that passes no `stopIf` cannot receive "stopped",
	// so the existing browse routes keep their original two-case return type.
	const credential = await ctx.credentials.get(credentialId);
	if (!credential) {
		return null;
	}
	/**
	 * A COPY, not the live object. `?? {}` allocates nothing when `config` is
	 * non-null, so the un-spread version handed the hook the very same reference
	 * that `browserCredential` below carries into the driver — and `endpoint` /
	 * `region` decide where the AES-GCM-decrypted secret is sent. A hook that
	 * returned `false` after setting `config.endpoint = "https://attacker.tld"`
	 * redirected it, measured; `assertSecretEgressAllowed` (C22) only runs in the
	 * worker, so nothing on this path would have caught it. Not exploitable today —
	 * the one hook is pure — but the docblock below says "inspect", and the signature
	 * should not grant more than that (review finding).
	 */
	if (stopIf?.({ ...((credential.config ?? {}) as Record<string, unknown>) })) {
		return "stopped";
	}
	const secretJson = await ctx.credentials.revealSecret(credentialId);
	let secret: Record<string, string>;
	try {
		secret = JSON.parse(secretJson) as Record<string, string>;
	} catch {
		// Constant message: V8 SyntaxErrors embed input snippets and
		// routeError logs messages (the shared contract: secrets redacted in logs).
		throw new Error("Stored secret payload is corrupted");
	}
	const browserCredential: BrowserCredential = {
		provider: credential.provider,
		config: (credential.config ?? {}) as Record<string, unknown>,
		secret,
	};
	return createBrowserForCredential(browserCredential, {
		...options,
		// : the STORAGE_ENDPOINT_ALLOWED_HOSTS rail — GENERIC_S3's
		// free endpoint is the SSRF reach C22 names. Parsed per call so a
		// throwing parse surfaces as a request error, not a module-load crash.
		endpointAllowlist: storageEndpointAllowlist(),
		onWarning: warnUnrestrictedEndpointOnce,
	});
}

/**
 *  — SEAL an object's version at arm time (audit 2026-08-29 HIGH-4).
 *
 * `{credentialId, bucket, key}` names a LOCATION, and a location is not a
 * version: an object replaced under the same key between arm and air used to
 * be pushed silently, and afterwards nothing could tell the aired bytes from
 * the chosen ones. This reads the provider's own name for the version that is
 * there NOW, so the feeder's download can demand it.
 *
 * Three distinct answers, because collapsing them would each be a different
 * lie:
 *  - `{ ok: true, identity }` — sealed;
 *  - `{ ok: true, identity: null }` — the driver has no `headObject`, so no
 *    version can be named. The feed still runs, unsealed, exactly as it did
 *    before this existed. A driver limitation is not a reason to refuse.
 *  - `{ ok: false, message }` — the object could not be read at all (missing,
 *    denied, endpoint down). Worth refusing AT THE DOOR: a source that is not
 *    there when it is scheduled will not be there at air either, and the
 *    operator is present now.
 *
 * The message is `storageErrorText`'s classified form (C20) — never the SDK's,
 * which can embed endpoint hosts.
 */
export async function sealSourceIdentity(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	credentialId: string,
	bucket: string,
	key: string,
): Promise<
	{ ok: true; identity: SourceIdentity | null } | { ok: false; message: string }
> {
	let browser: ObjectStorageBrowser | null;
	try {
		browser = await browserForCredentialId(ctx, credentialId);
	} catch (err) {
		if (err instanceof UnsupportedBrowseError) {
			// A provider that cannot browse cannot be sealed — and cannot be
			// fed either, which the caller's own provider gate already refuses.
			return { ok: true, identity: null };
		}
		return { ok: false, message: storageErrorText(err) };
	}
	if (!browser) {
		return { ok: false, message: "Source storage credential does not exist" };
	}
	try {
		if (!browser.headObject) {
			return { ok: true, identity: null };
		}
		const identity = await browser.headObject({ bucket, key });
		return {
			ok: true,
			identity: {
				...(identity.etag !== undefined ? { etag: identity.etag } : {}),
				...(identity.versionId !== undefined
					? { versionId: identity.versionId }
					: {}),
				...(identity.generation !== undefined
					? { generation: identity.generation }
					: {}),
				size: identity.size,
			},
		};
	} catch (err) {
		return { ok: false, message: storageErrorText(err) };
	} finally {
		browser.dispose?.();
	}
}

/**
 * Upstream storage failures: surface error class + status only — SDK
 * messages can embed endpoint hosts and request details.
 *
 * The classification itself lives in `@bitovp/storage` (`describeStorageError`)
 * so the WORKER's inspect path enforces C20 with provably the same rule; this
 * function is just its HTTP shape.
 */
export function storageErrorResponse(err: unknown) {
	if (err instanceof UnsupportedBrowseError) {
		return jsonError(
			400,
			"Storage browsing is not supported for this credential",
			customerErrorDetails("STORAGE_BROWSE_UNSUPPORTED"),
		);
	}
	const { code, status } = describeStorageError(err);
	console.error("[api] storage request failed:", code, status ?? "");
	/**
	 * The classified code and status ride in `details` so the CLIENT can say
	 * something useful in the operator's language.
	 *
	 * Before this, both storage UIs rendered `err.message` verbatim, so a
	 * bucket the key is not scoped to produced "Storage request failed:
	 * AccessDenied (upstream 403)" and nothing else — accurate, English-only,
	 * and silent about the one thing the operator needs to know (owner report
	 * 2026-08-20, ). C20 is untouched: this is the same classified
	 * pair, never the vendor's message.
	 */
	return jsonError(502, storageErrorText(err), { code, status });
}
