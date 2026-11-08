import type { PreparedLocalStoryFlowContextSource } from "./local-story-flow-context";
import { localStoryFlowContextSourceEvidence } from "./local-story-flow-context";
import {
	type BoundLocalStoryFlowContextTree,
	localStoryFlowContextTreeEvidence,
} from "./local-story-flow-context-tree";
import {
	type BoundLocalStoryFlowRouteStep,
	buildLocalStoryFlowRouteExpectation,
	localStoryFlowRouteStepEvidence,
} from "./local-story-flow-route";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_SCHEDULER_POLICY = Object.freeze({
	version: "local-story-flow-scheduler-policy-v1",
	choiceRule: "one-root-then-first-pending-witness-v1",
	frontierRule: "mandatory-first-source-order-depth-first-v1",
	branchRule: "retain-original-observation-recompute-force-v1",
	leafRule: "whole-page-exposure-before-finalize-v1",
	progressRule: "closure-seeds-navigation-terminal-without-observation-ids-v1",
	maxRouteSteps: 64,
});
export class LocalStoryFlowSchedulerError extends Error {
	constructor(
		readonly code:
			| "LOCAL_STORY_ARTIFACT_UNVERIFIED"
			| "LOCAL_STORY_FLOW_NO_PROGRESS"
			| "LOCAL_STORY_FLOW_BUDGET_EXHAUSTED"
			| "LOCAL_STORY_FLOW_ROUTE_NOT_READY",
	) {
		super(code);
		this.name = "LocalStoryFlowSchedulerError";
	}
}
function requireSchedule(
	value: unknown,
	code: LocalStoryFlowSchedulerError["code"] = "LOCAL_STORY_ARTIFACT_UNVERIFIED",
): asserts value {
	if (!value) throw new LocalStoryFlowSchedulerError(code);
}
function historySteps(value: unknown) {
	requireSchedule(
		Array.isArray(value) &&
			Object.getPrototypeOf(value) === Array.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const d = Object.getOwnPropertyDescriptors(value as object),
		length = d.length?.value;
	requireSchedule(
		Number.isSafeInteger(length) &&
			length >= 0 &&
			length <= 64 &&
			Object.keys(d).length === length + 1,
	);
	return Array.from({ length }, (_, i) => {
		const row = d[String(i)];
		requireSchedule(row?.enumerable && "value" in row);
		return row.value as BoundLocalStoryFlowRouteStep;
	});
}
/** Receipt/observation IDs alone do not count as new work. The source and core step are owned. */
export function localStoryFlowRouteProgressHash(
	source: PreparedLocalStoryFlowContextSource,
	step: BoundLocalStoryFlowRouteStep,
): string {
	const s = localStoryFlowContextSourceEvidence(source),
		e = localStoryFlowRouteStepEvidence(step);
	requireSchedule(
		e.expectation.input.sourceBindingHash === s.sourceBindingHash,
	);
	const navigation = e.after.navigation;
	const branches = s.layout.nodes.flatMap((node) => {
		const branch = navigation.branches.find((b) => b.nodeId === node.nodeId);
		return branch
			? [{ nodeId: node.nodeId, dispositions: branch.dispositions }]
			: [];
	});
	const pages = s.pages.flatMap((page) => {
		const exposed = navigation.exposedPages.find(
			(p) => p.pageId === page.pageId,
		);
		if (!exposed) return [];
		requireSchedule(
			exposed.pageHash === page.pageHash && exposed.dataHash === page.dataHash,
		);
		return [
			{
				pageId: page.pageId,
				events: page.data.items.flatMap((item) =>
					item.kind === "GROUNDED_LEAF_EVENT_CARD" ? [item.id] : [],
				),
			},
		];
	});
	return hash({
		closureStateHash: e.after.closure.structuralStateHash,
		seedsHash: hash(e.after.seeds),
		navigationSemanticState: { branches, pages },
		terminal: e.phase === "FINALIZE",
	});
}

/** Pure next-operation selection. It neither runs a model nor admits native or DB provenance. */
export function nextLocalStoryFlowRoute(options: {
	source: PreparedLocalStoryFlowContextSource;
	tree: BoundLocalStoryFlowContextTree;
	targetFrames: number;
	steps: readonly BoundLocalStoryFlowRouteStep[];
}) {
	try {
		requireSchedule(
			Object.getPrototypeOf(options) === Object.prototype &&
				Object.getOwnPropertySymbols(options).length === 0,
		);
		const d = Object.getOwnPropertyDescriptors(options);
		requireSchedule(
			Object.keys(d).sort().join(",") === "source,steps,targetFrames,tree" &&
				Object.values(d).every(
					(row) => row.enumerable && "value" in row && row.value !== undefined,
				),
		);
		const { source, tree, targetFrames } = Object.fromEntries(
			Object.entries(d).map(([name, row]) => [name, row.value]),
		) as typeof options;
		const steps = historySteps(d.steps?.value),
			s = localStoryFlowContextSourceEvidence(source),
			t = localStoryFlowContextTreeEvidence(tree, source);
		if (!steps.length)
			return {
				status: "NEXT" as const,
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					source,
					tree,
					targetFrames,
				}),
			};
		const evidence = steps.map(localStoryFlowRouteStepEvidence);
		for (const [index, e] of evidence.entries()) {
			requireSchedule(
				e.expectation.input.sourceBindingHash === s.sourceBindingHash &&
					e.expectation.input.treeHash === t.treeHash &&
					e.expectation.input.targetFrames === targetFrames,
			);
			requireSchedule(
				index === 0
					? e.phase === "ROOT" &&
							e.expectation.continuation.kind === "ROOT_START"
					: e.phase !== "ROOT" &&
							e.expectation.continuation.kind === "AFTER_STEP" &&
							e.expectation.continuation.previousStepHash ===
								evidence[index - 1]?.stepHash &&
							evidence[index - 1]?.phase !== "FINALIZE",
			);
			if (index > 0)
				requireSchedule(
					localStoryFlowRouteProgressHash(
						source,
						steps[index] as BoundLocalStoryFlowRouteStep,
					) !==
						localStoryFlowRouteProgressHash(
							source,
							steps[index - 1] as BoundLocalStoryFlowRouteStep,
						),
					"LOCAL_STORY_FLOW_NO_PROGRESS",
				);
		}
		const previousStep = steps.at(-1),
			last = evidence.at(-1);
		requireSchedule(previousStep && last);
		if (last.phase === "FINALIZE")
			return { status: "COMPLETE" as const, terminal: previousStep };
		requireSchedule(
			steps.length < LOCAL_STORY_FLOW_SCHEDULER_POLICY.maxRouteSteps,
			"LOCAL_STORY_FLOW_BUDGET_EXHAUSTED",
		);
		requireSchedule(
			last.rawOutput.unresolved.length === 0 &&
				last.after.closureResult.status !== "UNREACHED",
			"LOCAL_STORY_FLOW_ROUTE_NOT_READY",
		);
		if (last.after.closureResult.status === "PENDING_HARD_CHOICE")
			return {
				status: "NEXT" as const,
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "WITNESS",
					previousStep,
				}),
			};
		const required = new Set(
			last.after.closureResult.requiredEvents.map((e) => e.ref.eventId),
		);
		const requiredPages = new Set(
			s.pages
				.filter((p) =>
					p.data.items.some(
						(item) =>
							item.kind === "GROUNDED_LEAF_EVENT_CARD" && required.has(item.id),
					),
				)
				.map((p) => p.pageId),
		);
		const mandatory = (node: (typeof s.layout.nodes)[number]) =>
			s.pages
				.slice(node.pageFrom, node.pageToExclusive)
				.some((p) => requiredPages.has(p.pageId));
		const byId = new Map(s.layout.nodes.map((n) => [n.nodeId, n]));
		const navigation = last.after.navigation;
		function visit(
			nodeId: string,
			onlyMandatory: boolean,
		): { phase: "BRANCH" | "LEAF"; nodeId: string } | null {
			const node = byId.get(nodeId);
			requireSchedule(node);
			if (onlyMandatory && !mandatory(node)) return null;
			if (node.phase === "LEAF") {
				const page = s.pages.find((p) => p.pageId === node.pageId);
				requireSchedule(page);
				return navigation.exposedPages.some(
					(p) =>
						p.pageId === page.pageId &&
						p.pageHash === page.pageHash &&
						p.dataHash === page.dataHash,
				)
					? null
					: { phase: "LEAF", nodeId };
			}
			const branch = navigation.branches.find((b) => b.nodeId === nodeId);
			if (!branch) return { phase: "BRANCH", nodeId };
			for (const childId of node.children) {
				const child = byId.get(childId);
				requireSchedule(child);
				const raw = branch.dispositions.find((d) => d.child.nodeId === childId);
				requireSchedule(raw);
				if (mandatory(child) || raw.disposition === "DESCEND") {
					const candidate = visit(childId, onlyMandatory);
					if (candidate) return candidate;
				}
			}
			return null;
		}
		const next =
			visit(s.layout.rootNodeId, true) ?? visit(s.layout.rootNodeId, false);
		if (next)
			return {
				status: "NEXT" as const,
				expectation: buildLocalStoryFlowRouteExpectation({
					...next,
					previousStep,
				}),
			};
		requireSchedule(
			last.after.closureResult.status === "COMPLETE" &&
				required.size > 0 &&
				last.after.knownRequiredExposureGaps.length === 0,
			"LOCAL_STORY_FLOW_ROUTE_NOT_READY",
		);
		return {
			status: "NEXT" as const,
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "FINALIZE",
				previousStep,
			}),
		};
	} catch (error) {
		if (error instanceof LocalStoryFlowSchedulerError) throw error;
		throw new LocalStoryFlowSchedulerError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	}
}
