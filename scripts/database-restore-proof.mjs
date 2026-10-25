import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const REQUIRED = [
	"BitmovinAccount",
	"CreateRequest",
	"Credential",
	"EncodingJob",
	"LiveChannel",
	"Membership",
	"Organization",
	"User",
];

// Only hashes and counts leave PostgreSQL. Full rows include encrypted secrets,
// stored plans, receipts and step logs; schema hashes include RLS and grants.
// DROP COLUMN leaves ordinal gaps that pg_dump removes. Dense visible ordinals
// preserve column order without treating those physical gaps as schema drift.
const SNAPSHOT_SQL = `
SET TIME ZONE 'UTC';
CREATE TEMP TABLE restore_proof_snapshot(name text PRIMARY KEY, rows bigint, sha256 text);
DO $snapshot$
DECLARE item record; row_count bigint; row_hash text;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    EXECUTE format(
      'SELECT count(*), encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), ''[]''::jsonb)::text, ''UTF8'')), ''hex'') FROM public.%I AS r',
      item.tablename) INTO row_count, row_hash;
    INSERT INTO restore_proof_snapshot VALUES(item.tablename, row_count, row_hash);
  END LOOP;
END $snapshot$;
WITH objects AS (
  SELECT jsonb_build_array('column', table_name, column_name,
    row_number() OVER (PARTITION BY table_name ORDER BY ordinal_position), is_nullable,
    data_type, udt_name, column_default, character_maximum_length, numeric_precision, numeric_scale) AS value
    FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL SELECT jsonb_build_array('table', c.relname, c.relrowsecurity, c.relforcerowsecurity)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  UNION ALL SELECT jsonb_build_array('policy', to_jsonb(p)) FROM pg_policies p WHERE schemaname = 'public'
  UNION ALL SELECT jsonb_build_array('index', indexname, indexdef) FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL SELECT jsonb_build_array('constraint', c.relname, con.conname, pg_get_constraintdef(con.oid))
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL SELECT jsonb_build_array('trigger', pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL SELECT jsonb_build_array('function', pg_get_functiondef(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
  UNION ALL SELECT jsonb_build_array('enum', t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder))
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' GROUP BY t.typname
  UNION ALL SELECT jsonb_build_array('grant', c.relname, pg_get_userbyid(a.grantor),
    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
    LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
)
SELECT jsonb_build_object(
  'tables', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY name), '[]'::jsonb) FROM restore_proof_snapshot s),
  'schemaSha256', (SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(value ORDER BY value::text), '[]'::jsonb)::text, 'UTF8')), 'hex') FROM objects)
)::text;
`;

const PSQL =
	'database="$1"; if [ -z "$database" ]; then database="$POSTGRES_DB"; fi; export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --no-psqlrc --username="$POSTGRES_USER" --dbname="$database" --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 --command="$2"';
const exec = (compose, script, ...args) =>
	compose([
		"exec",
		"-T",
		"postgres",
		"sh",
		"-ceu",
		script,
		"restore-proof",
		...args,
	]);
const query = (compose, database, sql) => exec(compose, PSQL, database, sql);

async function snapshot(compose, database = "") {
	const value = JSON.parse(await query(compose, database, SNAPSHOT_SQL));
	assert.match(value.schemaSha256, /^[a-f0-9]{64}$/);
	assert(Array.isArray(value.tables) && value.tables.length > 0);
	const names = new Set();
	for (const table of value.tables) {
		assert(typeof table.name === "string" && !names.has(table.name));
		names.add(table.name);
		assert(Number.isSafeInteger(table.rows) && table.rows >= 0);
		assert.match(table.sha256, /^[a-f0-9]{64}$/);
	}
	return value;
}

// The caller verifies Compose ownership and stops all fixture writers first.
// This proves fixture data/schema restoration, not a production rollback.
export async function proveDatabaseRestore({
	id,
	directory,
	primary,
	secondary,
}) {
	assert.match(id, /^[a-f0-9]{32}$/);
	assert(isAbsolute(directory));
	assert(lstatSync(directory).isDirectory());
	assert(
		!(statSync(directory).mode & 0o077),
		"Fixture directory must be private",
	);
	assert(typeof primary === "function" && typeof secondary === "function");
	assert.notEqual(primary, secondary);
	const privateDirectory = mkdtempSync(
		join(realpathSync(directory), "restore-"),
	);
	const localDump = join(privateDirectory, "database.dump");
	const containerDump = `/tmp/bitovp-restore-${id}.dump`;
	const database = `bitovp_restore_${id}`;
	let containersVerified = false;
	let databaseAttempted = false;
	let failed = false;
	let cleanupFailed = false;
	let stage = "fixture verification";
	let result;
	try {
		const primaryId = await primary(["ps", "--all", "--quiet", "postgres"]);
		const secondaryId = await secondary(["ps", "--all", "--quiet", "postgres"]);
		assert.match(primaryId, /^[a-f0-9]{64}$/);
		assert.match(secondaryId, /^[a-f0-9]{64}$/);
		assert.notEqual(primaryId, secondaryId);
		containersVerified = true;
		const original = await snapshot(primary);
		for (const name of REQUIRED)
			assert(
				original.tables.some((table) => table.name === name && table.rows > 0),
			);
		const independent = await snapshot(secondary);
		assert.equal(
			await query(
				secondary,
				"",
				`SELECT count(*) FROM pg_database WHERE datname = '${database}'`,
			),
			"0",
		);
		stage = "backup";
		await exec(
			primary,
			'umask 077; export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --file="$1"',
			containerDump,
		);
		await primary(["cp", `postgres:${containerDump}`, localDump]);
		assert(lstatSync(localDump).isFile() && statSync(localDump).size > 0);
		chmodSync(localDump, 0o600);
		await secondary(["cp", localDump, `postgres:${containerDump}`]);
		stage = "isolated restore";
		databaseAttempted = true;
		await exec(
			secondary,
			'export PGPASSWORD="$POSTGRES_PASSWORD"; exec createdb --username="$POSTGRES_USER" --template=template0 "$1"',
			database,
		);
		await exec(
			secondary,
			'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --username="$POSTGRES_USER" --dbname="$1" --exit-on-error --no-owner "$2"',
			database,
			containerDump,
		);
		stage = "restored data and schema comparison";
		assert.deepEqual(await snapshot(secondary, database), original);
		assert.deepEqual(await snapshot(primary), original);
		assert.deepEqual(await snapshot(secondary), independent);
		result = {
			tables: original.tables.length,
			rows: original.tables.reduce((sum, table) => sum + table.rows, 0),
			sha256: createHash("sha256")
				.update(JSON.stringify(original))
				.digest("hex"),
			schemaSha256: original.schemaSha256,
		};
	} catch {
		failed = true;
	} finally {
		const clean = async (operation) => {
			try {
				await operation();
			} catch {
				cleanupFailed = true;
			}
		};
		if (databaseAttempted)
			await clean(() =>
				exec(
					secondary,
					'export PGPASSWORD="$POSTGRES_PASSWORD"; exec dropdb --username="$POSTGRES_USER" --if-exists --force "$1"',
					database,
				),
			);
		if (containersVerified)
			for (const compose of [primary, secondary])
				await clean(() =>
					compose(["exec", "-T", "postgres", "rm", "-f", "--", containerDump]),
				);
		await clean(() =>
			rmSync(privateDirectory, { recursive: true, force: true }),
		);
	}
	if (failed || cleanupFailed)
		throw new Error(
			`Database restore proof failed at ${cleanupFailed ? "cleanup" : stage}; fixture diagnostics are private`,
		);
	return result;
}
