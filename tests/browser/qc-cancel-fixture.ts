import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	type Browser,
	type BrowserContext,
	expect,
	type TestInfo,
} from "@playwright/test";

/** Uses the real authenticated route and database, with an inert synthetic job. */
export async function verifyQcCancelBrowser(
	browser: Browser,
	baseURL: string,
	authenticated: Awaited<ReturnType<BrowserContext["storageState"]>>,
	info: TestInfo,
	fixture: { id: string; postgresContainer: string },
) {
	assert.match(fixture.id, /^[a-f0-9]{32}$/);
	assert.match(fixture.postgresContainer, /^[a-f0-9]{64}$/);
	const docker = (args: string[]) =>
		execFileSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
			encoding: "utf8",
			timeout: 20_000,
		}).trim();
	const labels = JSON.parse(
		docker([
			"inspect",
			"--format",
			"{{json .Config.Labels}}",
			fixture.postgresContainer,
		]),
	);
	assert.equal(labels?.["io.bitovp.gui-smoke"], fixture.id);
	assert.equal(
		labels?.["com.docker.compose.project"],
		`bitovp-gui-${fixture.id}`,
	);
	assert.equal(labels?.["com.docker.compose.service"], "postgres");
	const sql = (statement: string) =>
		docker([
			"exec",
			fixture.postgresContainer,
			"psql",
			"--username",
			"bitovp",
			"--dbname",
			"bitovp",
			"--set",
			"ON_ERROR_STOP=1",
			"--tuples-only",
			"--no-align",
			"--command",
			statement,
		]);
	const id = randomUUID();
	const resultId = randomUUID();
	const organization = "00000000-0000-4000-8000-000000000001";
	const apiPath = `/api/vmaf-jobs/${id}`;
	const cancelPath = `${apiPath}/cancel`;
	const error = "Local measurement cancellation requested; cleanup continues";
	const pooled = {
		mean: 91.25,
		harmonicMean: 91.25,
		min: 91.25,
		max: 91.25,
		percentiles: { p1: 91.25, p5: 91.25, p10: 91.25, p25: 91.25, p50: 91.25 },
		low1Percent: 91.25,
		worstFrame: { frameNum: 0, vmaf: 91.25 },
	};
	const context = await browser.newContext({
		baseURL,
		storageState: authenticated,
		locale: "en-US",
		serviceWorkers: "block",
	});
	const unexpected: string[] = [];
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (
			url.origin !== baseURL ||
			(!["GET", "HEAD"].includes(request.method()) &&
				!(request.method() === "POST" && url.pathname === cancelPath))
		) {
			unexpected.push("Unexpected request during real QC cancellation");
			return route.abort();
		}
		return route.continue();
	});
	let priorQcVmaf: boolean | undefined;
	let seeded = false;
	try {
		expect(
			(await (await context.request.get("/api/auth/session")).json()).role,
		).toBe("ADMIN");
		const flags = await context.request.get("/api/settings/features");
		expect(flags.status()).toBe(200);
		priorQcVmaf = (await flags.json()).qcVmaf;
		expect(typeof priorQcVmaf).toBe("boolean");
		const enabled = await context.request.patch("/api/settings/features", {
			headers: { origin: baseURL },
			data: { qcVmaf: true },
		});
		expect(enabled.status()).toBe(200);
		expect((await enabled.json()).qcVmaf).toBe(true);
		// No queue entry is created. The fixture's Worker remains stopped.
		sql(`BEGIN;
INSERT INTO "VmafJob" (id, "organizationId", mode, model, "scoringVersion", params, status, "doneUnits", "totalUnits", "updatedAt")
VALUES ('${id}', '${organization}', 'VOD', 'vmaf_v0.6.1', 2, '{"execution":{"backend":"LOCAL"}}', 'RUNNING', 1, 2, now());
INSERT INTO "VmafResult" (id, "organizationId", "vmafJobId", "renditionRef", pooled, frames)
VALUES ('${resultId}', '${organization}', '${id}', '{"label":"Retained synthetic result"}', '${JSON.stringify(pooled)}', '[{"frameNum":0,"vmaf":91.25}]');
COMMIT;`);
		seeded = true;
		const unauthenticated = await browser.newContext({
			baseURL,
			serviceWorkers: "block",
		});
		try {
			expect(
				(
					await unauthenticated.request.post(cancelPath, {
						headers: { origin: baseURL },
					})
				).status(),
			).toBe(401);
		} finally {
			await unauthenticated.close();
		}
		const read = async () => {
			const response = await context.request.get(apiPath);
			expect(response.status()).toBe(200);
			return response.json();
		};
		const before = await read();
		expect(before).toMatchObject({
			id,
			status: "RUNNING",
			doneUnits: 1,
			totalUnits: 2,
		});
		expect(before.results).toHaveLength(1);
		expect(before.results[0]).toMatchObject({ id: resultId, pooled });
		const page = await context.newPage();
		page.on("pageerror", () => unexpected.push("Browser page error"));
		page.on("console", (message) => {
			if (message.type() === "error") unexpected.push("Browser console error");
		});
		await page.goto(`/qc/${id}`);
		await page
			.getByRole("button", { name: "Request cancellation", exact: true })
			.click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Measured results are retained");
		const response = page.waitForResponse(
			(r) =>
				new URL(r.url()).pathname === cancelPath &&
				r.request().method() === "POST",
		);
		await dialog
			.getByRole("button", { name: "Request cancellation", exact: true })
			.click();
		const cancellation = await response;
		expect(cancellation.status()).toBe(200);
		expect(await cancellation.json()).toEqual({
			id,
			cancelRequested: true,
			stopped: false,
		});
		await expect(
			page.getByText("Cancellation requested. Stopping is not yet confirmed.", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Request cancellation", exact: true }),
		).toHaveCount(0);
		await page.reload();
		await expect(page.getByText(error, { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Request cancellation", exact: true }),
		).toHaveCount(0);
		const after = await read();
		expect(after).toMatchObject({
			status: "ERROR",
			error,
			doneUnits: 1,
			totalUnits: 2,
		});
		expect(after.results).toEqual(before.results);
		const repeated = await context.request.post(cancelPath, {
			headers: { origin: baseURL },
		});
		expect(repeated.status()).toBe(200);
		expect(await repeated.json()).toEqual({
			id,
			cancelRequested: false,
			stopped: false,
		});
		expect(await read()).toEqual(after);
		const saved = JSON.parse(
			sql(`SELECT json_build_object('status', status, 'error', error,
'resultCount', (SELECT count(*) FROM "VmafResult" WHERE "vmafJobId" = '${id}')) FROM "VmafJob" WHERE id = '${id}';`),
		);
		expect(saved).toEqual({ status: "ERROR", error, resultCount: 1 });
		expect(unexpected).toEqual([]);
		info.annotations.push({
			type: "evidence-scope",
			description:
				"Real authenticated cancellation, persisted PostgreSQL status, reload, idempotent repeat and partial-result retention; inert synthetic job, no worker-exit or quality-scoring proof",
		});
	} finally {
		try {
			if (seeded)
				sql(
					`DELETE FROM "VmafJob" WHERE id = '${id}' AND "organizationId" = '${organization}';`,
				);
		} finally {
			try {
				if (priorQcVmaf !== undefined) {
					const restored = await context.request.patch(
						"/api/settings/features",
						{
							headers: { origin: baseURL },
							data: { qcVmaf: priorQcVmaf },
						},
					);
					expect(restored.status()).toBe(200);
					expect((await restored.json()).qcVmaf).toBe(priorQcVmaf);
				}
			} finally {
				await context.close();
			}
		}
	}
}
