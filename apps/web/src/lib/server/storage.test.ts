import type { ObjectStorageBrowser } from "@bitovp/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserForCredentialId, sealSourceIdentity } from "./storage";

/** : the seal reads the driver's `headObject`, so the fake grows one. */
const headObject = vi.fn();
const dispose = vi.fn();

vi.mock("@bitovp/storage", () => ({
	createBrowserForCredential: vi.fn(() => ({
		headObject: (input: unknown) => headObject(input),
		dispose,
	})),
	describeStorageError: vi.fn(() => ({ code: "StorageError" })),
	storageErrorText: vi.fn(() => "storage error"),
	UnsupportedBrowseError: class extends Error {},
}));

/**
 * Compile-time half of the same contract.
 *
 * Written twice, because the first version measured the wrong thing and the two
 * instruments disagreed: an assignment probe accepted
 * `const narrow: ObjectStorageBrowser | null = b` while an exactness assertion on
 * `Awaited<ReturnType<typeof browserForCredentialId>>` reported `false`. Both are
 * true — `ReturnType` on an overloaded function resolves to the WIDEST signature
 * (so the alias does contain `"stopped"`), and the assignment only passed because
 * control-flow analysis narrows a variable from a 2-argument call. So the property
 * worth pinning is the CALL's type, per overload, which is what these do.
 *
 * The browse routes no longer declare themselves via that alias for exactly this
 * reason: their safety was resting on CFA carrying a narrowing across a try/catch,
 * which my widening of the last overload had quietly made load-bearing.
 */
