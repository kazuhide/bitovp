import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { createSubmissionClient } from "./creation-submission";

const send = vi.fn();
const scope = ["org", "user", "vod", "wizard"];
const body = {
	plan: { name: "Job", accountId: "account-a", secret: "SECRET" },
};
const client = (identity = scope) =>
	createSubmissionClient(identity, { storage: sessionStorage, send });
const request = (index = 0) => send.mock.calls[index]?.[1] as RequestInit;
const key = (index = 0) =>
	new Headers(request(index).headers).get("Idempotency-Key");

beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
	sessionStorage.clear();
	vi.clearAllMocks();
	send.mockRejectedValue(new Error("response lost"));
});

it("keeps the same request after a lost response, manual retry and reload", async () => {
	await expect(client().submit(body)).rejects.toThrow("response lost");
	await expect(client().submit(body)).rejects.toThrow("response lost");
	expect(key()).toMatch(/^[A-Za-z0-9._:-]{1,200}$/);
	expect(key(1)).toBe(key());
	expect(request(1).body).toBe(request().body);
	expect(JSON.stringify(sessionStorage)).not.toContain("SECRET");
	expect(JSON.stringify(sessionStorage)).not.toContain("Job");
});

it("claims a durable base synchronously before hashing or sending", async () => {
	const pending = client().submit(body);
	expect(sessionStorage.length).toBe(1);
	expect(send).not.toHaveBeenCalled();
	await expect(pending).rejects.toThrow("response lost");
});

