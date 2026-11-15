import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = ts.createSourceFile(
	"live-processor.ts",
	readFileSync(
		fileURLToPath(new URL("./live-processor.ts", import.meta.url)),
		"utf8",
	),
	ts.ScriptTarget.Latest,
	true,
);

function findFunction(name: string): string {
	let result: string | undefined;
	function visit(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name)
			result = node.getText(source);
		ts.forEachChild(node, visit);
	}
	visit(source);
	if (!result) throw new Error(`Missing actual Live function ${name}`);
	return result;
}

// Execute the actual failure helper, cleanup helper and each dispatcher catch /
// finally in an isolated Node process. Vitest's unhandled-rejection listener
// would otherwise keep alive the process that production Node must terminate.
const branches: { action: string; catchFinally: string }[] = [];
function collectBranches(node: ts.Node) {
	if (
		ts.isTryStatement(node) &&
		node.catchClause &&
		node.finallyBlock?.getText(source).includes("await acknowledgeResetEffect(")
	) {
		let parent: ts.Node | undefined = node.parent;
		while (parent && !ts.isCaseClause(parent)) parent = parent.parent;
		if (!parent || !ts.isCaseClause(parent))
			throw new Error("Live cleanup has no dispatcher action");
		branches.push({
			action: parent.expression.getText(source),
			catchFinally: `${node.catchClause.getText(source)} finally ${node.finallyBlock.getText(source)}`,
		});
	}
	ts.forEachChild(node, collectBranches);
}
collectBranches(source);

describe("Live effect rejection ownership across asynchronous cleanup", () => {
	it("covers every durable action with reset-effect cleanup", () => {
		expect(branches.map(({ action }) => action)).toEqual([
			'"stop"',
			'"restart"',
			'"update-rtmp-ingest"',
			'"update-auto-shutdown"',
			'"reset-timeshift"',
			'"scte35"',
			'"insert-content"',
			'"register-slate-content"',
			'"feeder-start"',
			'"feeder-switch"',
			'"feeder-commit"',
		]);
	});

	it.each(
		branches,
	)("keeps $action failure owned until its deferred database cleanup finishes", ({
		catchFinally,
	}) => {
		const program = `
import assert from "node:assert/strict";
const state = { claim: "SENDING", outcome: "UNKNOWN", cleanupComplete: false, caughtOriginal: false };
class AisaLiveFinalizationPendingError extends Error {
  constructor() { super("AISA_LIVE_FINALIZATION_PENDING"); }
}
const failure = new AisaLiveFinalizationPendingError();
const job = { effect: { scheduleId: "synthetic-schedule" } };
const prepared = { fence: { crossedSendBoundary: true, claim: { id: "synthetic-claim" } } };
const deps = {
  now: () => new Date().toISOString(),
  acknowledgeResetEntity: async () => { throw new Error("A retained claim must not be acknowledged"); },
  prisma: { liveEffectClaim: { findUnique: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    state.cleanupComplete = true;
    return { id: prepared.fence.claim.id };
  } } },
};
const redactSecrets = value => value;
const markLiveEffectAmbiguous = async () => {
  await Promise.resolve();
  state.claim = "AMBIGUOUS";
};
const markLiveEffectFailed = async () => { throw new Error("The send boundary was crossed"); };
const recordScheduleOutcomeBestEffort = async () => { throw new Error("Pending finalization must rethrow its original error"); };
const effectResult = () => { throw new Error("Pending finalization must not return success"); };
${findFunction("failLiveEffect")}
${findFunction("acknowledgeResetEffect")}
async function dispatch() {
  try { throw failure; } ${catchFinally}
}
// Like BullMQ, the boundary handles the returned processor Promise at once.
dispatch().then(
  () => { throw new Error("The job must reject"); },
  error => {
    assert.equal(error, failure);
    assert.equal(state.claim, "AMBIGUOUS");
    assert.equal(state.outcome, "UNKNOWN");
    assert.equal(state.cleanupComplete, true);
    state.caughtOriginal = true;
    console.log(JSON.stringify(state));
  },
);
`;
		const child = spawnSync(
			process.execPath,
			[
				"--unhandled-rejections=strict",
				"--input-type=module",
				"--eval",
				ts.transpileModule(program, {
					compilerOptions: { target: ts.ScriptTarget.ES2022 },
				}).outputText,
			],
			{
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
				timeout: 5000,
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.signal).toBeNull();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({
			claim: "AMBIGUOUS",
			outcome: "UNKNOWN",
			cleanupComplete: true,
			caughtOriginal: true,
		});
	});
});
