#!/usr/bin/env node
/**
 * Export the shared offline Encoding-operation census as UTF-8 CSV.
 * Source-confirmed calls are not proof of GUI coverage or provider success.
 * Run: node scripts/api-coverage.mjs [outfile.csv]
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCensus } from "./api-coverage-current.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

export function renderCoverageCsv(census) {
	const { provenance, summary } = census;
	const rows = [
		["Bitmovin Encoding API source census"],
		["SDK version", provenance.sdkVersion],
		["Generated at", provenance.generatedAt],
		["Scope", provenance.scope],
		["Census method", provenance.method],
		["Source commit", provenance.sourceCommit],
		["Source fingerprint", provenance.sourceFingerprint],
		["SDK fingerprint", provenance.sdkFingerprint],
		["Total operations", summary.totalOperations],
		["Source-confirmed operations", summary.sourceConfirmed],
		["Unconfirmed operations", summary.unconfirmed],
		["Source evidence does not establish GUI field coverage, successful provider calls or playback."],
		[],
		["HTTP method", "Path", "SDK method", "Family", "Source status", "Source evidence"],
		...census.endpoints.map((row) => [
			row.httpVerb,
			row.path,
			row.sdkMethod,
			row.family,
			row.status,
			row.evidence.map((entry) => `${entry.file}:${entry.line}`).join("; "),
		]),
	];
	// A BOM keeps Excel from treating UTF-8 source references as a legacy encoding.
	return `\uFEFF${rows.map((row) => row.map(quote).join(",")).join("\r\n")}\r\n`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length > 3) throw new Error("Usage: node scripts/api-coverage.mjs [outfile.csv]");
	const census = generateCensus();
	const output = resolve(process.argv[2] ?? join(root, "verify-runs/api-coverage-latest.csv"));
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, renderCoverageCsv(census));
	console.log(`SDK ${census.provenance.sdkVersion}: ${census.summary.sourceConfirmed}/${census.summary.totalOperations} source-confirmed operations; wrote ${output}`);
}
