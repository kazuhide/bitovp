import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Execute the generated route module with its actual Turbopack runtime and
// dependencies. Only the account store and outbound HTTP transport are synthetic.
// Run after `pnpm --filter @bitovp/web build`, with the pinned SDK installed.
const require = createRequire(import.meta.url);
const appRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
appRequire("next/dist/server/node-environment");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(repoRoot, "apps/web/.next");
const entry = "server/app/api/live/analyses/route.js";
const entrySource = await readFile(resolve(buildRoot, entry), "utf8");
const chunkPaths = Array.from(entrySource.matchAll(/R\.c\("([^"]+)"\)/g), (match) => match[1]);
assert.ok(chunkPaths.length > 0, "A Turbopack production route build is required");
const runtime = require(resolve(buildRoot, "server/chunks/[turbopack]_runtime.js"))(entry);
// Optional diagnostic input replays a previously saved broken route chunk.
const override = process.argv.find((argument) => argument.startsWith("--route-chunk="))?.slice("--route-chunk=".length);
const factories = [];
for (const path of chunkPaths) {
	const values = require(resolve(buildRoot, path));
	const isAisaRouteChunk = values.some((value) =>
		typeof value === "function" && value.toString().includes("AISA_LIVE_SDK_VERSION_MISMATCH"));
	runtime.c(isAisaRouteChunk && override
		? isAbsolute(override) ? override : resolve(repoRoot, override)
		: path);
	let ids = [];
	for (const value of values) {
		if (typeof value === "function") {
			factories.push({ ids, source: value.toString(), path });
			ids = [];
		} else {
			ids.push(value);
		}
	}
}

const contextFactories = factories.filter(({ source }) =>
	source.includes("bitmovinAccounts:") && source.includes(".isImpersonating"));
const routeFactories = factories.filter(({ source }) =>
	source.includes(".client.list("));
assert.equal(contextFactories.length, 1, "Find exactly one compiled server context");
assert.equal(routeFactories.length, 1, "Find exactly one compiled AISA route module");

const accountId = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const analysisId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const encodingId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const ownerId = "11111111-1111-4111-8111-111111111111";
const analysis = { analysisId, encodingId, name: "Synthetic built route", status: "CREATED" };
const accountReads = [];
const transportRequests = [];
const context = {
	tenant: {
		organizationId: "22222222-2222-4222-8222-222222222222",
		actorUserId: ownerId,
		effectiveUserId: ownerId,
		actor: `user:${ownerId}`,
		role: "ADMIN",
		actorRole: "ADMIN",
		isImpersonating: false,
	},
	bitmovinAccounts: {
		get: async (id) => {
			accountReads.push(id);
			assert.equal(id, accountId);
			return { tenantOrgId: "synthetic-tenant" };
		},
		revealApiKey: async (id) => {
			assert.equal(id, accountId);
			return "synthetic-key";
		},
	},
};
const contextModule = runtime.m(contextFactories[0].ids[0]);
const realContextExports = contextModule.namespaceObject ?? contextModule.exports;
const getContextKey = Object.keys(realContextExports).find((key) =>
	typeof realContextExports[key] === "function" && realContextExports[key].toString().includes(".isImpersonating"));
assert.ok(getContextKey, "Find the compiled authenticated-context getter");
const injectedContextExports = { ...realContextExports, [getContextKey]: async () => context };
contextModule.exports = injectedContextExports;
contextModule.namespaceObject = injectedContextExports;

const originalFetch = globalThis.fetch;
const originalFlag = process.env.BITOVP_AISA_LIVE_PREVIEW;
const originalOwnerId = process.env.BITOVP_AISA_LIVE_PREVIEW_USER_ID;
const sdkPath = process.env.BITOVP_AISA_LIVE_SDK_PATH;
process.env.BITOVP_AISA_LIVE_PREVIEW = "true";
process.env.BITOVP_AISA_LIVE_PREVIEW_USER_ID = ownerId;
globalThis.fetch = async (url, init) => {
	const parsed = new URL(String(url));
	assert.equal(parsed.origin, "https://api.bitmovin.com");
	assert.equal(init.method, "GET");
	assert.equal(init.redirect, "error");
	assert.equal(init.cache, "no-store");
	const headers = new Headers(init.headers);
	assert.equal(headers.get("X-Api-Key"), "synthetic-key");
	assert.equal(headers.get("X-Tenant-Org-Id"), "synthetic-tenant");
	assert.equal(headers.get("X-Api-Client-Version"), "1.288.0-develop.02b690c6");
	transportRequests.push(parsed.pathname);
	const path = "/v1/ai-scene-analysis/live-analyses";
	if (parsed.pathname === path) {
		return Response.json({ data: { result: { items: [analysis], totalCount: 1, offset: 0, limit: 25 } } });
	}
	assert.equal(parsed.pathname, `${path}/${analysisId}`);
	return Response.json({ data: { result: analysis } });
};

try {
	const module = runtime.m(routeFactories[0].ids[0]);
	const exports = module.namespaceObject ?? module.exports;
	const functions = Object.values(exports).filter((value) => typeof value === "function");
	const list = functions.find((value) => value.toString().includes(".client.list("));
	const get = functions.find((value) => {
		const source = value.toString();
		return source.includes(".client.get(") && !source.includes(".client.latest(") && !source.includes('"RUNNING"');
	});
	assert.equal(typeof list, "function", "Find the compiled list handler");
	assert.equal(typeof get, "function", "Find the compiled detail handler");
	const request = new Request(`http://fixture.invalid/api/live/analyses?bitmovinAccountId=${accountId}`);
	const listed = await list(request);
	const listBody = await listed.json();
	assert.equal(listed.status, 200, `Built list handler failed: ${JSON.stringify(listBody)}`);
	assert.deepEqual(listBody.items, [analysis]);
	const detailed = await get(request, analysisId);
	assert.equal(detailed.status, 200);
	assert.deepEqual(await detailed.json(), analysis);
	assert.equal(transportRequests.length, 2, "Both compiled handlers must reach the actual SDK transport");
	assert.equal(accountReads.length, 2);
	process.env.BITOVP_AISA_LIVE_PREVIEW = "false";
	assert.equal((await list(request)).status, 404, "A disabled feature must stay hidden");
	process.env.BITOVP_AISA_LIVE_PREVIEW = "true";
	context.tenant.effectiveUserId = encodingId;
	assert.equal((await list(request)).status, 404, "A delegated principal must not use the compiled handler");
	context.tenant.effectiveUserId = ownerId;
	assert.equal(accountReads.length, 2, "Denied requests must not read the account");
	assert.equal(transportRequests.length, 2, "Denied requests must not send requests");

	process.env.BITOVP_AISA_LIVE_SDK_PATH = resolve(repoRoot, ".synthetic-missing-aisa-sdk");
	const unavailable = await list(request);
	assert.equal(unavailable.status, 503);
	assert.equal((await unavailable.json()).details.code, "AISA_LIVE_SDK_UNAVAILABLE");
	assert.equal(transportRequests.length, 2, "An unavailable SDK must not send requests");
	console.log("PASS: compiled Turbopack list/detail handlers load the real pinned SDK from the runtime path; missing SDK returns 503. Synthetic account/HTTP only; no database or network.");
} finally {
	globalThis.fetch = originalFetch;
	if (originalFlag === undefined) delete process.env.BITOVP_AISA_LIVE_PREVIEW;
	else process.env.BITOVP_AISA_LIVE_PREVIEW = originalFlag;
	if (originalOwnerId === undefined) delete process.env.BITOVP_AISA_LIVE_PREVIEW_USER_ID;
	else process.env.BITOVP_AISA_LIVE_PREVIEW_USER_ID = originalOwnerId;
	if (sdkPath === undefined) delete process.env.BITOVP_AISA_LIVE_SDK_PATH;
	else process.env.BITOVP_AISA_LIVE_SDK_PATH = sdkPath;
}
