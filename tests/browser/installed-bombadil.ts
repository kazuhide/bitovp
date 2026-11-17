import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type BrowserContext,
	chromium,
	expect,
	type Page,
	type TestInfo,
} from "@playwright/test";
import {
	type InstalledWizardOracle,
	installedRows,
} from "../bombadil/installed-wizard-model";
import { nonpaidVodPlan } from "./nonpaid-submit";

const account = "33333333-3333-4333-8333-333333333333";
const credential = "44444444-4444-4444-8444-444444444444";
const root = resolve(import.meta.dirname, "../..");
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

async function prepareWizard(
	page: Page,
	fault: boolean,
	tripwire: string,
	progress: (step: string) => void,
) {
	progress("navigate");
	await page.goto("/vod/new");
	progress("import-plan");
	await page.getByRole("button", { name: /Import plan JSON/ }).click();
	await page
		.getByRole("textbox", { name: /Import plan JSON/ })
		.fill(JSON.stringify(nonpaidVodPlan(account, credential)));
	await page.getByRole("button", { name: /Validate.*load/i }).click();
	await expect(page.locator("#wz-name")).toHaveValue("Nonpaid VOD import");
	progress("ladder");
	await page
		.getByRole("navigation", { name: "Wizard steps" })
		.getByRole("button", { name: /^3\. Ladder$/ })
		.click();
	await expect(page.locator("#wz-v-0-height")).toBeVisible();
	progress("seed-rows");
	for (let index = 1; index < installedRows.length; index++)
		await page.getByRole("button", { name: "Add video", exact: true }).click();
	for (const [index, row] of installedRows.entries()) {
		await page.locator(`#wz-v-${index}-height`).fill(String(row.height));
		await page.locator(`#wz-v-${index}-bitrate`).fill(String(row.bitrate));
	}
	progress("plan-json");
	await page.getByRole("button", { name: "Plan JSON", exact: true }).click();
	await expect(page.getByTestId("plan-json")).toContainText('"renditions"');
	progress("oracle");
	await page.evaluate(
		({ rows, fault, tripwire }) => {
			(
				window as typeof window & { __bitovpWizard: InstalledWizardOracle }
			).__bitovpWizard = {
				rows,
				fault,
				tripwire,
				faults: 0,
				selected: null,
				guarded: null,
				counts: { edit: 0, select: 0, add: 0, remove: 0, revisit: 0 },
			};
		},
		{ rows: installedRows, fault, tripwire },
	);
}

