import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AesGcmCipher,
	type DeliverySpec,
	type SecretCipher,
} from "@bitovp/core";
import { type AppPrismaClient, createPrismaClient } from "../src/client";
import { prepareRuntimeRole } from "../src/runtime-role-setup";
import { createTenantPrismaClient } from "../src/tenant-client";
import { readUpgradePreflight } from "../src/upgrade-preflight";

type Snapshot = {
	tables: { name: string; rows: number; sha256: string }[];
	schemaSha256: string;
};
type OldClient = Pick<
	AppPrismaClient,
	| "organization"
	| "user"
	| "membership"
	| "credential"
	| "bitmovinAccount"
	| "appSetting"
	| "preset"
	| "watchRule"
	| "encodingJob"
	| "librarySource"
	| "content"
	| "contentRevision"
	| "libraryMediaVersion"
	| "editProject"
	| "editRevision"
	| "$disconnect"
>;
const root = resolve(import.meta.dirname, "../../..");
let stage = "validating isolated fixture identity";
const run = (file: string, args: string[], env = process.env) =>
	execFileSync(file, args, {
		cwd: root,
		env,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 180_000,
		maxBuffer: 32 * 1024 * 1024,
	}).trim();

async function main() {
	const args = process.argv.slice(2);
	assert(
		args.length === 4 && args[0] === "--directory" && args[2] === "--base-ref",
	);
	const directory = realpathSync(args[1] ?? "");
	const fixtureAdmin = new URL(process.env.BITOVP_TENANT_TEST_ADMIN_URL ?? "");
	const fixtureRuntime = new URL(process.env.BITOVP_TENANT_TEST_APP_URL ?? "");
	assert.equal(fixtureAdmin.hostname, "127.0.0.1");
	assert.equal(fixtureRuntime.host, fixtureAdmin.host);
	assert.match(fixtureAdmin.pathname, /^\/bitovp_integration_[a-f0-9]{32}$/);
	const id = fixtureAdmin.pathname.slice("/bitovp_integration_".length);
	const container = `bitovp-postgres-${id}`;
	const docker = (commands: string[]) =>
		run("docker", ["--host", "unix:///var/run/docker.sock", ...commands]);
	assert.equal(
		JSON.parse(
			docker(["inspect", "--format", "{{json .Config.Labels}}", container]),
		)["io.bitovp.postgres-test"],
		id,
	);
	const database = `bitovp_upgrade_${id}`;
	const restored = `bitovp_rollback_${id}`;
	const url = (name: string, base = fixtureAdmin) => {
		const result = new URL(base);
		result.pathname = `/${name}`;
		return result.toString();
	};
	const admin = createPrismaClient(fixtureAdmin.toString());
	const clients: { $disconnect(): Promise<void> }[] = [admin];
	try {
		const baseSha = run("git", [
			"rev-parse",
			"--verify",
			`${args[3]}^{commit}`,
		]);
		assert.match(baseSha, /^[a-f0-9]{40}$/);
		const candidateSha = run("git", ["rev-parse", "HEAD"]);
		const initiallyClean =
			run("git", ["status", "--porcelain", "--untracked-files=all"]) === "";
		const sourceFiles = [
			"packages/db/prisma/schema.prisma",
			"packages/db/scripts/upgrade-rehearsal-fixture.ts",
			"packages/db/src/upgrade-preflight.ts",
			"packages/core/src/plan/saved-plan-compatibility.ts",
			"packages/core/src/plan/submit.ts",
		];
		for (const item of readdirSync(
			join(root, "packages/db/prisma/migrations"),
			{
				withFileTypes: true,
			},
		))
			if (item.isDirectory())
				sourceFiles.push(
					`packages/db/prisma/migrations/${item.name}/migration.sql`,
				);
		const sourceHash = () => {
			const hash = createHash("sha256");
			for (const file of sourceFiles.sort())
				hash
					.update(file)
					.update("\0")
					.update(readFileSync(join(root, file)));
			return hash.digest("hex");
		};
		const candidateSourceSha256 = sourceHash();
		const oldRoot = join(directory, "baseline");
		mkdirSync(oldRoot, { mode: 0o700 });
		stage = "extracting the exact baseline source";
		const archive = execFileSync("git", ["archive", baseSha], {
			cwd: root,
			maxBuffer: 100 * 1024 * 1024,
		});
		execFileSync("tar", ["-x", "-C", oldRoot], { input: archive });
		for (const folder of ["", "packages/core", "packages/db"])
			symlinkSync(
				join(root, folder, "node_modules"),
				join(oldRoot, folder, "node_modules"),
				"dir",
			);
		const oldSchema = join(oldRoot, "packages/db/prisma/schema.prisma");
		const oldEnv = { ...process.env, DATABASE_URL: url(database) };
		const prisma = (commands: string[], env = oldEnv) =>
			run(
				"pnpm",
				["--filter", "@bitovp/db", "exec", "prisma", ...commands],
				env,
			);
		stage = "creating the old-version database";
		await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
		const current = createPrismaClient(url(database));
		clients.push(current);
		await prepareRuntimeRole(current, fixtureRuntime.username);
		prisma(["migrate", "deploy", "--schema", oldSchema]);
		prisma(["generate", "--schema", oldSchema]);
		const oldModule: {
			PrismaClient: new (options: { datasourceUrl: string }) => OldClient;
		} = await import(
			pathToFileURL(join(oldRoot, "packages/db/generated/client/index.js")).href
		);
		const oldCrypto: { AesGcmCipher: new (key: Buffer) => SecretCipher } =
			await import(
				pathToFileURL(join(oldRoot, "packages/core/src/crypto/aes-gcm.ts")).href
			);
		const oldSpecs: { DELIVERY_SPECS: DeliverySpec[] } = await import(
			pathToFileURL(join(oldRoot, "packages/core/src/plan/delivery-presets.ts"))
				.href
		);
		const oldAuth: {
			hashPassword: (value: string) => string;
			verifyPassword: (value: string, stored: string) => Promise<boolean>;
		} = await import(
			pathToFileURL(join(oldRoot, "apps/web/src/lib/auth/password.ts")).href
		);
		const currentAuth: {
			verifyPassword: (value: string, stored: string) => Promise<boolean>;
		} = await import(
			pathToFileURL(join(root, "apps/web/src/lib/auth/password.ts")).href
		);
		const old = new oldModule.PrismaClient({ datasourceUrl: url(database) });
		clients.push(old);
		const key = randomBytes(32);
		const oldCipher = new oldCrypto.AesGcmCipher(key);
		const cipher = new AesGcmCipher(key);
		const organizationId = randomUUID();
		const userId = randomUUID();
		const otherOrganizationId = randomUUID();
		const credentialId = randomUUID();
		const accountId = randomUUID();
		const jobId = randomUUID();
		const sourceId = randomUUID();
		const contentId = randomUUID();
		const mediaId = randomUUID();
		const projectId = randomUUID();
		const revisionId = randomUUID();
		const credentialAad = `credential:${credentialId}:AWS_S3`;
		const accountAad = `bitmovin-account:${accountId}`;
		const secret = "synthetic-upgrade-fixture-secret";
		stage = "seeding legacy settings credentials templates and editing history";
		for (const [org, slug] of [
			[organizationId, "upgrade-a"],
			[otherOrganizationId, "upgrade-b"],
		])
			await old.organization.create({
				data: { id: org, name: slug ?? "", slug: `${slug}-${id}` },
			});
		await old.user.create({
			data: {
				id: userId,
				email: `upgrade-${id}@invalid`,
				displayName: "Fixture user",
				role: "ADMIN",
				passwordHash: oldAuth.hashPassword(secret),
			},
		});
		await old.membership.create({
			data: { userId, organizationId, role: "ADMIN" },
		});
		stage = "seeding the legacy encrypted credential";
		await old.credential.create({
			data: {
				id: credentialId,
				organizationId,
				label: "Fixture S3",
				provider: "AWS_S3",
				config: { region: "ap-northeast-1" },
				encryptedSecret: await oldCipher.encrypt(secret, credentialAad),
			},
		});
		stage = "seeding the legacy encrypted account";
		await old.bitmovinAccount.create({
			data: {
				id: accountId,
				organizationId,
				label: "Fixture account",
				encryptedApiKey: await oldCipher.encrypt(secret, accountAad),
			},
		});
		stage = "seeding the legacy setting";
		await old.appSetting.create({
			data: {
				organizationId,
				key: "upgrade.fixture",
				value: { retained: true },
			},
		});
		stage = "seeding legacy presets and watch rules";
		const presetIds = [];
		for (const spec of oldSpecs.DELIVERY_SPECS) {
			const plan = {
				...spec.plan,
				delivery: { specId: spec.id, onDeviation: "REFUSE" },
			};
			const preset = await old.preset.create({
				data: { organizationId, kind: "FULL_PLAN", name: spec.id, body: plan },
			});
			presetIds.push(preset.id);
			await old.watchRule.create({
				data: {
					organizationId,
					name: spec.id,
					presetId: preset.id,
					credentialId,
					bucket: "synthetic-input",
					outputPrefixTemplate: "{uuid}",
				},
			});
		}
		const plan = oldSpecs.DELIVERY_SPECS[0]?.plan;
		assert(plan);
		stage = "seeding legacy encoding history";
		await old.encodingJob.create({
			data: {
				id: jobId,
				organizationId,
				name: "Preserved VOD",
				status: "FINISHED",
				plan,
				bitmovinAccountId: accountId,
				bitmovinEncodingId: `synthetic-${id}`,
				finishedAt: new Date(),
			},
		});
		stage = "seeding the legacy library source";
		await old.librarySource.create({
			data: {
				id: sourceId,
				organizationId,
				sourceKey: `job:${jobId}`,
				jobId,
				originalJobId: jobId,
				encodingId: `synthetic-${id}`,
				accountId,
				snapshot: { kind: "VOD_JOB", jobId, retained: true },
				locales: ["en"],
				state: "READY",
			},
		});
		stage = "seeding legacy content and its revision";
		await old.content.create({
			data: {
				id: contentId,
				organizationId,
				registrationKey: sourceId,
				title: "Preserved content",
				locale: "en",
				tags: [],
			},
		});
		await old.contentRevision.create({
			data: {
				organizationId,
				contentId,
				sourceId,
				revision: 1,
				title: "Preserved content",
				description: "",
				locale: "en",
				tags: [],
			},
		});
		stage = "seeding the legacy media version";
		await old.libraryMediaVersion.create({
			data: {
				id: mediaId,
				organizationId,
				sourceId,
				credentialId,
				outputCredentialId: credentialId,
				storage: {
					output: {
						credentialId,
						bucket: "synthetic-output",
						prefix: "fixture/",
					},
				},
			},
		});
		const document = {
			fixture: true,
			formatVersion: 1,
			sourceId,
			clips: [{ sourceStartUs: 1_000_000, sourceEndUs: 6_000_000 }],
		};
		stage = "seeding the legacy edit project and revision";
		await old.editProject.create({
			data: {
				id: projectId,
				organizationId,
				contentId,
				mediaVersionId: mediaId,
				title: "Preserved edit",
				variant: "fixture",
				draft: document,
			},
		});
		await old.editRevision.create({
			data: {
				id: revisionId,
				organizationId,
				projectId,
				revision: 1,
				document,
			},
		});
		await old.editProject.update({
			where: { id: projectId },
			data: { currentRevisionId: revisionId },
		});
		const snapshotModule: {
			snapshotDatabase: (
				compose: (args: string[]) => Promise<string>,
				database: string,
			) => Promise<Snapshot>;
		} = await import(
			pathToFileURL(join(root, "scripts/database-restore-proof.mjs")).href
		);
		const compose = async (commands: string[]) => {
			assert(
				commands[0] === "exec" &&
					commands[1] === "-T" &&
					commands[2] === "postgres",
			);
			return docker([
				"exec",
				"--env",
				`POSTGRES_DB=${database}`,
				container,
				...commands.slice(3),
			]);
		};
		stage = "capturing old data schema and a real backup";
		const before = await snapshotModule.snapshotDatabase(compose, database);
		const dump = `/tmp/bitovp-upgrade-${id}.dump`;
		docker([
			"exec",
			container,
			"pg_dump",
			"--username",
			fixtureAdmin.username,
			"--dbname",
			database,
			"--format=custom",
			"--no-owner",
			"--file",
			dump,
		]);
		stage = "checking saved definitions before replacing writers";
		const preflight = await readUpgradePreflight(current);
		assert.equal(preflight.blockingTemplates, 2);
		assert.deepEqual(
			preflight.affected.map((row) => row.presetId).sort(),
			presetIds.sort(),
		);
		assert(
			preflight.affected.every(
				(row) =>
					row.action === "RELOAD_DELIVERY_PRESET_AND_RESAVE" &&
					row.watchRules.some((rule) => rule.enabled),
			),
		);
		assert.deepEqual(
			await snapshotModule.snapshotDatabase(compose, database),
			before,
		);
		stage = "applying candidate migrations to existing data";
		prisma([
			"migrate",
			"deploy",
			"--schema",
			join(root, "packages/db/prisma/schema.prisma"),
		]);
		await prepareRuntimeRole(current, fixtureRuntime.username);
		const upgraded = await snapshotModule.snapshotDatabase(compose, database);
		for (const table of before.tables)
			if (table.name !== "_prisma_migrations")
				assert.deepEqual(
					upgraded.tables.find((row) => row.name === table.name),
					table,
					`Changed preserved table ${table.name}`,
				);
		stage = "reading upgraded data with current code and the original key";
		assert.equal(
			await currentAuth.verifyPassword(
				secret,
				(await current.user.findUniqueOrThrow({ where: { id: userId } }))
					.passwordHash,
			),
			true,
		);
		assert.equal(
			(
				await current.membership.findUniqueOrThrow({
					where: { userId_organizationId: { userId, organizationId } },
				})
			).role,
			"ADMIN",
		);
		assert.equal(
			await cipher.decrypt(
				(
					await current.credential.findUniqueOrThrow({
						where: { id: credentialId },
						select: { encryptedSecret: true },
					})
				).encryptedSecret,
				credentialAad,
			),
			secret,
		);
		assert.equal(
			await cipher.decrypt(
				(
					await current.bitmovinAccount.findUniqueOrThrow({
						where: { id: accountId },
						select: { encryptedApiKey: true },
					})
				).encryptedApiKey,
				accountAad,
			),
			secret,
		);
		assert.deepEqual(
			(
				await current.editRevision.findUniqueOrThrow({
					where: { id: revisionId },
				})
			).document,
			document,
		);
		const runtime = createPrismaClient(url(database, fixtureRuntime));
		clients.push(runtime);
		const tenant = createTenantPrismaClient(runtime, organizationId);
		assert(await tenant.content.findUnique({ where: { id: contentId } }));
		assert.equal(
			await createTenantPrismaClient(
				runtime,
				otherOrganizationId,
			).content.findUnique({ where: { id: contentId } }),
			null,
		);
		await assert.rejects(readUpgradePreflight(runtime), /administrator/);
		await tenant.vodInputPreviewTask.create({
			data: {
				kind: "IMAGE_PREPARE",
				requestHash: "a".repeat(64),
				request: { fixture: true },
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		stage = "restoring the pre-upgrade dump into an isolated rollback database";
		await admin.$executeRawUnsafe(`CREATE DATABASE "${restored}"`);
		docker([
			"exec",
			container,
			"pg_restore",
			"--username",
			fixtureAdmin.username,
			"--dbname",
			restored,
			"--exit-on-error",
			"--no-owner",
			dump,
		]);
		assert.deepEqual(
			await snapshotModule.snapshotDatabase(compose, restored),
			before,
		);
		stage = "verifying rollback with the exact old client and crypto code";
		const rollback = new oldModule.PrismaClient({
			datasourceUrl: url(restored),
		});
		clients.push(rollback);
		assert.equal(
			await oldAuth.verifyPassword(
				secret,
				(await rollback.user.findUniqueOrThrow({ where: { id: userId } }))
					.passwordHash,
			),
			true,
		);
		assert.equal(
			await oldCipher.decrypt(
				(
					await rollback.credential.findUniqueOrThrow({
						where: { id: credentialId },
						select: { encryptedSecret: true },
					})
				).encryptedSecret,
				credentialAad,
			),
			secret,
		);
		assert.equal(
			await oldCipher.decrypt(
				(
					await rollback.bitmovinAccount.findUniqueOrThrow({
						where: { id: accountId },
						select: { encryptedApiKey: true },
					})
				).encryptedApiKey,
				accountAad,
			),
			secret,
		);
		assert.deepEqual(
			(
				await rollback.editRevision.findUniqueOrThrow({
					where: { id: revisionId },
				})
			).document,
			document,
		);
		assert.deepEqual(
			(
				await rollback.appSetting.findFirstOrThrow({
					where: { organizationId, key: "upgrade.fixture" },
				})
			).value,
			{ retained: true },
		);
		assert.equal(
			await rollback.watchRule.count({ where: { organizationId } }),
			2,
		);
		assert.equal(
			sourceHash(),
			candidateSourceSha256,
			"Candidate migration/source bytes changed during the rehearsal",
		);
		assert.equal(
			run("git", ["rev-parse", "HEAD"]),
			candidateSha,
			"Candidate commit changed during the rehearsal",
		);
		const report = {
			status: "passed",
			baseSha,
			candidateSha,
			candidateSourceSha256,
			sourceClean:
				initiallyClean &&
				run("git", ["status", "--porcelain", "--untracked-files=all"]) === "",
			baselineTables: before.tables.length,
			baselineRows: before.tables.reduce((sum, table) => sum + table.rows, 0),
			baselineSchemaSha256: before.schemaSha256,
			upgradedSchemaSha256: upgraded.schemaSha256,
			preservedTables: before.tables.filter(
				(table) => table.name !== "_prisma_migrations",
			).length,
			preflight: {
				checkedTemplates: preflight.checkedTemplates,
				blockingTemplates: preflight.blockingTemplates,
				enabledWatchRules: 2,
				readOnlyVerified: true,
			},
			checks: [
				"legacy-password-and-membership",
				"legacy-data-preserved",
				"same-key-decryption",
				"editing-history-preserved",
				"tenant-isolation",
				"new-migration-runtime-write",
				"full-dump-restore-equality",
				"baseline-client-and-crypto-read",
			],
			boundary:
				"Synthetic data and exact baseline/candidate schema/reader code; production rollout, full old Web/Worker images and provider behavior require separate verification.",
		};
		console.log(`BITOVP_UPGRADE_REPORT=${JSON.stringify(report)}`);
	} finally {
		for (const client of clients) await client.$disconnect();
	}
}

main().catch((error: unknown) => {
	console.error(
		`Upgrade rehearsal failed while ${stage}; private database values are not printed.`,
	);
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		/^P\d{4}$/.test(error.code)
	)
		console.error(`Prisma error ${error.code}`);
	if (error instanceof Error) {
		console.error(`Error type: ${error.name}`);
		const argument = error.message.match(
			/(?:Unknown argument `\w+`|Argument `\w+` is missing)/,
		);
		if (argument) console.error(argument[0]);
	}
	process.exitCode = 1;
});
