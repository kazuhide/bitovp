import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RESET_DELETES,
	RESET_KEEPS,
	RESET_PRESERVES,
	RESET_SCOPED_DELETES,
} from "@/lib/server/reset";

/**
 * The reset's promise — "configuration survives" — is a claim about ROWS, and
 * every instrument we had asked about CALLS.
 *
 * review-265 130-B1: `AlertRule` is in RESET_KEEPS, and `AlertRule.liveChannel`
 * carries `onDelete: Cascade` (schema.prisma:418, from migration
 * 20260813070000). Step 13's `liveChannel.deleteMany({})` therefore destroyed
 * every channel-scoped alert rule — silently, in Postgres, with no
 * `alertRule.deleteMany` call anywhere in our code. `route.test.ts` asserts
 * survival by checking that `prisma.alertRule.deleteMany` was NOT called
 * against a mock, so it was green while the rows died. The instrument's scope
 * was our call log; the property was row survival; a mock cannot bridge that.
 *
 * This file bridges it statically, and deliberately asks a WIDER question than
 * the defect that prompted it. Not "is there an unhandled cascade" but: does
 * any KEPT model reference a DELETED one AT ALL? Every referential action is a
 * different way for the same authoring mistake to bite —
 *
 *   Cascade  → kept rows are destroyed (the bug found)
 *   SetNull  → kept rows SURVIVE with a field silently rewritten; for
 *              AlertRule that would promote a channel rule to a global one,
 *              which then fires on every future channel
 *   Restrict → the delete throws a foreign-key violation and the whole reset
 *              rolls back, i.e. the feature stops working
 *
 * An allowlist of one action would have let the other two through. Any such
 * edge must be DECLARED in RESET_SCOPED_DELETES, which is what the dialog and
 * the audit row read.
 */
const SCHEMA = join(
	__dirname,
	"../../../../../packages/db/prisma/schema.prisma",
);

type Edge = { from: string; field: string; to: string; action: string };

/** `Model` → `model` — Prisma's client property naming. */
const clientKey = (model: string) =>
	model.charAt(0).toLowerCase() + model.slice(1);

/**
 * Every relation field in the schema, as (holder → target).
 *
 * A relation FIELD is the one carrying `@relation(fields: [...])` — the side
 * that owns the foreign key, and therefore the side a delete of the target
 * acts upon. The back-reference (`AlertEvent[]`) has no `fields:` and is
 * skipped; counting it would invert half the graph.
 */
function relationEdges(): Edge[] {
	const src = readFileSync(SCHEMA, "utf8");
	const edges: Edge[] = [];
	let model: string | null = null;
	for (const line of src.split("\n")) {
		const start = /^model\s+(\w+)\s*\{/.exec(line);
		if (start) {
			model = start[1] ?? null;
			continue;
		}
		if (/^\}/.test(line)) {
			model = null;
			continue;
		}
		if (!model || !line.includes("@relation(") || !line.includes("fields:")) {
			continue;
		}
		const field = /^\s*(\w+)\s+(\w+)/.exec(line);
		const name = field?.[1];
		const target = field?.[2];
		if (!name || !target) {
			continue;
		}
		const action = /onDelete:\s*(\w+)/.exec(line)?.[1];
		edges.push({
			from: model,
			field: name,
			to: target,
			// Prisma's documented default when onDelete is omitted: SetNull for
			// an optional relation, Restrict for a required one. Named rather
			// than left blank so the table below is readable as the real
			// behaviour.
			action:
				action ??
				(line.includes("?") ? "SetNull (default)" : "Restrict (default)"),
		});
	}
	return edges;
}

