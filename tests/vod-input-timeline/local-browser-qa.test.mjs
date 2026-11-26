import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions, requestAllowed } from "./local-browser-qa.mjs";

test("local browser QA refuses non-owned origins and never permits encoding or settings writes", () => {
	for (const url of ["https://example.com", "http://localhost:3192", "http://127.0.0.1:3000", "http://127.0.0.1:3192/private"])
		assert.throws(() => parseOptions(["--base-url", url]));
	const origin = parseOptions([]).baseURL;
	assert.equal(requestAllowed(`${origin}/api/credentials`, "GET", origin), true);
	assert.equal(requestAllowed(`${origin}/api/vod/input-previews`, "POST", origin), true);
	assert.equal(requestAllowed(`${origin}/api/vod/input-previews/10000000-0000-4000-8000-000000000001`, "DELETE", origin), true);
	for (const path of ["/api/encoding-jobs", "/api/live-channels", "/api/settings", "/api/credentials"])
		assert.equal(requestAllowed(`${origin}${path}`, "POST", origin), false);
	assert.equal(requestAllowed("https://example.com/test", "GET", origin), false);
});