export async function verifyInstalledBombadil(
	baseURL: string,
	storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
	info: TestInfo,
	directory: string,
) {
	let phase = "current";
	const annotation = {
		type: "bombadil-stage",
		description: "current:configuration",
	};
	info.annotations.push(annotation);
	const progress = (step: string, nextPhase = phase) => {
		phase = nextPhase;
		annotation.description = `${phase}:${step}`;
	};
	let classify: (error: unknown) => string = () => "unknown";
	let steps: string[] = [],
		categories: string[] = [];
	try {
		const {
			executeInstalledDriver,
			launchInstalledBrowser,
			installedBrowserConnection,
			installedFailureCategory,
			installedDiagnosticSteps,
			installedDiagnosticCategories,
		} = await import(
			pathToFileURL(join(root, "scripts/bombadil-installed.mjs")).href
		);
		classify = installedFailureCategory;
		steps = installedDiagnosticSteps;
		categories = installedDiagnosticCategories;
		const binary = process.env.BITOVP_BOMBADIL_BINARY;
		const output = process.env.BITOVP_BOMBADIL_OUTPUT;
		if (!binary || !output || !isAbsolute(binary) || !isAbsolute(output))
			throw new Error(
				"Installed Bombadil requires explicit verified binary and evidence paths",
			);
		await mkdir(output, { mode: 0o700 });
		let tripwireRequests = 0;
		const tripwire = createServer((_request, response) => {
			tripwireRequests++;
			response.writeHead(599).end();
		});
		await new Promise<void>((done) => tripwire.listen(0, "127.0.0.1", done));
		const address = tripwire.address();
		if (!address || typeof address === "string")
			throw new Error("Owned tripwire missing");
		const tripwireURL = `http://127.0.0.1:${address.port}/provider-tripwire`;
		const results = [];
		try {
			for (const stage of ["current", "negative", "replay"] as const) {
				const profile = await mkdtemp(join(directory, "bombadil-profile-"));
				let context: BrowserContext | undefined;
				let driverCleanupConfirmed = true;
				const counts = { blockedMutation: 0, blockedOtherOrigin: 0 };
				const unexpected: string[] = [];
				try {
					progress("browser-launch", stage);
					context = (await launchInstalledBrowser(
						profile,
						baseURL,
						chromium,
					)) as BrowserContext;
					progress("network-guard");
					await context.route("**/*", async (route) => {
						const request = route.request();
						const url = new URL(request.url());
						if (url.origin !== baseURL) {
							counts.blockedOtherOrigin++;
							if (url.href !== tripwireURL || request.method() !== "POST")
								unexpected.push("Unexpected external request");
							return route.abort();
						}
						if (!["GET", "HEAD"].includes(request.method())) {
							counts.blockedMutation++;
							if (
								url.pathname !== "/api/bombadil-guard" ||
								request.method() !== "POST"
							)
								unexpected.push("Unexpected installed mutation");
							return route.abort();
						}
						if (url.pathname === "/api/bitmovin-accounts")
							return route.fulfill({
								json: [{ id: account, label: "Synthetic account" }],
							});
						if (url.pathname === "/api/credentials")
							return route.fulfill({
								json: [
									{
										id: credential,
										label: "Synthetic storage",
										provider: "AWS_S3",
									},
								],
							});
						if (
							["/api/presets", "/api/delivery-presets"].includes(url.pathname)
						)
							return route.fulfill({ json: [] });
						if (
							!url.pathname.startsWith("/api/") ||
							[
								"/api/auth/session",
								"/api/settings/features",
								"/api/settings/branding",
							].includes(url.pathname)
						)
							return route.continue();
						unexpected.push(`Unexpected installed read: ${url.pathname}`);
						return route.abort();
					});
					await context.addCookies(storageState.cookies);
					await context.addCookies([
						{ name: "ovp-locale", value: "en", url: baseURL },
					]);
					expect(context.pages()).toHaveLength(1);
					const page = context.pages()[0];
					if (!page) throw new Error("Dedicated browser page missing");
					context.on("page", (other) => {
						unexpected.push("Unexpected page target");
						void other.close();
					});
					page.on("pageerror", () =>
						unexpected.push("Installed page exception"),
					);
					await prepareWizard(page, stage !== "current", tripwireURL, progress);
					progress("cdp");
					const { endpoint, browserVersion } = await installedBrowserConnection(
						context,
						profile,
						`${baseURL}/vod/new`,
					);
					const stageOutput = join(output, stage);
					progress("driver");
					driverCleanupConfirmed = false;
					try {
						await executeInstalledDriver(
							[
								`--binary=${binary}`,
								`--endpoint=${endpoint}`,
								`--origin=${baseURL}/vod/new`,
								`--output=${stageOutput}`,
								`--stage=${stage}`,
								...(stage === "replay"
									? [`--reproduce=${join(output, "negative/trace")}`]
									: []),
							],
							output,
							profile,
						);
						driverCleanupConfirmed = true;
					} catch (error) {
						driverCleanupConfirmed =
							(error as { cleanupConfirmed?: boolean }).cleanupConfirmed ===
							true;
						throw error;
					}
					progress("network-check");
					const result = JSON.parse(
						await readFile(join(stageOutput, "summary.json"), "utf8"),
					);
					expect(counts.blockedMutation).toBeGreaterThan(0);
					expect(counts.blockedOtherOrigin).toBeGreaterThan(0);
					expect(tripwireRequests).toBe(0);
					expect(unexpected).toEqual([]);
					expect(context.pages()).toHaveLength(1);
					results.push({
						...result,
						browserVersion,
						network: { ...counts, tripwireRequests },
					});
				} finally {
					try {
						await context?.close();
					} finally {
						if (driverCleanupConfirmed)
							await rm(profile, { recursive: true, force: true });
					}
				}
			}
			progress("summary");
			expect(results[2].violationNames).toEqual(results[1].violationNames);
			const summary = {
				status: "passed",
				tool: "Bombadil 0.7.10",
				source: "installed distributed archive",
				scope:
					"Authenticated installed VOD wizard; generated editing, selection, copying, removal and step navigation; independent visible and serialized values; injected action-routing fault and actual replay; no provider execution",
				browserSha256: digest(await readFile(chromium.executablePath())),
				modelSha256: digest(
					await readFile(
						join(root, "tests/bombadil/installed-wizard-model.ts"),
					),
				),
				results,
			};
			await writeFile(
				join(output, "summary.json"),
				`${JSON.stringify(summary, null, 2)}\n`,
				{ mode: 0o600, flag: "wx" },
			);
			info.annotations.push({
				type: "evidence-scope",
				description: summary.scope,
			});
		} finally {
			tripwire.closeAllConnections();
			await new Promise<void>((done) => tripwire.close(() => done()));
		}
	} catch (error) {
		const diagnostic = (
			error as { installedDiagnostic?: { step: string; category: string } }
		)?.installedDiagnostic;
		if (
			diagnostic &&
			steps.includes(diagnostic.step) &&
			categories.includes(diagnostic.category)
		)
			progress(diagnostic.step);
		info.annotations.push({
			type: "bombadil-category",
			description:
				diagnostic && categories.includes(diagnostic.category)
					? diagnostic.category
					: classify(error),
		});
		throw error;
	}
}
