import { z } from "zod";
import { apiFetch } from "./api";
import {
	CREATE_REQUEST_DIGEST_HEADER,
	CREATE_REQUEST_NOT_FOUND,
	canonicalCreateRequestJson,
	creationErrorCode,
} from "./creation-submission-contract";

type SubmissionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type CreationSeed = { createdAt: number; nonce: string };
export type CreationBody = (seed: CreationSeed, snapshot: unknown) => unknown;
export type CreationCompatibility = {
	legacy?: {
		intent: unknown;
		request(seed: CreationSeed): {
			body: unknown;
			replayOnly: boolean;
			restoredNameBody?: unknown;
		};
		lookupWithheldPreset?: boolean;
	};
};
export class CreationSubmissionError extends Error {
	constructor(
		readonly reason: "storage" | "pendingLimit" | "response" | "legacyReceipt",
	) {
		super(reason);
	}
}

const baseSchema = z.object({ id: z.uuid(), createdAt: z.number().finite() });
const pendingSchema = baseSchema.extend({
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	nonce: z.string().regex(/^[a-f0-9]{32}$/),
	requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
	format: z.literal("effective-template").optional(),
});
const stateSchema = z.object({
	version: z.literal(1),
	base: baseSchema.optional(),
	formSeed: baseSchema.optional(),
	pending: z.array(pendingSchema).max(100),
});
type SubmissionState = z.infer<typeof stateSchema>;
type PendingCreation = z.infer<typeof pendingSchema>;
const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>();

function canonicalJson(value: unknown): string {
	const normalized: unknown = JSON.parse(JSON.stringify(value));
	const sort = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(sort);
		if (node !== null && typeof node === "object")
			return Object.fromEntries(
				Object.entries(node)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, entry]) => [key, sort(entry)]),
			);
		return node;
	};
	return JSON.stringify(sort(normalized));
}