type Expect<T extends true> = T;
type IsExactly<A, B> =
	(<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
		? true
		: false;
declare const ctxT: Parameters<typeof browserForCredentialId>[0];
const noHookCall = () => browserForCredentialId(ctxT, "cred");
const withHookCall = () => browserForCredentialId(ctxT, "cred", () => true);
type _NoHookExcludesSentinel = Expect<
	IsExactly<Awaited<ReturnType<typeof noHookCall>>, ObjectStorageBrowser | null>
>;
type _WithHookIncludesSentinel = Expect<
	IsExactly<
		Awaited<ReturnType<typeof withHookCall>>,
		ObjectStorageBrowser | null | "stopped"
	>
>;

const get = vi.fn();
const revealSecret = vi.fn();

function ctx() {
	return { credentials: { get, revealSecret } } as unknown as Parameters<
		typeof browserForCredentialId
	>[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	get.mockResolvedValue({
		provider: "AWS_S3",
		config: { region: "eu-west-1", publicBaseUrls: { out: "https://cdn.dev" } },
	});
	revealSecret.mockResolvedValue(
		JSON.stringify({ accessKeyId: "a", secretAccessKey: "s" }),
	);
});

/**
 * `stopIf` exists so the CORS check can decline on config alone, and its whole
 * value is the ORDER: config is read, the hook decides, and only then is the
 * secret decrypted. Asserted here because this is the only place the ordering is
 * observable — a caller that mocks this function cannot see it.
 */
describe("browserForCredentialId — the stopIf hook", () => {
	it("does not decrypt the secret when the hook stops", async () => {
		const result = await browserForCredentialId(ctx(), "cred-1", () => true);
		expect(result).toBe("stopped");
		expect(get).toHaveBeenCalledOnce();
		// The point of the hook: one read, no decryption.
		expect(revealSecret).not.toHaveBeenCalled();
	});

	it("receives the non-secret config, so the hook can decide on it", async () => {
		const seen: Record<string, unknown>[] = [];
		await browserForCredentialId(ctx(), "cred-1", (config) => {
			seen.push(config);
			return false;
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ region: "eu-west-1" });
	});

	it("builds the browser normally when the hook declines to stop", async () => {
		const result = await browserForCredentialId(ctx(), "cred-1", () => false);
		expect(result).not.toBe("stopped");
		expect(result).not.toBeNull();
		// Two reads on the common path, exactly as before the hook existed.
		expect(revealSecret).toHaveBeenCalledOnce();
	});

	it("is unchanged for callers that pass no hook", async () => {
		const result = await browserForCredentialId(ctx(), "cred-1");
		expect(result).not.toBeNull();
		expect(revealSecret).toHaveBeenCalledOnce();
	});

	it("returns null for a missing credential without consulting the hook", async () => {
		get.mockResolvedValueOnce(null);
		const stopIf = vi.fn(() => true);
		expect(await browserForCredentialId(ctx(), "gone", stopIf)).toBeNull();
		expect(stopIf).not.toHaveBeenCalled();
	});
});

/**
 * The hook must not be able to change where the secret goes.
 *
 * `config.endpoint`/`region` decide the egress host for the AES-GCM-decrypted
 * secret, and `assertSecretEgressAllowed` (C22) only runs in the worker — nothing on
 * this path would catch a redirect. The first version passed the hook the *same*
 * object it then handed the driver (`?? {}` allocates nothing when config is
 * non-null), so a hook could rewrite it and return `false`. Review measured exactly
 * that. Copied now, and this pins it.
 */
describe("browserForCredentialId — the hook cannot mutate what the driver receives", () => {
	it("hands the hook a copy, so a rewritten endpoint does not reach the driver", async () => {
		get.mockResolvedValue({
			provider: "GENERIC_S3",
			config: { endpoint: "https://legit.example", region: "eu-west-1" },
		});
		await browserForCredentialId(ctx(), "cred-1", (config) => {
			(config as { endpoint?: string }).endpoint = "https://attacker.tld";
			return false;
		});
		const { createBrowserForCredential } = await import("@bitovp/storage");
		const passed = vi.mocked(createBrowserForCredential).mock.calls[0]?.[0] as
			| { config?: { endpoint?: string } }
			| undefined;
		expect(passed?.config?.endpoint).toBe("https://legit.example");
	});
});

/**
 *  (audit 2026-08-29 HIGH-4). Three answers, because collapsing any
 * two of them would be a different lie: sealed, "this driver cannot name a
 * version" and "the object could not be read at all".
 */
describe("sealSourceIdentity", () => {
	it("returns the provider's version selectors VERBATIM", async () => {
		// S3 returns ETags wrapped in quotes and expects the same quoted form
		// back in If-Match; stripping them here is a silent always-mismatch.
		headObject.mockResolvedValue({
			etag: '"abc123"',
			versionId: "v-1",
			size: 4096,
			lastModified: "2026-08-29T00:00:00.000Z",
		});
		const result = await sealSourceIdentity(ctx(), "cred-1", "media", "a.mp4");
		expect(result).toEqual({
			ok: true,
			// lastModified is deliberately NOT sealed: it survives a same-size
			// overwrite, which is the very case the seal exists for.
			identity: { etag: '"abc123"', versionId: "v-1", size: 4096 },
		});
		expect(headObject).toHaveBeenCalledWith({ bucket: "media", key: "a.mp4" });
		expect(dispose).toHaveBeenCalled();
	});

	it("a driver with no headObject answers ok WITH A NULL identity — a limitation, not a refusal", async () => {
		const storage = await import("@bitovp/storage");
		vi.mocked(storage.createBrowserForCredential).mockReturnValueOnce({
			dispose,
		} as never);
		await expect(
			sealSourceIdentity(ctx(), "cred-1", "media", "a.mp4"),
		).resolves.toEqual({ ok: true, identity: null });
	});

	it("an unreadable object answers NOT ok, with the classified message (C20)", async () => {
		headObject.mockRejectedValue(new Error("NoSuchKey: endpoint s3.internal"));
		const result = await sealSourceIdentity(ctx(), "cred-1", "media", "a.mp4");
		expect(result).toEqual({ ok: false, message: "storage error" });
		// C20: never the SDK's own message — it can embed endpoint hosts.
		expect(JSON.stringify(result)).not.toContain("s3.internal");
		expect(dispose).toHaveBeenCalled();
	});

	it("a missing credential answers NOT ok rather than throwing", async () => {
		get.mockResolvedValueOnce(null);
		await expect(
			sealSourceIdentity(ctx(), "cred-1", "media", "a.mp4"),
		).resolves.toMatchObject({ ok: false });
	});
});
