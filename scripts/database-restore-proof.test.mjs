import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { proveDatabaseRestore } from "./database-restore-proof.mjs";

const id = "0123456789abcdef0123456789abcdef";
const digest = "a".repeat(64);
const snapshot = () => ({
	schemaSha256: digest,
	tables: [
		"BitmovinAccount",
		"CreateRequest",
		"Credential",
		"EncodingJob",
		"LiveChannel",
		"Membership",
		"Organization",
		"User",
	].map((name) => ({ name, rows: 1, sha256: digest })),
});

function fixture(options = {}) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-restore-proof-test-"));
	const calls = [];
	const primarySnapshot = snapshot();
	const secondarySnapshot = { ...snapshot(), schemaSha256: "b".repeat(64) };
	let primaryReads = 0;
	let secondaryReads = 0;
	const compose = (side) => async (args) => {
		calls.push({ side, args });
		if (args[0] === "ps")
			return (side === "primary" || options.sameContainer ? "1" : "2").repeat(
				64,
			);
		const script = args[5] ?? "";
		if (script.includes("exec pg_dump")) {
			if (options.fail === "dump") throw new Error("private database secret");
			return "";
		}
		if (args[0] === "cp") {
			if (side === "primary") writeFileSync(args[2], "private dump bytes");
			else {
				assert.equal(statSync(args[1]).mode & 0o777, 0o600);
				if (options.fail === "copy") throw new Error("private database secret");
			}
			return "";
		}
		if (script.includes("exec psql")) {
			const sql = args.at(-1);
			if (sql.includes("pg_database")) return options.existing ? "1" : "0";
			let value;
			if (side === "primary") {
				value = structuredClone(primarySnapshot);
				if (++primaryReads > 1 && options.sourceChanged) value.tables[0].rows++;
				if (options.empty) value.tables[0].rows = 0;
			} else if (args.at(-2).startsWith("bitovp_restore_")) {
				value = structuredClone(primarySnapshot);
				if (options.changedRows) value.tables[3].sha256 = "c".repeat(64);
				if (options.changedSchema) value.schemaSha256 = "c".repeat(64);
			} else {
				value = structuredClone(secondarySnapshot);
				if (++secondaryReads > 1 && options.secondaryChanged)
					value.tables[0].rows++;
			}
			return JSON.stringify(value);
		}
		if (script.includes("exec createdb") && options.fail === "create")
			throw new Error("private database secret");
		if (script.includes("exec pg_restore") && options.fail === "restore")
			throw new Error("private database secret");
		if (script.includes("exec dropdb") && options.fail === "cleanup")
			throw new Error("private database secret");
		if (
			args[3] === "rm" &&
			side === "primary" &&
			options.fail === "primary removal"
		)
			throw new Error("private database secret");
		return "";
	};
	return {
		directory,
		calls,
		primary: compose("primary"),
		secondary: compose("secondary"),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

function assertCleaned(f, database = true) {
	assert.deepEqual(readdirSync(f.directory), []);
	const cleanup = f.calls.filter((call) => call.args.includes("rm"));
	assert.equal(cleanup.length, 2);
	assert(
		cleanup.every(
			(call) => call.args.at(-1) === `/tmp/bitovp-restore-${id}.dump`,
		),
	);
	const drop = f.calls.filter((call) => call.args[5]?.includes("exec dropdb"));
	assert.equal(drop.length, Number(database));
	if (database) {
		assert.equal(drop[0].side, "secondary");
		assert.equal(drop[0].args.at(-1), `bitovp_restore_${id}`);
	}
}

test("restores a private dump into a new database and compares every table and schema", async () => {
	const f = fixture();
	try {
		const result = await proveDatabaseRestore({ id, ...f });
		assert.equal(result.tables, 8);
		assert.equal(result.rows, 8);
		assert.match(result.sha256, /^[a-f0-9]{64}$/);
		assert.equal(result.schemaSha256, digest);
		const dump = f.calls.find((call) => call.args[5]?.includes("exec pg_dump"));
		assert(dump.args[5].includes("--format=custom"));
		assert(!dump.args[5].includes("--no-acl"));
		const restore = f.calls.find((call) =>
			call.args[5]?.includes("exec pg_restore"),
		);
		assert(restore.args[5].includes("--exit-on-error"));
		assert.equal(restore.side, "secondary");
		assert.equal(restore.args.at(-2), `bitovp_restore_${id}`);
		assertCleaned(f);
	} finally {
		f.cleanup();
	}
});

for (const option of [
	"changedRows",
	"changedSchema",
	"sourceChanged",
	"secondaryChanged",
]) {
	test(`rejects ${option} instead of claiming a restore match`, async () => {
		const f = fixture({ [option]: true });
		try {
			await assert.rejects(
				proveDatabaseRestore({ id, ...f }),
				/restore proof failed/,
			);
			assertCleaned(f);
		} finally {
			f.cleanup();
		}
	});
}

for (const fail of [
	"dump",
	"copy",
	"create",
	"restore",
	"cleanup",
	"primary removal",
]) {
	test(`cleans owned artifacts after ${fail} failure and keeps diagnostics private`, async () => {
		const f = fixture({ fail });
		try {
			await assert.rejects(proveDatabaseRestore({ id, ...f }), (error) => {
				assert.match(error.message, /restore proof failed/);
				assert(!String(error.stack).includes("private database secret"));
				return true;
			});
			assertCleaned(
				f,
				["create", "restore", "cleanup", "primary removal"].includes(fail),
			);
		} finally {
			f.cleanup();
		}
	});
}

test("refuses an existing destination database without dropping it", async () => {
	const f = fixture({ existing: true });
	try {
		await assert.rejects(
			proveDatabaseRestore({ id, ...f }),
			/restore proof failed/,
		);
		assertCleaned(f, false);
		assert(!f.calls.some((call) => call.args[5]?.includes("exec pg_dump")));
	} finally {
		f.cleanup();
	}
});

test("refuses empty fixtures and the same PostgreSQL container", async () => {
	for (const options of [{ empty: true }, { sameContainer: true }]) {
		const f = fixture(options);
		try {
			await assert.rejects(
				proveDatabaseRestore({ id, ...f }),
				/restore proof failed/,
			);
			assert.deepEqual(readdirSync(f.directory), []);
			assert(!f.calls.some((call) => call.args[5]?.includes("exec createdb")));
		} finally {
			f.cleanup();
		}
	}
});

test("rejects unsafe identities and non-private directories before executing commands", async () => {
	const f = fixture();
	try {
		await assert.rejects(proveDatabaseRestore({ id: "../unsafe", ...f }));
		chmodSync(f.directory, 0o755);
		await assert.rejects(proveDatabaseRestore({ id, ...f }));
		assert.equal(f.calls.length, 0);
		assert(existsSync(f.directory));
	} finally {
		f.cleanup();
	}
});
