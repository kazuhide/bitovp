#!/usr/bin/env node
/**
 * Approximate Bitmovin SDK endpoint coverage, exported as spreadsheet-ready CSV.
 *
 * Recorder replacements for SDK transport methods enumerate endpoint paths.
 * Source accessor chains and literal paths identify candidate application calls.
 * This measures endpoints, not request fields or runtime success. Dynamic calls
 * can be missed, and matching accessor suffixes can overcount. Custom metadata
 * operations are reported separately from the headline feature coverage.
 *
 * Run: node scripts/api-coverage.mjs [outfile.csv]
 */
import { createRequire } from "node:module";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const VERBS = ["get", "post", "put", "delete", "patch"];

async function sdkEndpoints() {
	// Resolved from the WORKER workspace: the SDK is a dependency of apps/*,
	// not of the repo root, so a bare specifier here finds nothing.
	const require = createRequire(join(repo, "apps/worker/package.json"));
	const entry = require.resolve("@bitmovin/api-sdk");
	const mod = await import(pathToFileURL(entry).href);
	const Ctor =
		typeof mod.default === "function" ? mod.default : mod.default?.default;
	if (typeof Ctor !== "function") {
		throw new Error(
			"@bitmovin/api-sdk default export is not a constructor — SDK packaging changed",
		);
	}
	const version = JSON.parse(
		readFileSync(require.resolve("@bitmovin/api-sdk/package.json"), "utf8"),
	).version;
	const api = new Ctor({ apiKey: "00000000-0000-0000-0000-000000000000" });

	let current = null;
	const found = new Map();
	const patched = new Set();
	function install(client) {
		if (patched.has(client)) {
			return;
		}
		patched.add(client);
		const proto = Object.getPrototypeOf(client);
		for (const verb of VERBS) {
			if (typeof proto?.[verb] !== "function") {
				continue;
			}
			client[verb] = (path) => {
				if (current && typeof path === "string" && !found.has(path)) {
					found.set(path, { path, verb, chain: current });
				}
				// Never settles: the SDK's own `.then` chains stay pending and
				// nothing throws back into the walk.
				return new Promise(() => {});
			};
		}
	}

	const visited = new Set();
	const queue = [{ node: api, chain: "" }];
	while (queue.length > 0) {
		const { node, chain } = queue.shift();
		if (!node || typeof node !== "object" || visited.has(node)) {
			continue;
		}
		visited.add(node);
		if (node.restClient) {
			install(node.restClient);
		}
		const proto = Object.getPrototypeOf(node);
		for (const name of proto ? Object.getOwnPropertyNames(proto) : []) {
			if (name === "constructor" || typeof node[name] !== "function") {
				continue;
			}
			current = chain ? `${chain}.${name}` : name;
			try {
				// Ten placeholders covers every signature in the SDK; JS ignores
				// extras. The path is built before any transport work, so the
				// recorder fires even though nothing is sent.
				node[name]("id", "id", "id", "id", "id", "id", "id", "id", "id", "id");
			} catch {
				// A method that throws before building its path contributes
				// nothing; the walk continues rather than dying on one node.
			}
			current = null;
		}
		for (const key of Object.keys(node)) {
			if (key === "restClient") {
				continue;
			}
			const child = node[key];
			if (child && typeof child === "object") {
				queue.push({ node: child, chain: chain ? `${chain}.${key}` : key });
			}
		}
	}
	if (found.size < 300) {
		throw new Error(
			`walked the SDK and found only ${found.size} endpoints — the graph shape changed and this would report a fictional denominator`,
		);
	}
	return { version, endpoints: [...found.values()] };
}

/** Every non-test source file across the workspaces. */
function sourceFiles() {
	const roots = [
		"apps/web/src",
		"apps/worker/src",
		"apps/worker/scripts",
		"packages/core/src",
		"packages/db/src",
		"packages/storage/src",
	].map((r) => join(repo, r));
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (entry !== "__fixtures__" && entry !== "node_modules") {
					walk(full);
				}
			} else if (
				/\.(ts|tsx|mjs)$/.test(entry) &&
				!entry.includes(".test.") &&
				!entry.endsWith(".d.ts")
			) {
				out.push(full);
			}
		}
	};
	for (const r of roots) {
		try {
			walk(r);
		} catch {
			// A workspace without that directory is not an error.
		}
	}
	return out;
}

