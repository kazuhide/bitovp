import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "./redact";

describe("redactSecrets", () => {
	it("masks sensitive keys at any depth", () => {
		const input = {
			name: "job-1",
			apiKey: "abc",
			nested: {
				secretAccessKey: "xyz",
				accessKeyId: "AKIA",
				region: "us-east-1",
				list: [{ password: "p" }, { ok: 1 }],
			},
		};
		expect(redactSecrets(input)).toEqual({
			name: "job-1",
			apiKey: REDACTED,
			nested: {
				secretAccessKey: REDACTED,
				accessKeyId: REDACTED,
				region: "us-east-1",
				list: [{ password: REDACTED }, { ok: 1 }],
			},
		});
	});

	it("covers real Bitmovin/storage secret shapes", () => {
		const input = {
			ask: "fairplay-app-secret",
			streamKey: "live-stream-key",
			srtPassphrase: "ten-chars-min",
			tokens: ["a", "b"],
			signature: "sig",
			license: "nagra-license-blob",
			nexguardLicense: "nagra-license-blob",
			// GCS service account: the wire/snapshot key (suffix `credential`) and
			// the raw vault field (`serviceAccountJson`, exact rule) both masked.
			serviceAccountCredentials: "{...private_key...}",
			serviceAccountJson: "{...private_key...}",
		};
		const out = redactSecrets(input);
		expect(out.ask).toBe(REDACTED);
		expect(out.streamKey).toBe(REDACTED);
		expect(out.srtPassphrase).toBe(REDACTED);
		expect(out.tokens).toBe(REDACTED);
		expect(out.signature).toBe(REDACTED);
		expect(out.license).toBe(REDACTED);
		expect(out.nexguardLicense).toBe(REDACTED);
		expect(out.serviceAccountCredentials).toBe(REDACTED);
		expect(out.serviceAccountJson).toBe(REDACTED);
	});

	it("leaves reference fields and resource names readable", () => {
		const input = {
			credentialId: "uuid-1",
			keyframes: [{ time: 1.0 }],
			task: "encode",
			mask: "0xff",
			licenseUrl: "https://example.com/license",
		};
		expect(redactSecrets(input)).toEqual(input);
	});

	it("masks passwords embedded in URLs", () => {
		const input = {
			url: "postgresql://bitovp:supersecret@db:5432/app",
			note: "see https://example.com/path",
		};
		const out = redactSecrets(input);
		expect(out.url).toBe(`postgresql://bitovp:${REDACTED}@db:5432/app`);
		expect(out.note).toBe("see https://example.com/path");
	});

	it("masks header tuples", () => {
		const headers = [
			["authorization", "Bearer token123"],
			["content-type", "application/json"],
		];
		expect(redactSecrets(headers)).toEqual([
			["authorization", REDACTED],
			["content-type", "application/json"],
		]);
	});

	it("still masks hyphenated secret header tuples (x-api-key style)", () => {
		expect(redactSecrets([["x-api-key", "abc123"]])).toEqual([
			["x-api-key", REDACTED],
		]);
	});

	it("does NOT mangle 2-element data arrays whose first item merely ends in a sensitive suffix", () => {
		// Encoding.labels are plain string lists — ["license", "prod"] is data,
		// not a header pair (P5 PR-2 review N2: the old rule corrupted step
		// logs and cURL exports). Bare words are only masked as OBJECT KEYS.
		expect(redactSecrets({ labels: ["license", "prod"] })).toEqual({
			labels: ["license", "prod"],
		});
		expect(redactSecrets(["token", "bucket-a"])).toEqual(["token", "bucket-a"]);
	});

	it("passes Date and binary values through", () => {
		const at = new Date("2026-06-11T00:00:00Z");
		const buf = new Uint8Array([1, 2, 3]);
		const out = redactSecrets({ at, buf });
		expect(out.at).toBe(at);
		expect(out.buf).toBe(buf);
	});

	it("does not mutate the input", () => {
		const input = { token: "t" };
		redactSecrets(input);
		expect(input.token).toBe("t");
	});

	it("passes primitives through", () => {
		expect(redactSecrets("plain")).toBe("plain");
		expect(redactSecrets(42)).toBe(42);
		expect(redactSecrets(null)).toBeNull();
	});

	it("keeps shared (non-circular) references intact", () => {
		const shared = { region: "eu" };
		const out = redactSecrets({ a: shared, b: shared });
		expect(out.a).toEqual({ region: "eu" });
		expect(out.b).toEqual({ region: "eu" });
	});

	it("handles circular references", () => {
		const input: Record<string, unknown> = { ok: 1 };
		input.self = input;
		expect(redactSecrets(input)).toEqual({ ok: 1, self: "[CIRCULAR]" });
	});
});

it("retains literal reserved object keys while redacting nested secrets", () => {
	const input = JSON.parse(
		'{"__proto__":{"apiKey":"secret","label":"kept"},"nested":{"__proto__":{"password":"secret","flag":false}}}',
	);
	const before = JSON.stringify(input);
	const result = redactSecrets(input);
	expect(Object.keys(result)).toContain("__proto__");
	expect(result).toEqual(
		JSON.parse(
			'{"__proto__":{"apiKey":"[REDACTED]","label":"kept"},"nested":{"__proto__":{"password":"[REDACTED]","flag":false}}}',
		),
	);
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
	expect(JSON.stringify(input)).toBe(before);
	expect(Object.hasOwn(Object.prototype, "label")).toBe(false);
});
