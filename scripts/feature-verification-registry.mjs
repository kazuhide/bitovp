/** Fixed, inexpensive source contracts. Counts change only through review. */
export const FEATURES = Object.freeze(
	[
		{
			id: "qc-resource-allocation",
			workspace: "@bitovp/worker",
			directory: "apps/worker",
			description: "QC memory/thread planning and detector reservations",
			files: {
				"src/vmaf/resource-plan.test.ts": 12,
				"src/vmaf/banding-resources.test.ts": 2,
				"src/vmaf/processor.test.ts": 254,
			},
		},
		{
			id: "qc-measurement-validity",
			workspace: "@bitovp/core",
			directory: "packages/core",
			description: "HDR protocol constraints and synthetic frame alignment",
			files: { "src/vmaf/hdr.test.ts": 24, "src/vmaf/align.test.ts": 15 },
		},
		{
			id: "qc-runtime-safety",
			workspace: "@bitovp/worker",
			directory: "apps/worker",
			description:
				"Admission cancellation, absolute deadlines and process lifetime",
			files: {
				"src/vmaf/resource-admission.test.ts": 10,
				"src/vmaf/supervised-runner.test.ts": 4,
				"src/feeder/process-runner-abort.test.ts": 19,
				"src/vmaf/deadline.test.ts": 5,
			},
		},
	].map((f) =>
		Object.freeze({
			...f,
			files: Object.freeze(f.files),
			scope: "unit-contract",
			timeoutMs: 120000,
			prerequisites: [
				"Node >=24",
				"pinned pnpm installed",
				"workspace dependencies installed",
			],
			effects:
				"Runs fixed local tests; writes only test scratch and the requested evidence directory. No application launch or provider verification.",
		}),
	),
);
export function feature(id) {
	const result = FEATURES.find((f) => f.id === id);
	if (!result) throw new Error("UNKNOWN_FEATURE");
	return result;
}