describe("the reset's kept half cannot be destroyed by a foreign key", () => {
	it("finds the relation graph at all — a parser that matches nothing proves nothing", () => {
		const edges = relationEdges();
		expect(edges.length).toBeGreaterThan(20);
		// The edge this file exists for, spelled out: if the schema stops
		// matching this shape, the scan silently goes blind and every
		// assertion below passes vacuously.
		expect(
			edges.find((e) => e.from === "AlertRule" && e.to === "LiveChannel"),
		).toEqual({
			from: "AlertRule",
			field: "liveChannel",
			to: "LiveChannel",
			action: "Cascade",
		});
	});

	it("every KEEP→DELETE edge is declared, with its scoped delete implemented", () => {
		const keeps = new Set<string>([...RESET_KEEPS, ...RESET_PRESERVES]);
		const deletes = new Set<string>(RESET_DELETES);
		const crossing = relationEdges().filter(
			(e) => keeps.has(clientKey(e.from)) && deletes.has(clientKey(e.to)),
		);
		// The hazard this file exists for is a KEPT row being DESTROYED by a
		// foreign key: that is a Cascade. A SetNull edge cannot destroy the
		// kept row — the reset's delete nulls the pointer and the row stays —
		// so it needs no scoped delete; it is listed below so a new one is
		// still a reviewed fact rather than a silent pass. (WP-G G-2 added the
		// first two: WebhookRegistration must survive the job/run deletes so
		// the worker can still remove each hook at the provider; the first
		// draft of this test required a scoped delete for every crossing edge,
		// which would have deleted exactly the index that cleanup needs.)
		const destructive = crossing.filter((e) => e.action !== "SetNull");
		// Declared edges, as (kept model → deleted model).
		const declared = new Set(
			RESET_SCOPED_DELETES.map((s) => `${s.model}→liveChannel`),
		);
		const undeclared = destructive.filter(
			(e) => !declared.has(`${clientKey(e.from)}→${clientKey(e.to)}`),
		);
		expect(
			undeclared.map((e) => `${e.from}.${e.field} → ${e.to} (${e.action})`),
		).toEqual([]);
		// And the declaration is not empty theatre: the destructive edge that
		// exists is the one that is declared, and the SetNull edges are exactly
		// those the registrar and library rely on.
		expect(
			crossing.map((e) => `${e.from}.${e.field} → ${e.to} (${e.action})`),
		).toEqual([
			"LibrarySource.job → EncodingJob (SetNull)",
			"AlertRule.liveChannel → LiveChannel (Cascade)",
			"WebhookRegistration.encodingJob → EncodingJob (SetNull)",
			"WebhookRegistration.liveChannelRun → LiveChannelRun (SetNull)",
		]);
	});

	it("the declared delete order is a valid topological sort — including the scoped delete", () => {
		// review-265 130-C5. B1 was not one bug: ELEVEN more DEL→DEL edges have
		// the same failure mode, and every one is Cascade or SetNull — so a
		// wrong order does NOT throw. It reports `manifestJob: 0` while Postgres
		// already took the rows, which is exactly B1, silently, in eleven more
		// slots. The mock-based pins cannot see any of them.
		//
		// The scoped delete is a first-class node here, standing in for its
		// model: `before: "liveChannel"` is a hand-maintained restatement of
		// something the schema already knows, and the ordering mistake this
		// file exists to catch has ALREADY happened once in exactly that spot.
		const position = new Map<string, number>();
		let index = 0;
		for (const model of RESET_DELETES) {
			for (const scoped of RESET_SCOPED_DELETES) {
				if (scoped.before === model) {
					position.set(scoped.model, index++);
				}
			}
			position.set(model, index++);
		}
		const violations: string[] = [];
		for (const edge of relationEdges()) {
			const from = clientKey(edge.from);
			const to = clientKey(edge.to);
			// A scoped delete stands in for its model's position.
			const child = position.get(from);
			const parent = position.get(to);
			if (child === undefined || parent === undefined) {
				continue;
			}
			if (child > parent) {
				violations.push(
					`${edge.from} (${child}) must be deleted before ${edge.to} (${parent})`,
				);
			}
		}
		expect(violations).toEqual([]);
	});

	// The partition itself — every schema model is in exactly one of the two
	// halves — is pinned in route.test.ts (130-A4) and not repeated here. This
	// file assumes that partition and asks what the EDGES between its halves
	// do.
});
