import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BROWSABLE_CREDENTIAL_PROVIDERS,
	CREDENTIAL_PROVIDER_BROWSABLE,
	type CredentialProviderId,
	FEEDER_SUPPORTED_PROVIDERS,
	SLATE_SUPPORTED_PROVIDERS,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { BROWSABLE_STORAGE_PROVIDERS } from "@/app/vod/new/stream-model";

/**
 * A `StoragePicker` may only offer credentials a driver can actually LIST.
 *
 * The watch-folder picker passed `CREDENTIAL_PROVIDERS` — every provider in the
 * vault. An operator could pick their Kantar login, or a DRM content key, as
 * the folder to sweep. Nothing refused it at the click: the rule saved, and
 * from then on every sweep tick threw `UnsupportedBrowseError` and backed the
 * rule off toward its 15-minute cap. A watch folder that ingests nothing, with
 * the reason buried in a worker log.
 *
 * Reading the five other callers is what let that one hide — they were all
 * correct, so the file I did not open was the one that mattered. This walks
 * them instead, in two layers that fail independently:
 *
 *   1. every `<StoragePicker>` passes a NAMED set, not an inline list
 *   2. every named set contains only browsable providers
 *
 * Neither alone is enough. (1) with an inline literal would let a caller smuggle
 * anything in; (2) alone would pass while a new caller ignores every set.
 */
const WEB_SRC = join(__dirname, "..");
const REPO = join(WEB_SRC, "../../..");

function sourceFiles(): { rel: string; text: string }[] {
	return execFileSync("git", ["ls-files", "--", "apps/web/src"], {
		cwd: REPO,
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
		.map((rel) => ({ rel, text: readFileSync(join(REPO, rel), "utf8") }));
}

/**
 * The sets a picker may draw from. Each is asserted browsable-only below, so
 * adding a name here without adding it to that assertion is not a way around
 * this file.
 */
const SANCTIONED: Record<string, readonly string[]> = {
	BROWSABLE_CREDENTIAL_PROVIDERS,
	BROWSABLE_STORAGE_PROVIDERS,
	FEEDER_SUPPORTED_PROVIDERS,
	SLATE_SUPPORTED_PROVIDERS,
	// launch-dialog narrows BROWSABLE_STORAGE_PROVIDERS by the template's own
	// input kind before passing it; the narrowing can only remove.
	pickerProviders: BROWSABLE_STORAGE_PROVIDERS,
};

describe("a storage picker only offers what a driver can list", () => {
	const files = sourceFiles();
	const callers = files.filter((f) => f.text.includes("<StoragePicker"));

	it("found the callers at all, so this cannot pass over an empty set", () => {
		// Six today. Below this and the walk broke, rather than the app being
		// clean — the exact way the previous instrument would have lied.
		expect(callers.length).toBeGreaterThanOrEqual(6);
	});

	it("passes a NAMED provider set, never an inline list", () => {
		const offenders: string[] = [];
		for (const { rel, text } of callers) {
			for (const match of text.matchAll(/providers=\{([^}]*)\}/g)) {
				const expr = (match[1] ?? "").trim();
				const ident = /^\[\.\.\.([A-Za-z_][\w]*)\]$|^([A-Za-z_][\w]*)$/.exec(
					expr,
				);
				const name = ident?.[1] ?? ident?.[2];
				if (!name || !(name in SANCTIONED)) {
					offenders.push(`${rel}: providers={${expr}}`);
				}
			}
		}
		expect(
			offenders,
			"pass one of the sanctioned sets — an inline list is how a " +
				"non-browsable provider gets offered as a folder to sweep",
		).toEqual([]);
	});

	it("every sanctioned set is browsable-only", () => {
		const bad: string[] = [];
		for (const [name, set] of Object.entries(SANCTIONED)) {
			for (const provider of set) {
				if (!CREDENTIAL_PROVIDER_BROWSABLE[provider as CredentialProviderId]) {
					bad.push(`${name} offers ${provider}, which no driver can list`);
				}
			}
		}
		expect(bad).toEqual([]);
	});

	it("the sets are not all empty, which would satisfy the line above vacuously", () => {
		for (const [name, set] of Object.entries(SANCTIONED)) {
			expect(set.length, `${name} is empty`).toBeGreaterThan(0);
		}
	});
});
