import { z } from "zod";
import { apiFetch } from "./api";

type SubmissionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type CreationSeed = { createdAt: number; nonce: string };
export type CreationBody = (seed: CreationSeed, snapshot: unknown) => unknown;
export class CreationSubmissionError extends Error {
	constructor(readonly reason: "storage" | "pendingLimit" | "response") {
		super(reason);
	}
}

const baseSchema = z.object({ id: z.uuid(), createdAt: z.number().finite() });
const pendingSchema = baseSchema.extend({
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	nonce: z.string().regex(/^[a-f0-9]{32}$/),
	requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
});
const stateSchema = z.object({
	version: z.literal(1),
	base: baseSchema.optional(),
	formSeed: baseSchema.optional(),
	pending: z.array(pendingSchema).max(100),
});
type SubmissionState = z.infer<typeof stateSchema>;
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
	}: {
		storage: SubmissionStorage;
		send?: (path: string, init: RequestInit) => Promise<unknown>;
		beforeSend?: () => void;
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
		submit<T>(intent: unknown, buildBody?: CreationBody): Promise<T> {
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
							pending = { ...base, digest, requestKey, nonce };
							write({ ...current, pending: [...current.pending, pending] });
						}
					}
					const payload = buildBody
						? buildBody(pending, JSON.parse(serialized))
						: JSON.parse(serialized);
					beforeSend?.();
					const result = await send(endpoint, {
						method: "POST",
						headers: { "Idempotency-Key": pending.requestKey },
						body: JSON.stringify(payload),
					});
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
								entry.digest !== digest ||
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