async function sha256(value: string) {
	const bytes = new TextEncoder().encode(value);
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Persist only request digests and random seed metadata, never plans or credentials.
 * Each browser tab owns its session storage; independent tabs create independent intents.
 */
export function createSubmissionClient(
	scope: readonly string[],
	{
		storage,
		send = apiFetch,
		beforeSend,
		headers = {},
	}: {
		storage: SubmissionStorage;
		send?: (path: string, init: RequestInit) => Promise<unknown>;
		beforeSend?: () => void;
		headers?: Record<string, string>;
	},
) {
	const storageKey = `bitovp.creation-intent:${JSON.stringify(scope)}`;
	const endpoint =
		scope[2] === "live" ? "/api/live-channels" : "/api/encoding-jobs";
	function read(): SubmissionState {
		try {
			const saved = storage.getItem(storageKey);
			return saved === null
				? { version: 1, pending: [] }
				: stateSchema.parse(JSON.parse(saved));
		} catch {
			// A damaged receipt cannot safely be replaced with a new request key.
			throw new CreationSubmissionError("storage");
		}
	}
	function write(state: SubmissionState) {
		try {
			storage.setItem(storageKey, JSON.stringify(state));
		} catch {
			throw new CreationSubmissionError("storage");
		}
	}
	async function sendRequest(
		receipt: PendingCreation,
		body: unknown,
		replayOnly = false,
	) {
		const digest = replayOnly
			? await sha256(canonicalCreateRequestJson(body))
			: undefined;
		beforeSend?.();
		return send(endpoint, {
			method: replayOnly ? "GET" : "POST",
			headers: {
				...headers,
				"Idempotency-Key": receipt.requestKey,
				...(digest && { [CREATE_REQUEST_DIGEST_HEADER]: digest }),
			},
			...(replayOnly ? { cache: "no-store" } : { body: JSON.stringify(body) }),
		});
	}
	return {
		getSeed(): CreationSeed {
			const state = read();
			if (!state.formSeed) {
				const source = state.pending[0] ??
					state.base ?? { id: crypto.randomUUID(), createdAt: Date.now() };
				state.formSeed = { id: source.id, createdAt: source.createdAt };
				if (!state.base && state.pending.length === 0)
					state.base = state.formSeed;
				write(state);
			}
			return {
				createdAt: state.formSeed.createdAt,
				nonce: state.formSeed.id.replaceAll("-", ""),
			};
		},
		submit<T>(
			intent: unknown,
			buildBody?: CreationBody,
			compatibility?: CreationCompatibility,
		): Promise<T> {
			try {
				const serialized = canonicalJson(intent);
				const flightKey = `${storageKey}:${serialized}`;
				let flights = inFlight.get(storage);
				if (!flights) {
					flights = new Map();
					inFlight.set(storage, flights);
				}
				const active = flights.get(flightKey);
				if (active) return active as Promise<T>;
				const initial = read();
				if (!initial.base) {
					initial.base = { id: crypto.randomUUID(), createdAt: Date.now() };
					write(initial);
				}
				const base = initial.base;
				const operation = (async () => {
					const digest = await sha256(serialized);
					let current = read();
					let pending = current.pending.find(
						(entry) => entry.digest === digest,
					);
					let build = buildBody;
					let replayOnly = false;
					let result: unknown;
					let foundReplay = false;
					const older = current.pending.filter((entry) => !entry.format);
					const legacy = compatibility?.legacy;
					if (!pending && legacy && older.length) {
						const legacyDigest = await sha256(canonicalJson(legacy.intent));
						pending = older.find((entry) => entry.digest === legacyDigest);
						if (pending) {
							const request = legacy.request(pending);
							build = () => request.body;
							replayOnly = request.replayOnly;
						} else if (legacy.lookupWithheldPreset) {
							// A newly protected template can no longer recreate its
							// old intent digest. Compare its reconstructed wire body
							// with admitted requests without starting any provider work.
							for (const receipt of older) {
								const { body, restoredNameBody } = legacy.request(receipt);
								const candidates =
									restoredNameBody === undefined
										? [body]
										: [body, restoredNameBody];
								for (const candidate of candidates) {
									try {
										result = await sendRequest(receipt, candidate, true);
										pending = receipt;
										foundReplay = true;
										break;
									} catch (error) {
										const code = creationErrorCode(error);
										if (
											code !== CREATE_REQUEST_NOT_FOUND &&
											code !== "CREATE_REQUEST_CONFLICT"
										)
											throw error;
									}
								}
								if (foundReplay) break;
							}
							// A different stored digest can be an effect of projection,
							// not proof that the operator initiated a new request.
							if (!foundReplay)
								throw new CreationSubmissionError("legacyReceipt");
						}
					}
					if (!pending) {
						if (current.pending.length >= 100)
							throw new CreationSubmissionError("pendingLimit");
						const requestKey = await sha256(`${base.id}:${digest}`);
						const nonce = requestKey.slice(0, 32);
						// Other intents can finish hashing while this one derives its seed.
						current = read();
						pending = current.pending.find((entry) => entry.digest === digest);
						if (!pending) {
							if (current.pending.length >= 100)
								throw new CreationSubmissionError("pendingLimit");
							pending = {
								...base,
								digest,
								requestKey,
								nonce,
								...(compatibility && { format: "effective-template" as const }),
							};
							write({ ...current, pending: [...current.pending, pending] });
						}
					}
					if (!foundReplay) {
						const payload = build
							? build(pending, JSON.parse(serialized))
							: JSON.parse(serialized);
						try {
							result = await sendRequest(pending, payload, replayOnly);
						} catch (error) {
							if (
								replayOnly &&
								creationErrorCode(error) === CREATE_REQUEST_NOT_FOUND
							)
								throw new CreationSubmissionError("response");
							throw error;
						}
					}
					if (!z.object({ id: z.uuid() }).safeParse(result).success)
						throw new CreationSubmissionError("response");
					flights.delete(flightKey);
					const anotherActive = [...flights.keys()].some((key) =>
						key.startsWith(`${storageKey}:`),
					);
					try {
						const latest = read();
						latest.pending = latest.pending.filter(
							(entry) =>
								entry.digest !== pending.digest ||
								entry.requestKey !== pending.requestKey,
						);
						if (!anotherActive && latest.base?.id === pending.id)
							delete latest.base;
						if (!anotherActive && latest.pending.length === 0)
							delete latest.formSeed;
						if (latest.pending.length === 0 && !latest.base)
							storage.removeItem(storageKey);
						else write(latest);
					} catch {
						// The create is confirmed. Keep the old receipt for a safe replay if cleanup fails.
					}
					return result as T;
				})();
				flights.set(flightKey, operation);
				void operation
					.finally(() => {
						if (flights.get(flightKey) === operation) flights.delete(flightKey);
						if (
							![...flights.keys()].some((key) =>
								key.startsWith(`${storageKey}:`),
							)
						) {
							try {
								const latest = read();
								if (
									latest.pending.length === 0 &&
									latest.base?.id === base.id
								) {
									delete latest.base;
									// A mounted template still displays this form's generated name.
									if (latest.formSeed) write(latest);
									else storage.removeItem(storageKey);
								}
							} catch {
								// Pending request metadata remains intact when browser storage is unavailable.
							}
						}
					})
					.catch(() => {});
				return operation;
			} catch (error) {
				return Promise.reject(error);
			}
		},
	};
}
