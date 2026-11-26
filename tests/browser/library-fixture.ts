import assert from "node:assert/strict";

export const LIBRARY_CONTENT = "77777777-7777-4777-8777-777777777777";
export const LIBRARY_SOURCE = "88888888-8888-4888-8888-888888888888";
export const LIBRARY_TITLE = "Synthetic Library archive fixture";

/** Seed only the disposable installation, after its administrator has been created. */
export function seedLibraryRemovalFixture(
	fixture: { id: string; postgresContainer: string },
	docker: (args: string[]) => string,
) {
	assert.match(fixture.id, /^[a-f0-9]{32}$/);
	assert.match(fixture.postgresContainer, /^[a-f0-9]{64}$/);
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
		"--command",
		`BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Membership" WHERE "organizationId" = '00000000-0000-4000-8000-000000000001' AND role = 'ADMIN') THEN
    RAISE EXCEPTION 'Library fixture requires completed administrator bootstrap';
  END IF;
END $$;
INSERT INTO "LibrarySource" (id, "organizationId", "sourceKey", "originalJobId", "encodingId", "accountId", snapshot, locales, state, "updatedAt")
VALUES ('${LIBRARY_SOURCE}', '00000000-0000-4000-8000-000000000001', 'synthetic-browser-library-removal',
  '55555555-5555-4555-8555-555555555555', 'synthetic-no-provider-encoding', '66666666-6666-4666-8666-666666666666',
  '{"schemaVersion":1,"kind":"VOD_JOB","name":"${LIBRARY_TITLE}","planHash":"synthetic-fixture","identity":"UNVERIFIED","inputs":[],"playbackLinks":[],"qcVerdict":null,"qcOverriddenAt":null}', '{}', 'READY', now());
INSERT INTO "Content" (id, "organizationId", "registrationKey", title, tags, locale, "updatedAt")
VALUES ('${LIBRARY_CONTENT}', '00000000-0000-4000-8000-000000000001', '${LIBRARY_SOURCE}', '${LIBRARY_TITLE}', '{}', 'und', now());
INSERT INTO "ContentRevision" (id, "organizationId", "contentId", revision, "sourceId", title, description, tags, locale)
VALUES ('99999999-9999-4999-8999-999999999999', '00000000-0000-4000-8000-000000000001', '${LIBRARY_CONTENT}', 1, '${LIBRARY_SOURCE}', '${LIBRARY_TITLE}', '', '{}', 'und');
COMMIT;`,
	]);
}