function main(version, endpoints, files) {
	/**
	 * Does the repo call this endpoint?
	 *
	 * Matched PER FILE, and the product root must appear in the same file.
	 *
	 * The first cut matched a two-segment chain tail against one concatenated
	 * corpus, and over-counted exactly as a reviewer predicted: the SDK's
	 * analytics tree mirrors the encoding tree, so `analytics.outputs.azure
	 * .create` matched the worker's `api.encoding.outputs.azure.create(` and
	 * five analytics endpoints — plus `streams.video.create` and
	 * `notifications.list` — were reported as shipped. This app touches none of
	 * them.
	 *
	 * Two segments is still the tail length, because call sites hold
	 * intermediates in variables (`const m = muxings; m.fmp4.drm.cenc.list`)
	 * and a longer suffix would under-count. What removes the ambiguity is the
	 * product: an analytics call lives in a file that says `analytics`
	 * somewhere. Where the chain is short enough to spell whole, the whole
	 * chain is required.
	 */
	const used = (e) => {
		const parts = e.chain.split(".");
		const root = parts[0];
		const tail = parts.slice(-2).join(".");
		const whole = parts.length <= 3;
		for (const src of files) {
			if (!src.includes(root)) {
				continue;
			}
			// FULLY QUOTED, both ends. A bare substring test made
			// `/notifications` match this app's own `/settings/notifications`
			// route; anchoring only the start still matched a display label,
			// `"/notifications/webhooks/… (standard set)"`, because the short
			// path is a PREFIX of the long one. Short SDK paths are exactly the
			// ones a loose test ruins, and each loosening cost one wrong row.
			if (
				src.includes(`"${e.path}"`) ||
				src.includes(`'${e.path}'`) ||
				src.includes(`\`${e.path}\``)
			) {
				return true;
			}
			if (whole ? src.includes(`.${e.chain}(`) : src.includes(`.${tail}(`)) {
				return true;
			}
		}
		return false;
	};
	const rows = endpoints.map((e) => ({
		path: e.path,
		verb: e.verb.toUpperCase(),
		product: e.path.split("/")[1] ?? "?",
		chain: e.chain,
		customData: /customdata/i.test(e.path),
		used: used(e),
	}));

	const tally = (list) => ({
		total: list.length,
		used: list.filter((r) => r.used).length,
	});
	const pct = (a, b) => (b === 0 ? "0.0" : ((a / b) * 100).toFixed(1));
	const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

	const byProduct = new Map();
	for (const r of rows) {
		byProduct.set(r.product, [...(byProduct.get(r.product) ?? []), r]);
	}
	const feature = rows.filter((r) => !r.customData);
	const encFeature = feature.filter((r) => r.product === "encoding");

	const lines = [];
	lines.push(q(`Bitmovin API coverage - SDK ${version}`));
	lines.push(
		q(
			"Counts ENDPOINTS, not fields. Reaching POST /encoding/encodings says nothing about how many of its request fields the UI exposes. REQUIREMENTS section 7 promises field-level parity and is NOT measured here.",
		),
	);
	lines.push(
		q(
			"Denominator: every path the SDK calls, recorded at runtime while walking its API graph. Numerator: the repo names the endpoint's accessor chain or its literal path.",
		),
	);
	lines.push(
		q(
			"Approximate in both directions. A dynamically assembled call matches neither route (undercount); a two-segment chain tail can still collide within one product (overcount). Matching is per file and requires the product root in the same file, which is what stops the SDK analytics tree from matching encoding call sites.",
		),
	);
	lines.push(q("Generated by scripts/api-coverage.mjs - do not hand-edit."));
	lines.push("");
	lines.push(q("HEADLINE - encoding endpoints excluding customData metadata"));
	lines.push(["slice", "endpoints", "used", "coverage %"].map(q).join(","));
	const et = tally(encFeature);
	lines.push(
		["encoding, features only", et.total, et.used, pct(et.used, et.total)]
			.map(q)
			.join(","),
	);
	const ft = tally(feature);
	const mt = tally(rows.filter((r) => r.customData));
	lines.push(
		["all products, features only", ft.total, ft.used, pct(ft.used, ft.total)]
			.map(q)
			.join(","),
	);
	lines.push(
		[
			"customData metadata endpoints",
			mt.total,
			mt.used,
			pct(mt.used, mt.total),
		]
			.map(q)
			.join(","),
	);
	lines.push("");
	lines.push(q("by product, everything included"));
	lines.push(["product", "endpoints", "used", "coverage %"].map(q).join(","));
	for (const [product, list] of [...byProduct].sort()) {
		const t = tally(list);
		lines.push(
			[product, t.total, t.used, pct(t.used, t.total)].map(q).join(","),
		);
	}
	const all = tally(rows);
	lines.push(
		["ALL PRODUCTS", all.total, all.used, pct(all.used, all.total)]
			.map(q)
			.join(","),
	);
	lines.push("");
	lines.push(
		["path", "verb", "product", "accessor chain", "used by this app"]
			.map(q)
			.join(","),
	);
	for (const r of rows.sort((a, b) => a.path.localeCompare(b.path))) {
		lines.push(
			[r.path, r.verb, r.product, r.chain, r.used ? "yes" : "no"]
				.map(q)
				.join(","),
		);
	}

	const out =
		process.argv[2] ?? join(repo, "verify-runs/api-coverage-latest.csv");
	mkdirSync(dirname(out), { recursive: true });
	// BOM: Excel on a Japanese locale reads a BOM-less UTF-8 CSV as Shift-JIS
	// and mojibakes every non-ASCII cell.
	writeFileSync(out, `﻿${lines.join("\n")}\n`);

	for (const [product, list] of [...byProduct].sort()) {
		const t = tally(list);
		console.log(
			`${product.padEnd(20)} ${String(t.used).padStart(4)}/${String(t.total).padEnd(5)} ${pct(t.used, t.total)}%`,
		);
	}
	console.log(
		`${"ALL".padEnd(20)} ${String(all.used).padStart(4)}/${String(all.total).padEnd(5)} ${pct(all.used, all.total)}%`,
	);
	console.log(
		`${"encoding (features)".padEnd(20)} ${String(et.used).padStart(4)}/${String(et.total).padEnd(5)} ${pct(et.used, et.total)}%   <- the figure worth quoting`,
	);
	console.log(`\nSDK ${version} · wrote ${out}`);
}

const { version, endpoints } = await sdkEndpoints();
main(
	version,
	endpoints,
	sourceFiles().map((f) => readFileSync(f, "utf8")),
);
