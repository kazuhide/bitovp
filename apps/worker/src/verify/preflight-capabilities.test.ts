import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialProvider } from "@bitovp/db";
import { describe, expect, it } from "vitest";
import { type Capability, capabilityOfProvider } from "./preflight";

/**
 * : the capability mapper compared a `string` parameter against
 * enum values that DO NOT EXIST (`AWS_S3_ROLE`, `AZURE`) — both branches
 * dead, so an Azure credential could never evidence the AZURE capability
 * and the corpus's Azure SKIPs would have outlived a working credential.
 *
 * Two layers keep it from recurring. The mapper is now an exhaustive
 * switch over the typed enum (a new member is a COMPILE error until
 * someone decides its capability). This test is the second layer, and the
 * one that names the gap in words: the member list is derived from
 * schema.prisma — the same derivation client.test.ts uses for encrypted
 * columns — so the expectation table below must name every member, and a
 * schema addition fails here with the missing member in the diff.
 */

function schemaMembers(): string[] {
	const schema = readFileSync(
		join(__dirname, "../../../../packages/db/prisma/schema.prisma"),
		"utf8",
	);
	const block = schema.match(/enum CredentialProvider \{([^}]*)\}/);
	if (!block?.[1]) {
		throw new Error("CredentialProvider enum not found in schema.prisma");
	}
	return block[1]
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("//"));
}

/**
 * Every member, decided. `undefined` entries are DECISIONS, not gaps —
 * each is annotated in the switch itself (NetStorage: evidencing off a
 * decrypt would mark unverifiable scenarios runnable; MSL: the capability
 * comes from provisioning config, not the vault; the rest are not storage).
 */
const EXPECTED: Record<CredentialProvider, Capability | undefined> = {
	AWS_S3: "S3",
	AWS_S3_ROLE_BASED: "S3",
	AKAMAI_OBJECT_STORAGE: "AKAMAI",
	OCI_OBJECT_STORAGE: "AKAMAI",
	GENERIC_S3: "AKAMAI",
	GCS_HMAC: "GCS",
	GCS_SERVICE_ACCOUNT: "GCS_SERVICE_ACCOUNT",
	AZURE_BLOB: "AZURE",
	SFTP: "SFTP",
	AKAMAI_NETSTORAGE: undefined,
	// 2026-08-23: MSL evidence became the provisioning-config arm (decrypt +
	// streamId/eventName) — the capability maps so the arm can run.
	LIVE_MEDIA_INGEST: undefined,
	AKAMAI_MSL: "AKAMAI_MSL",
	DRM_CENC: undefined,
	DRM_SPEKE: undefined,
	NEXGUARD: undefined,
	SRT_PASSPHRASE: undefined,
	ZIXI: undefined,
	POIS_ENDPOINT: undefined,
	KANTAR: "KANTAR",
	NOTIFICATION_WEBHOOK: undefined,
};

describe("capabilityOfProvider (ledger #111)", () => {
	it("the expectation table covers exactly the schema's members", () => {
		const members = schemaMembers();
		// Floor first: an empty parse would make the walk below vacuous.
		expect(members.length).toBeGreaterThan(10);
		expect(Object.keys(EXPECTED).sort()).toEqual([...members].sort());
	});

	it("maps every member as decided", () => {
		for (const [provider, capability] of Object.entries(EXPECTED)) {
			expect(
				capabilityOfProvider(provider as CredentialProvider),
				`capabilityOfProvider(${provider})`,
			).toBe(capability);
		}
	});

	it("the two #111 dead branches are alive: role-based AWS and Azure", () => {
		// These are the literals the if-chain compared against values the enum
		// never contained. Named individually so a regression reads as ITSELF,
		// not as one row of a table.
		expect(capabilityOfProvider("AWS_S3_ROLE_BASED")).toBe("S3");
		expect(capabilityOfProvider("AZURE_BLOB")).toBe("AZURE");
	});
});
