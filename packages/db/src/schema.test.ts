import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	$Enums,
	FeederPushAttempt,
	FeederSession,
	LiveChannel,
} from "../generated/client";

/**
 * Schema-shape pins for the P3-PR2 live lifecycle: the generated client
 * gives compile-time checks (a drifting enum/model fails typecheck), the
 * schema/migration text assertions catch edits that skip `prisma generate`
 * or hand-edit migrations out of sync.
 */

const schemaPath = join(__dirname, "../prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf8");

function block(kind: "enum" | "model", name: string): string {
	// Up to the first line-leading "}" — doc comments may contain braces.
	const match = schema.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`));
	if (!match) {
		throw new Error(`${kind} ${name} not found in schema.prisma`);
	}
	return match[0];
}

describe("User session generation", () => {
	it("binds signed users-mode sessions to a monotonic database generation", () => {
		const body = block("model", "User");
		expect(body).toMatch(/^\s{2}sessionGeneration\s+Int\s+@default\(0\)$/m);
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260831120000_user_session_generation/migration.sql",
			),
			"utf8",
		);
		expect(sql).toContain(
			'ADD COLUMN "sessionGeneration" INTEGER NOT NULL DEFAULT 0',
		);
	});
});

describe("LiveChannelStatus enum", () => {
	it("carries exactly the lifecycle states (RUNNING is steady, not terminal)", () => {
		const body = block("enum", "LiveChannelStatus");
		const values = [...body.matchAll(/^\s{2}([A-Z_]+)$/gm)].map((m) => m[1]);
		expect(values).toEqual([
			"CREATED",
			"PROVISIONING",
			"RUNNING",
			"STOPPING",
			"STOPPED",
			"ERROR",
		]);
		// Compile-time pin against the generated client.
		const steady: $Enums.LiveChannelStatus = "RUNNING";
		const transitional: $Enums.LiveChannelStatus = "STOPPING";
		expect([steady, transitional]).toEqual(["RUNNING", "STOPPING"]);
	});
});

describe("LiveChannel model", () => {
	it("has the lifecycle columns (status/stepLog/streamKey/encoderIp/lastHeartbeat/error)", () => {
		const body = block("model", "LiveChannel");
		for (const field of [
			"status",
			"plan",
			"stepLog",
			"bitmovinEncodingId",
			"bitmovinAccountId",
			"streamKey",
			"encoderIp",
			"lastHeartbeat",
			"error",
		]) {
			expect(body).toMatch(new RegExp(`^\\s{2}${field}\\s`, "m"));
		}
		// The v1 placeholder columns are gone — superseded by the lifecycle row.
		for (const gone of ["state ", "ingest ", "dvr ", "stateTimeline "]) {
			expect(body).not.toContain(`\n  ${gone}`);
		}
		// Compile-time pin: the generated row type carries the new columns.
		type Pinned = Pick<
			LiveChannel,
			| "status"
			| "stepLog"
			| "streamKey"
			| "encoderIp"
			| "lastHeartbeat"
			| "error"
		>;
		const row: Pinned = {
			status: "PROVISIONING",
			stepLog: [],
			streamKey: null,
			encoderIp: null,
			lastHeartbeat: null,
			error: null,
		};
		expect(row.status).toBe("PROVISIONING");
	});

	it("keeps list-friendly indexes (status+createdAt, createdAt)", () => {
		const body = block("model", "LiveChannel");
		expect(body).toContain("@@index([status, createdAt(sort: Desc)])");
		expect(body).toContain("@@index([createdAt(sort: Desc)])");
	});
});

describe("FeederSession model (P3-PR3)", () => {
	it("carries the feeder lifecycle states (no STOPPING — stop is in-process)", () => {
		const body = block("enum", "FeederStatus");
		const values = [...body.matchAll(/^\s{2}([A-Z_]+)$/gm)].map((m) => m[1]);
		expect(values).toEqual([
			"CREATED",
			"DOWNLOADING",
			"PUSHING",
			"STOPPED",
			"ERROR",
		]);
		const pushing: $Enums.FeederStatus = "PUSHING";
		expect(pushing).toBe("PUSHING");
	});

	it("pins SRT to CALLER mode (the feeder dials Bitmovin's listener)", () => {
		const body = block("enum", "FeederProtocol");
		const values = [...body.matchAll(/^\s{2}([A-Z_]+)$/gm)].map((m) => m[1]);
		expect(values).toEqual(["RTMP", "SRT_CALLER"]);
		const srt: $Enums.FeederProtocol = "SRT_CALLER";
		expect(srt).toBe("SRT_CALLER");
	});

	it("has the session columns (source/target/pid/loopBoundaries/logTail/timestamps)", () => {
		const body = block("model", "FeederSession");
		for (const field of [
			"liveChannelId",
			"status",
			"sourceCredentialId",
			"sourceBucket",
			"sourceKey",
			"protocol",
			"target",
			"pid",
			"loopBoundaries",
			"logTail",
			"startedAt",
			"stoppedAt",
			"error",
		]) {
			expect(body).toMatch(new RegExp(`^\\s{2}${field}\\s`, "m"));
		}
		// Compile-time pin: the generated row type carries the new columns.
		type Pinned = Pick<
			FeederSession,
			| "status"
			| "protocol"
			| "pid"
			| "loopBoundaries"
			| "logTail"
			| "startedAt"
			| "stoppedAt"
		>;
		const row: Pinned = {
			status: "PUSHING",
			protocol: "RTMP",
			pid: 4242,
			loopBoundaries: [],
			logTail: [],
			startedAt: null,
			stoppedAt: null,
		};
		expect(row.protocol).toBe("RTMP");
	});

	it("keeps list/coupling indexes and replaces the v1 placeholder by migration", () => {
		const body = block("model", "FeederSession");
		expect(body).toContain("@@index([liveChannelId])");
		expect(body).toContain("@@index([status, createdAt(sort: Desc)])");
		expect(body).toContain("@@index([createdAt(sort: Desc)])");
		// The v1 PseudoLiveFeed placeholder is gone (PR2 precedent).
		expect(schema).not.toContain("model PseudoLiveFeed");
		expect(schema).not.toContain("enum FeedState");
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260612130000_feeder_sessions/migration.sql",
			),
			"utf8",
		);
		expect(sql).toContain(`DROP TABLE "PseudoLiveFeed";`);
		expect(sql).toContain(
			`CREATE TYPE "FeederStatus" AS ENUM ('CREATED', 'DOWNLOADING', 'PUSHING', 'STOPPED', 'ERROR');`,
		);
		expect(sql).toContain(
			`CREATE TYPE "FeederProtocol" AS ENUM ('RTMP', 'SRT_CALLER');`,
		);
		expect(sql).toContain(`CREATE TABLE "FeederSession"`);
		expect(sql).toMatch(/ON DELETE CASCADE/);
	});
});

describe("FeederSession publisher claim (audit 5c3d97ca BLOCKER-2 / LC-02)", () => {
	/**
	 * Schema ↔ migration ↔ generated client, for the three columns the
	 * single-publisher guarantee rests on. The partial unique index is
	 * datamodel-inexpressible, so its ONLY pin is the migration text asserted
	 * here (and MIGRATIONS.md's enumeration).
	 */
	const sql = readFileSync(
		join(
			__dirname,
			"../prisma/migrations/20260830070000_feeder_publisher_claim/migration.sql",
		),
		"utf8",
	);

	it("carries the three claim columns, generation defaulted to 0", () => {
		const body = block("model", "FeederSession");
		expect(body).toMatch(/^\s{2}publisherClaimedAt\s+DateTime\?/m);
		expect(body).toMatch(/^\s{2}publisherReleasedAt\s+DateTime\?/m);
		expect(body).toMatch(/^\s{2}publisherGeneration\s+Int\s+@default\(0\)/m);
		// Compile-time pin against the generated client.
		type Pinned = Pick<
			FeederSession,
			"publisherClaimedAt" | "publisherReleasedAt" | "publisherGeneration"
		>;
		const row: Pinned = {
			publisherClaimedAt: null,
			publisherReleasedAt: null,
			publisherGeneration: 0,
		};
		expect(row.publisherGeneration).toBe(0);
	});

	it("ships the columns additively and the held-claim partial unique index", () => {
		expect(sql).toContain(
			`ALTER TABLE "FeederSession" ADD COLUMN "publisherClaimedAt" TIMESTAMP(3),`,
		);
		expect(sql).toContain(`ADD COLUMN     "publisherReleasedAt" TIMESTAMP(3),`);
		expect(sql).toContain(
			`ADD COLUMN     "publisherGeneration" INTEGER NOT NULL DEFAULT 0;`,
		);
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "FeederSession_one_publisher_claim_per_channel"\s+ON "FeederSession"\("liveChannelId"\)\s+WHERE "publisherClaimedAt" IS NOT NULL AND "publisherReleasedAt" IS NULL;/,
		);
	});

	it("backfills ONLY rows that prove a real spawn, fails CLOSED on a duplicate, fabricates no proof", () => {
		// Prisma's PostgreSQL migrations are not an implicit transaction contract.
		// The duplicate scan, backfill and unique-index creation must be one
		// all-or-nothing unit: a later failure must not leave claim columns or a
		// backfill partially applied while the migration remains failed.
		expect(sql).toMatch(/BEGIN;\s+ALTER TABLE/);
		expect(sql.trimEnd()).toMatch(/COMMIT;$/);
		// The candidate population appears byte-equivalently in the duplicate
		// scan and the backfill: PUSHING, a recorded pid nobody has proven gone,
		// OR a started publisher whose pid pointer was lost without gone proof.
		// Omitting the third arm would recreate the finding at migration time:
		// an old STOPPED/ERROR row could have published, remain unproven, receive
		// no claim, and become invisible to the unique index.
		const candidate =
			/"status" = 'PUSHING'\s+OR \("pid" IS NOT NULL AND "processGoneAt" IS NULL\)\s+OR \("startedAt" IS NOT NULL AND "processGoneAt" IS NULL\)/g;
		expect(sql.match(candidate)).toHaveLength(2);
		// Fail closed: a channel with two live candidates aborts the migration
		// (the DO block runs inside the migration's transaction) and names them.
		expect(sql).toMatch(/HAVING count\(\*\) > 1/);
		expect(sql).toMatch(
			/RAISE EXCEPTION 'feeder publisher claim backfill refused/,
		);
		// The claim stamp is the first push where one was recorded; nothing
		// writes a pid or a processGoneAt.
		expect(sql).toMatch(
			/UPDATE "FeederSession"\s+SET "publisherClaimedAt" = COALESCE\("startedAt", "updatedAt"\),/,
		);
		expect(sql).not.toMatch(/SET[^;]*"processGoneAt"\s*=/);
		expect(sql).not.toMatch(/SET[^;]*"pid"\s*=/);
		// The index is created AFTER the backfill and its scan.
		expect(sql.indexOf("RAISE EXCEPTION")).toBeLessThan(
			sql.indexOf('UPDATE "FeederSession"'),
		);
		expect(sql.indexOf('UPDATE "FeederSession"')).toBeLessThan(
			sql.indexOf("CREATE UNIQUE INDEX"),
		);
	});

	it("writes the rollout order into the migration header (mixed-version publishers forbidden)", () => {
		expect(sql).toMatch(/ROLLOUT ORDER/);
		expect(sql).toMatch(/mixed-version publisher execution is FORBIDDEN/i);
		expect(sql).toContain(
			"There is no supported zero-downtime rollout for this migration",
		);
		for (const step of [
			"column expand",
			"pause the feeder create/switch doors",
			"STOP every pre-claim worker",
			"backfill real publishers",
			"create the unique index",
			"start claim-aware workers only",
			"resume the doors",
		]) {
			expect(sql).toContain(step);
		}
	});
});

describe("FeederPushAttempt actual spawn boundary (audit 5c3d97ca LF-01)", () => {
	const sql = readFileSync(
		join(
			__dirname,
			"../prisma/migrations/20260830080000_feeder_push_attempt/migration.sql",
		),
		"utf8",
	);

	it("keeps pre-spawn intent distinct from nullable post-spawn evidence authority", () => {
		const body = block("model", "FeederPushAttempt");
		expect(body).toMatch(/^\s{2}startedAt\s+DateTime$/m);
		expect(body).toMatch(/^\s{2}processSpawnedAt\s+DateTime\?$/m);
		expect(body).toMatch(/^\s{2}evidenceNotBefore\s+DateTime\?$/m);
		type Pinned = Pick<
			FeederPushAttempt,
			"startedAt" | "processSpawnedAt" | "evidenceNotBefore"
		>;
		const intentOnly: Pinned = {
			startedAt: new Date(0),
			processSpawnedAt: null,
			evidenceNotBefore: null,
		};
		expect(intentOnly.processSpawnedAt).toBeNull();
	});

	it("ships nullable spawn/boundary columns so a pre-spawn intent survives", () => {
		expect(sql).toMatch(/^\s{4}"startedAt" TIMESTAMP\(3\) NOT NULL,$/m);
		expect(sql).toMatch(/^\s{4}"processSpawnedAt" TIMESTAMP\(3\),$/m);
		expect(sql).toMatch(/^\s{4}"evidenceNotBefore" TIMESTAMP\(3\),$/m);
		expect(sql).not.toMatch(/"processSpawnedAt" TIMESTAMP\(3\) NOT NULL/);
		expect(sql).not.toMatch(/"evidenceNotBefore" TIMESTAMP\(3\) NOT NULL/);
	});
});

describe("StorageInspection model (P5 PR-5)", () => {
	it("has a real FK to Credential, so rows cannot outlive the authorization", () => {
		const body = block("model", "StorageInspection");
		// A bare `credentialId String @db.Uuid` left inspection rows — which
		// hold customer bucket names, object keys and media metadata — alive
		// after the credential that authorized reading them was deleted.
		expect(body).toMatch(
			/credential\s+Credential\s+@relation\(fields: \[credentialId\], references: \[id\], onDelete: Cascade\)/,
		);
		// Cascade matches StorageLocationPreset, the only other Credential dependent.
		expect(block("model", "StorageLocationPreset")).toContain(
			"onDelete: Cascade",
		);
		// Back-relation, without which the FK does not compile.
		expect(block("model", "Credential")).toMatch(
			/^\s{2}inspections\s+StorageInspection\[\]/m,
		);
	});

	it("indexes the columns the GET actually filters on", () => {
		const body = block("model", "StorageInspection");
		// GET /api/storage-inspections does findFirst on
		// (credentialId, bucket, objectKey) ordered by createdAt desc; the only
		// index used to be createdAt alone, which serves none of that filter.
		expect(body).toContain(
			"@@index([credentialId, bucket, objectKey, createdAt(sort: Desc)])",
		);
		// Kept for the age-scan retention prune .
		expect(body).toContain("@@index([createdAt(sort: Desc)])");
	});

	it("ships the FK + index migration, sweeping orphans first", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260806090000_storage_inspection_credential_fk/migration.sql",
			),
			"utf8",
		);
		// Rows written before the FK may point at a deleted credential; ADD
		// CONSTRAINT would fail on them, so they are swept first.
		expect(sql).toMatch(/DELETE FROM "StorageInspection"/);
		expect(sql).toContain(
			`CREATE INDEX "StorageInspection_credentialId_bucket_objectKey_createdAt_idx"`,
		);
		expect(sql).toMatch(
			/ALTER TABLE "StorageInspection" ADD CONSTRAINT "StorageInspection_credentialId_fkey"[\s\S]*?ON DELETE CASCADE/,
		);
	});
});

describe("CredentialProvider enum", () => {
	it("includes the live ingest providers (SRT_PASSPHRASE, ZIXI)", () => {
		const body = block("enum", "CredentialProvider");
		expect(body).toMatch(/^\s{2}SRT_PASSPHRASE$/m);
		expect(body).toMatch(/^\s{2}ZIXI$/m);
		const srt: $Enums.CredentialProvider = "SRT_PASSPHRASE";
		const zixi: $Enums.CredentialProvider = "ZIXI";
		expect([srt, zixi]).toEqual(["SRT_PASSPHRASE", "ZIXI"]);
	});

	it("ships the ADD VALUE migration (DRM precedent)", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260612100000_add_live_input_providers/migration.sql",
			),
			"utf8",
		);
		expect(sql).toContain(
			`ALTER TYPE "CredentialProvider" ADD VALUE 'SRT_PASSPHRASE';`,
		);
		expect(sql).toContain(`ALTER TYPE "CredentialProvider" ADD VALUE 'ZIXI';`);
	});

	it("includes the POIS endpoint provider (P5 PR-3 ESAM basic auth)", () => {
		const body = block("enum", "CredentialProvider");
		expect(body).toMatch(/^\s{2}POIS_ENDPOINT$/m);
		// Compile-time pin against the generated client.
		const pois: $Enums.CredentialProvider = "POIS_ENDPOINT";
		expect(pois).toBe("POIS_ENDPOINT");
	});

	it("ships the POIS_ENDPOINT ADD VALUE migration (additive, live-input precedent)", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260806050000_add_pois_endpoint_provider/migration.sql",
			),
			"utf8",
		);
		expect(sql).toContain(
			`ALTER TYPE "CredentialProvider" ADD VALUE 'POIS_ENDPOINT';`,
		);
	});
});

describe("LiveScheduleOutcome enum (audit 602ec286 §17 P1-4)", () => {
	/**
	 * The delivery column's media-witnessed progression. The generated-client
	 * pins below are the compile-time half (a member dropped from schema.prisma
	 * without `prisma generate` fails typecheck); the schema text + migration
	 * assertions are the runtime half (a hand-edited migration or a schema value
	 * with no DDL fails here). Together: schema ↔ migration ↔ generated client,
	 * which is the type every reader ultimately consumes via `@bitovp/db`.
	 */
	it("carries exactly the seven members in progression order", () => {
		const body = block("enum", "LiveScheduleOutcome");
		const members = [...body.matchAll(/^\s{2}([A-Z_]+)$/gm)].map((m) => m[1]);
		expect(members).toEqual([
			"PENDING",
			"PROCESS_PUSHING",
			"INGEST_CONNECTED",
			"SLATE_ARMED",
			"DELIVERED",
			"FAILED",
			"UNKNOWN",
		]);
	});

	it("pins the three media-progression members against the generated client", () => {
		// A drift between schema.prisma and the generated enum is a typecheck
		// failure on these assignments.
		const pushing: $Enums.LiveScheduleOutcome = "PROCESS_PUSHING";
		const connected: $Enums.LiveScheduleOutcome = "INGEST_CONNECTED";
		const armed: $Enums.LiveScheduleOutcome = "SLATE_ARMED";
		expect([pushing, connected, armed]).toEqual([
			"PROCESS_PUSHING",
			"INGEST_CONNECTED",
			"SLATE_ARMED",
		]);
	});

	it("ships the ADD VALUE migration, positioned BEFORE 'DELIVERED'", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260830050000_schedule_outcome_media_progression/migration.sql",
			),
			"utf8",
		);
		for (const value of [
			"PROCESS_PUSHING",
			"INGEST_CONNECTED",
			"SLATE_ARMED",
		]) {
			expect(sql).toContain(
				`ALTER TYPE "LiveScheduleOutcome" ADD VALUE IF NOT EXISTS '${value}' BEFORE 'DELIVERED';`,
			);
		}
	});
});

describe("VerificationLiveEvidence model (audit 5c3d97ca BLOCKER-4 / EV-02)", () => {
	/**
	 * The Live/MSL evidence tuple's row. The uniqueness is the audit's own
	 * recommendation — (run, scenario, airing, output leg) — and the FK is
	 * Cascade because a tuple is a CHILD of its run row. `liveChannelRunId` is
	 * deliberately TEXT with no relation: the evidence must outlive the channel
	 * row it names.
	 */
	it("is unique on (run, scenario, airing, output leg) and cascades from its run", () => {
		const body = block("model", "VerificationLiveEvidence");
		expect(body).toContain(
			"@@unique([verificationRunId, scenario, liveChannelRunId, outputLeg])",
		);
		expect(body).toMatch(
			/verificationRun\s+VerificationRun\s+@relation\(fields: \[verificationRunId\], references: \[id\], onDelete: Cascade\)/,
		);
		for (const field of [
			"scenario",
			"liveChannelRunId",
			"outputLeg",
			"version",
			"complete",
			"missing",
			"tuple",
		]) {
			expect(body).toMatch(new RegExp(`^\\s{2}${field}\\s`, "m"));
		}
		// No relation on the airing: TEXT, so a deleted channel cannot SetNull
		// the join key the seal is about.
		expect(body).not.toMatch(/liveChannelRun\s+LiveChannelRun/);
		// Back-relation on the run row, without which the FK does not compile.
		expect(block("model", "VerificationRun")).toMatch(
			/^\s{2}liveEvidence\s+VerificationLiveEvidence\[\]/m,
		);
	});

	it("ships the CREATE TABLE migration with the same uniqueness and cascade", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260830110000_verification_live_evidence/migration.sql",
			),
			"utf8",
		);
		expect(sql).toContain(`CREATE TABLE "VerificationLiveEvidence"`);
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "VerificationLiveEvidence_[A-Za-z_]+_key" ON "VerificationLiveEvidence"\("verificationRunId", "scenario", "liveChannelRunId", "outputLeg"\)/,
		);
		expect(sql).toMatch(
			/REFERENCES "VerificationRun"\("id"\) ON DELETE CASCADE/,
		);
		// Additive only — no DML the audit standard could never see.
		expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/m);
	});
});

describe("VerificationRun resume authority (audit 5c3d97ca HIGH-6 / EV-03)", () => {
	it("stores one formal prior-run relation and the seal/retention contract", () => {
		const body = block("model", "VerificationRun");
		expect(body).toMatch(
			/resumedFrom\s+VerificationRun\?\s+@relation\("VerificationRunResume", fields: \[resumedFromId\], references: \[id\], onDelete: SetNull\)/,
		);
		expect(body).toContain(
			'resumedRuns   VerificationRun[] @relation("VerificationRunResume")',
		);
		for (const field of [
			"resumeDecision",
			"sealAlgorithm",
			"sealKeyId",
			"evidenceVersion",
			"evidenceManifest",
			"retentionUntil",
		]) {
			expect(body).toMatch(new RegExp(`^\\s{2}${field}\\s`, "m"));
		}
		expect(body).not.toMatch(/^\s{2}resumedFromRunId\s/m);
	});

	it("migrates resolvable legacy links before removing the free-form authority", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260830130000_verification_seal_authority/migration.sql",
			),
			"utf8",
		);
		const backfill = sql.indexOf('SET "resumedFromId" = prior."id"');
		const drop = sql.indexOf('DROP COLUMN "resumedFromRunId"');
		expect(backfill).toBeGreaterThanOrEqual(0);
		expect(drop).toBeGreaterThan(backfill);
		expect(sql).toContain(
			'FOREIGN KEY ("resumedFromId") REFERENCES "VerificationRun"("id")',
		);
		expect(sql).toContain("ON DELETE SET NULL ON UPDATE CASCADE");
	});
});

describe("VerificationRun self-contained report authority", () => {
	it("stores the exact sealed report and rendered markdown in the DB row", () => {
		const body = block("model", "VerificationRun");
		expect(body).toMatch(/^\s{2}reportJson\s+String\?\s+@db\.Text/m);
		expect(body).toMatch(/^\s{2}reportMarkdown\s+String\?\s+@db\.Text/m);
	});

	it("ships an additive migration for the exact report bytes", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260901030000_verification_report_authority/migration.sql",
			),
			"utf8",
		);
		expect(sql).toContain('ADD COLUMN "reportJson" TEXT');
		expect(sql).toContain('ADD COLUMN "reportMarkdown" TEXT');
		expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/m);
	});
});

describe("VerificationRun restart-recovery fence", () => {
	it("stores a monotonic run generation and a bounded owner lease", () => {
		const body = block("model", "VerificationRun");
		expect(body).toMatch(/^\s{2}recoveryOwner\s+String\?/m);
		expect(body).toMatch(/^\s{2}recoveryLeaseUntil\s+DateTime\?/m);
		expect(body).toMatch(/^\s{2}recoveryGeneration\s+Int\s+@default\(0\)/m);
	});

	it("ships an additive migration with the generation default", () => {
		const sql = readFileSync(
			join(
				__dirname,
				"../prisma/migrations/20260901040000_verification_run_recovery_fence/migration.sql",
			),
			"utf8",
		);
		expect(sql).toContain('ADD COLUMN "recoveryOwner" TEXT');
		expect(sql).toContain('ADD COLUMN "recoveryLeaseUntil" TIMESTAMP(3)');
		expect(sql).toContain(
			'ADD COLUMN "recoveryGeneration" INTEGER NOT NULL DEFAULT 0',
		);
		expect(sql).toMatch(/MIXED-VERSION VERIFICATION EXECUTION IS FORBIDDEN/);
		expect(sql).toMatch(/drain and STOP every pre-fence verifier/i);
		expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/m);
	});
});

describe("Prisma schema-drift reconciliation", () => {
	const migrationsPath = join(__dirname, "../prisma/migrations");
	const migrationName = "20260901020000_prisma_schema_drift_reconciliation";
	const migrationPath = join(migrationsPath, migrationName, "migration.sql");

	function migrationSql(): string {
		return readFileSync(migrationPath, "utf8");
	}

	it("fails closed before removing obsolete restart counters", () => {
		const sql = migrationSql();
		expect(sql).toMatch(/^BEGIN;$/m);
		expect(sql.trimEnd()).toMatch(/COMMIT;$/);

		const feederGuard =
			'SELECT 1 FROM "FeederSession" WHERE "restartCount" <> 0';
		const runGuard =
			'SELECT 1 FROM "LiveChannelRun" WHERE "encoderRestartCount" <> 0';
		const guardEnd = sql.indexOf("END $$;");
		const feederDrop = sql.indexOf(
			'ALTER TABLE "FeederSession" DROP COLUMN "restartCount";',
		);
		const runDrop = sql.indexOf(
			'ALTER TABLE "LiveChannelRun" DROP COLUMN "encoderRestartCount";',
		);

		expect(sql).toContain(feederGuard);
		expect(sql).toContain(runGuard);
		expect(sql).toMatch(
			/RAISE EXCEPTION 'schema drift repair refused:[^']*restartCount/,
		);
		expect(sql).toMatch(
			/RAISE EXCEPTION 'schema drift repair refused:[^']*encoderRestartCount/,
		);
		expect(guardEnd).toBeGreaterThan(sql.indexOf(feederGuard));
		expect(guardEnd).toBeGreaterThan(sql.indexOf(runGuard));
		expect(feederDrop).toBeGreaterThan(guardEnd);
		expect(runDrop).toBeGreaterThan(guardEnd);
	});

	it("renames the four PostgreSQL-truncated objects to Prisma's 63-byte names", () => {
		const sql = migrationSql();
		const expectedRenames = [
			'ALTER INDEX "LiveChannelRun_providerTerminalAt_providerFeederStopsEnqueuedAt" RENAME TO "LiveChannelRun_providerTerminalAt_providerFeederStopsEnqueu_idx";',
			'ALTER INDEX "VerificationLiveEvidence_verificationRunId_scenario_liveChan_ke" RENAME TO "VerificationLiveEvidence_verificationRunId_scenario_liveCha_key";',
			'ALTER INDEX "VerificationResourceIntentEvent_verificationResourceIntentId_se" RENAME TO "VerificationResourceIntentEvent_verificationResourceIntentI_key";',
			'ALTER TABLE "VerificationResourceIntentEvent" RENAME CONSTRAINT "VerificationResourceIntentEvent_verificationResourceIntentId_fk" TO "VerificationResourceIntentEvent_verificationResourceIntent_fkey";',
		];

		for (const statement of expectedRenames) {
			expect(sql).toContain(statement);
		}
		const executableSql = sql
			.replace(/--.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(executableSql.match(/\bRENAME\b/g)).toHaveLength(4);
	});

	it("allows only the four immutable legacy identifiers above PostgreSQL's 63-byte limit", () => {
		const overlong = readdirSync(migrationsPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => {
				const sql = readFileSync(
					join(migrationsPath, entry.name, "migration.sql"),
					"utf8",
				)
					.replace(/--.*$/gm, "")
					.replace(/\/\*[\s\S]*?\*\//g, "");
				return [...sql.matchAll(/"([^"]+)"/g)]
					.map((match) => match[1])
					.filter(
						(identifier): identifier is string => identifier !== undefined,
					)
					.filter((identifier) => Buffer.byteLength(identifier, "utf8") > 63)
					.map((identifier) => `${entry.name}:${identifier}`);
			})
			.sort();

		expect(overlong).toEqual(
			[
				"20260830060000_live_run_provider_lifecycle:LiveChannelRun_providerTerminalAt_providerFeederStopsEnqueuedAt_idx",
				"20260830110000_verification_live_evidence:VerificationLiveEvidence_verificationRunId_scenario_liveChan_key",
				"20260830120000_verification_resource_intent:VerificationResourceIntentEvent_verificationResourceIntentId_fkey",
				"20260830120000_verification_resource_intent:VerificationResourceIntentEvent_verificationResourceIntentId_sequence_key",
			].sort(),
		);
	});
});

describe("LiveChannelRun heartbeat summary (heartbeat retention 7 days)", () => {
	const sql = readFileSync(
		join(
			__dirname,
			"../prisma/migrations/20260902120000_live_run_heartbeat_summary/migration.sql",
		),
		"utf8",
	);

	it("carries the nullable summary column and its DateTime write-once lock", () => {
		const body = block("model", "LiveChannelRun");
		expect(body).toMatch(/^\s{2}heartbeatSummary\s+Json\?$/m);
		expect(body).toMatch(/^\s{2}heartbeatSummaryAt\s+DateTime\?$/m);
		// A revive clears the lock WITH endedAt — the seam the summarizer keys
		// on is the DateTime, never a Json-null sentinel.
		expect(body).not.toMatch(/heartbeatSummaryAt\s+DateTime\s+@default/);
	});

	it("ships both columns additively and nullable, with no backfill", () => {
		expect(sql).toContain('ADD COLUMN "heartbeatSummary" JSONB');
		expect(sql).toContain('ADD COLUMN "heartbeatSummaryAt" TIMESTAMP(3)');
		const executable = sql
			.replace(/--.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(executable).not.toMatch(/\bUPDATE\b|\bNOT NULL\b|\bDEFAULT\b/);
	});
});