it("shares an in-flight same-intent submission across helper instances", async () => {
	let resolve!: (value: { id: string }) => void;
	send.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const first = client().submit(body);
	const second = client().submit(body);
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	resolve({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	expect(await first).toEqual({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	expect(await second).toEqual({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
});

it("changes the key for changed payloads while preserving older unresolved intent", async () => {
	await expect(client().submit(body)).rejects.toThrow();
	const changed = { plan: { ...body.plan, name: "Edited" } };
	send.mockResolvedValueOnce({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2" });
	await client().submit(changed);
	await expect(client().submit(body)).rejects.toThrow();
	expect(key(1)).not.toBe(key());
	expect(key(2)).toBe(key());
});

it("starts a fresh intent after confirmed success", async () => {
	send.mockResolvedValue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	await client().submit(body);
	await client().submit(body);
	expect(key(1)).not.toBe(key());
});

it.each([
	["other-org", "user", "vod", "wizard"],
	["org", "other-user", "vod", "wizard"],
	["org", "user", "live", "wizard"],
	["org", "user", "vod", "preset:other:2"],
])("separates identity and form scope %j", async (...otherScope) => {
	await expect(client().submit(body)).rejects.toThrow();
	await expect(client(otherScope).submit(body)).rejects.toThrow();
	expect(key(1)).not.toBe(key());
});

it("separates accounts and includes schedule and template provenance in intent", async () => {
	for (const changed of [
		body,
		{ plan: { ...body.plan, accountId: "account-b" } },
		{ ...body, schedule: { streamUpAt: "2030-01-01T00:00:00Z" } },
		{ ...body, presetId: "preset", presetRevision: 2 },
	])
		await expect(client().submit(changed)).rejects.toThrow();
	expect(new Set(send.mock.calls.map((_, index) => key(index))).size).toBe(4);
});

it("keeps template time and output nonce stable on retry and distinct after editing", async () => {
	const build = (seed: { createdAt: number; nonce: string }) => ({
		plan: { output: `${seed.createdAt}/${seed.nonce}` },
	});
	await expect(client().submit(body, build)).rejects.toThrow();
	await expect(client().submit(body, build)).rejects.toThrow();
	await expect(
		client().submit({ ...body, name: "edited" }, build),
	).rejects.toThrow();
	expect(request(1).body).toBe(request().body);
	expect(request(2).body).not.toBe(request().body);
});

it("canonicalizes object order without changing ordered arrays", async () => {
	await expect(client().submit({ a: 1, b: [1, 2] })).rejects.toThrow();
	await expect(client().submit({ b: [1, 2], a: 1 })).rejects.toThrow();
	await expect(client().submit({ a: 1, b: [2, 1] })).rejects.toThrow();
	expect(key(1)).toBe(key());
	expect(key(2)).not.toBe(key());
});

it("keeps punctuation and non-ASCII keys stable with JSON omission and null semantics", async () => {
	await expect(
		client().submit({
			é: 1,
			Z: 2,
			"!": 3,
			missing: undefined,
			array: [undefined, Number.NaN],
		}),
	).rejects.toThrow();
	await expect(
		client().submit({ array: [null, null], "!": 3, Z: 2, é: 1 }),
	).rejects.toThrow();
	expect(key(1)).toBe(key());
	expect(request(1).body).toBe(request().body);
});

it("refuses to send when durable storage fails", async () => {
	const broken = {
		getItem: () => null,
		setItem: () => {
			throw new Error("quota");
		},
		removeItem: vi.fn(),
	};
	await expect(
		createSubmissionClient(scope, { storage: broken, send }).submit(body),
	).rejects.toThrow();
	expect(send).not.toHaveBeenCalled();
});

it("returns confirmed success even when receipt cleanup fails", async () => {
	const storage = {
		getItem: sessionStorage.getItem.bind(sessionStorage),
		setItem: sessionStorage.setItem.bind(sessionStorage),
		removeItem: () => {
			throw new Error("storage blocked");
		},
	};
	send.mockResolvedValue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	await expect(
		createSubmissionClient(scope, { storage, send }).submit(body),
	).resolves.toEqual({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	await createSubmissionClient(scope, { storage, send }).submit(body);
	expect(key(1)).toBe(key());
});

it.each([
	null,
	undefined,
	{},
	{ id: "" },
	{ id: "not-uuid" },
	{ id: " " },
])("retains the retry key for an incomplete successful response %j", async (response) => {
	send.mockResolvedValueOnce(response);
	await expect(client().submit(body)).rejects.toThrow("response");
	send.mockResolvedValueOnce({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3" });
	await expect(client().submit(body)).resolves.toEqual({
		id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
	});
	expect(key(1)).toBe(key());
});

it("never sends before the pending receipt is durably written", async () => {
	let writes = 0;
	const storage = {
		getItem: sessionStorage.getItem.bind(sessionStorage),
		setItem: (name: string, value: string) => {
			if (++writes === 2) throw new Error("quota");
			sessionStorage.setItem(name, value);
		},
		removeItem: sessionStorage.removeItem.bind(sessionStorage),
	};
	await expect(
		createSubmissionClient(scope, { storage, send }).submit(body),
	).rejects.toThrow("storage");
	expect(send).not.toHaveBeenCalled();
});

it("snapshots nested request values before an asynchronous digest can observe edits", async () => {
	let release!: () => void;
	let first = true;
	vi.stubGlobal("crypto", {
		randomUUID: () => webcrypto.randomUUID(),
		subtle: {
			digest: async (algorithm: string, data: Uint8Array) => {
				if (first) {
					first = false;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				return webcrypto.subtle.digest(algorithm, data);
			},
		},
	});
	const edited = { plan: { name: "Before" } };
	const pending = client().submit(edited, (_seed, snapshot) => snapshot);
	edited.plan.name = "After";
	release();
	await expect(pending).rejects.toThrow();
	expect(JSON.parse(request().body as string)).toEqual({
		plan: { name: "Before" },
	});
});

it("does not let an older completion erase a newer pending generation", async () => {
	let completeOld!: (value: unknown) => void;
	send.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				completeOld = resolve;
			}),
	);
	const old = client().submit(body);
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	send.mockResolvedValueOnce({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2" });
	await client().submit({ ...body, name: "edited" });
	const newer = { ...body, name: "newer" };
	await expect(client().submit(newer)).rejects.toThrow();
	const newerKey = key(2);
	completeOld({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4" });
	await old;
	await expect(client().submit(newer)).rejects.toThrow();
	expect(key(3)).toBe(newerKey);
});

it("retains the visible form seed while an older request is unresolved, then renews it after all confirmations", async () => {
	const originalSeed = client().getSeed();
	await expect(client().submit(body)).rejects.toThrow("response lost");
	const originalKey = key();
	send.mockResolvedValueOnce({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2" });
	await client().submit({ ...body, name: "edited" });
	expect(client().getSeed()).toEqual(originalSeed);
	await expect(client().submit(body)).rejects.toThrow("response lost");
	expect(key(2)).toBe(originalKey);
	send.mockResolvedValueOnce({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	await client().submit(body);
	expect(client().getSeed().nonce).not.toBe(originalSeed.nonce);
});

it("retains the form seed when another intent is hashing during a successful completion", async () => {
	const originalSeed = client().getSeed();
	let releaseHash!: () => void;
	vi.stubGlobal("crypto", {
		randomUUID: () => webcrypto.randomUUID(),
		subtle: {
			digest: async (algorithm: string, data: Uint8Array) => {
				if (new TextDecoder().decode(data).includes('"name":"B"'))
					await new Promise<void>((resolve) => {
						releaseHash = resolve;
					});
				return webcrypto.subtle.digest(algorithm, data);
			},
		},
	});
	let completeA!: (value: unknown) => void;
	send.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				completeA = resolve;
			}),
	);
	const first = client().submit({ name: "A" });
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	const second = client().submit({ name: "B" });
	expect(releaseHash).toBeTypeOf("function");
	completeA({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	await first;
	expect(client().getSeed()).toEqual(originalSeed);
	releaseHash();
	await expect(second).rejects.toThrow("response lost");
	expect(client().getSeed()).toEqual(originalSeed);
});

it("renews the form seed once concurrent different intents are both confirmed", async () => {
	const originalSeed = client().getSeed();
	send.mockResolvedValue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	await Promise.all([
		client().submit({ name: "A" }),
		client().submit({ name: "B" }),
	]);
	expect(client().getSeed().nonce).not.toBe(originalSeed.nonce);
	await client().submit({ name: "A" });
	expect(key(2)).not.toBe(key());
});

it("renews an orphan operation while keeping a mounted form's seed through retry and reload", async () => {
	const originalSeed = client().getSeed();
	let rejectHash!: (error: Error) => void;
	vi.stubGlobal("crypto", {
		randomUUID: () => webcrypto.randomUUID(),
		subtle: {
			digest: async (algorithm: string, data: Uint8Array) => {
				if (new TextDecoder().decode(data).includes('"name":"B"'))
					await new Promise<void>((_resolve, reject) => {
						rejectHash = reject;
					});
				return webcrypto.subtle.digest(algorithm, data);
			},
		},
	});
	let completeA!: (value: unknown) => void;
	send.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				completeA = resolve;
			}),
	);
	const first = client().submit({ name: "A" });
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	const second = client().submit({ name: "B" });
	const failed = expect(second).rejects.toThrow("digest unavailable");
	completeA({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" });
	await first;
	rejectHash(new Error("digest unavailable"));
	await failed;
	expect(send).toHaveBeenCalledTimes(1);
	vi.stubGlobal("crypto", webcrypto);
	const intent = (seed: typeof originalSeed) => ({
		name: seed.nonce,
		renderedAt: seed.createdAt,
	});
	// The mounted form still displays its original generated name and date.
	await expect(client().submit(intent(originalSeed))).rejects.toThrow(
		"response lost",
	);
	const reloadedSeed = client().getSeed();
	expect(reloadedSeed).toEqual(originalSeed);
	await expect(client().submit(intent(reloadedSeed))).rejects.toThrow(
		"response lost",
	);
	expect(key(1)).not.toBe(key());
	expect(key(2)).toBe(key(1));
	expect(request(2).body).toBe(request(1).body);
});

it("refuses new intent at the pending limit while keeping existing retries usable", async () => {
	for (let index = 0; index < 100; index += 1)
		await expect(client().submit({ name: index })).rejects.toThrow(
			"response lost",
		);
	await expect(client().submit({ name: 100 })).rejects.toThrow("pendingLimit");
	expect(send).toHaveBeenCalledTimes(100);
	await expect(client().submit({ name: 0 })).rejects.toThrow("response lost");
	expect(key(100)).toBe(key());
});

it("preserves special own-property names in the exact wire snapshot", async () => {
	const input = JSON.parse(
		'{"__proto__":{"name":"safe"},"constructor":"also safe","toString":"value"}',
	);
	await expect(client().submit(input)).rejects.toThrow();
	expect(JSON.parse(request().body as string)).toEqual(input);
	expect(Object.prototype).not.toHaveProperty("name");
});
