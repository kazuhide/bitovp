import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
	ClientSecretCredential,
	type ClientSecretCredentialOptions,
} from "@azure/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IdentityHttpClient = NonNullable<
	ClientSecretCredentialOptions["httpClient"]
>;
const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const SECRET = "synthetic-client-secret";
const SCOPE = "https://batch.core.windows.net/.default";
// A synthetic authority forces discovery instead of MSAL's bundled cloud metadata.
const AUTHORITY_HOST = "https://identity.example";
const AUTHORITY = `${AUTHORITY_HOST}/${TENANT}`;
const TOKEN = "synthetic-access-token";
const nativeTransport = vi.fn(() => {
	throw new Error("Native network access is forbidden in this test");
});

beforeEach(() => {
	vi.stubGlobal("fetch", nativeTransport);
	vi.spyOn(http, "request").mockImplementation(nativeTransport);
	vi.spyOn(https, "request").mockImplementation(nativeTransport);
	vi.spyOn(net.Socket.prototype, "connect").mockImplementation(nativeTransport);
});

afterEach(() => {
	try {
		expect(nativeTransport).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		nativeTransport.mockClear();
	}
});

function localIdentity(fail = false) {
	const requests: { method: string; path: string; body: URLSearchParams }[] =
		[];
	const httpClient: IdentityHttpClient = {
		async sendRequest(request) {
			const url = new URL(request.url);
			expect(url.origin).toBe(AUTHORITY_HOST);
			requests.push({
				method: request.method,
				path: url.pathname,
				body: new URLSearchParams(String(request.body ?? "")),
			});
			let status = 200;
			let body: Record<string, unknown>;
			if (
				request.method === "GET" &&
				url.pathname === `/${TENANT}/v2.0/.well-known/openid-configuration`
			) {
				body = {
					authorization_endpoint: `${AUTHORITY}/oauth2/v2.0/authorize`,
					token_endpoint: `${AUTHORITY}/oauth2/v2.0/token`,
					end_session_endpoint: `${AUTHORITY}/oauth2/v2.0/logout`,
					issuer: `${AUTHORITY}/v2.0`,
					jwks_uri: `${AUTHORITY}/discovery/v2.0/keys`,
				};
			} else if (
				request.method === "POST" &&
				url.pathname === `/${TENANT}/oauth2/v2.0/token`
			) {
				if (fail) {
					status = 400;
					body = {
						error: "invalid_client",
						error_description: "Synthetic client credential rejected",
					};
				} else {
					body = {
						token_type: "Bearer",
						access_token: TOKEN,
						expires_in: 3600,
						ext_expires_in: 3600,
						scope: SCOPE,
					};
				}
			} else {
				throw new Error("Unexpected identity request");
			}
			return {
				request,
				status,
				headers: request.headers,
				bodyAsText: JSON.stringify(body),
			};
		},
	};
	return {
		requests,
		credential: new ClientSecretCredential(TENANT, CLIENT, SECRET, {
			httpClient,
			authorityHost: AUTHORITY_HOST,
			disableInstanceDiscovery: true,
			retryOptions: { maxRetries: 0 },
		}),
	};
}

describe("installed Azure Identity and MSAL interoperability", () => {
	it("acquires a client-secret token through the injected transport", async () => {
		const { credential, requests } = localIdentity();
		const before = Date.now();
		const token = await credential.getToken(SCOPE);
		expect(token.token).toBe(TOKEN);
		expect(token.expiresOnTimestamp).toBeGreaterThan(before + 3_500_000);
		expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
			{
				method: "GET",
				path: `/${TENANT}/v2.0/.well-known/openid-configuration`,
			},
			{ method: "POST", path: `/${TENANT}/oauth2/v2.0/token` },
		]);
		const form = requests.find((request) => request.method === "POST")?.body;
		expect(form?.get("grant_type")).toBe("client_credentials");
		expect(form?.get("client_id")).toBe(CLIENT);
		expect(form?.get("client_secret")).toBe(SECRET);
		expect(form?.get("scope")).toContain(
			"https://batch.core.windows.net/.default",
		);
		expect(form?.get("x-client-VER")).toBe("7.1.1");
	});

	it("reuses the in-memory token without another token request", async () => {
		const { credential, requests } = localIdentity();
		const first = await credential.getToken(SCOPE);
		const second = await credential.getToken(SCOPE);
		expect(second.token).toBe(first.token);
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
	});

	it("propagates a rejected client credential without a fallback network call", async () => {
		const { credential, requests } = localIdentity(true);
		await expect(credential.getToken(SCOPE)).rejects.toThrow(/invalid_client/);
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
	});
});
