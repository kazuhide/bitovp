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
				"src/vmaf/banding-resources.test.ts": 3,
				"src/vmaf/processor.test.ts": 255,
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
				"src/vmaf/resource-admission.property.test.ts": 4,
				"src/vmaf/supervised-runner.test.ts": 4,
				"src/feeder/process-runner-abort.test.ts": 20,
				"src/vmaf/deadline.test.ts": 5,
				"src/vmaf/deadline.property.test.ts": 2,
			},
		},
		{
			id: "access-isolation",
			workspace: "@bitovp/web",
			directory: "apps/web",
			description: "Role enforcement and authenticated tenant context",
			files: {
				"src/proxy.roles.test.ts": 101,
				"src/lib/auth/tenancy.test.ts": 15,
			},
		},
		{
			id: "submission-idempotency",
			workspace: "@bitovp/web",
			directory: "apps/web",
			description:
				"VOD, Live and single-pass feeder creation and request identity",
			files: {
				"src/lib/server/create-request.test.ts": 11,
				"src/app/api/encoding-jobs/route.test.ts": 71,
				"src/app/api/live-channels/route.test.ts": 92,
				"src/app/api/feeder-sessions/route.test.ts": 50,
			},
		},
		{
			id: "vod-timeline",
			workspace: "@bitovp/web",
			directory: "apps/web",
			description: "Independent track edits, snapping and packaging output",
			files: {
				"src/app/vod/new/input-timeline-output.test.ts": 4,
				"src/app/vod/new/input-timeline/av-overwrite-editor.test.tsx": 8,
				"src/app/vod/new/input-timeline/timeline-snapping.test.ts": 43,
			},
		},
		{
			id: "live-lifecycle",
			workspace: "@bitovp/worker",
			directory: "apps/worker",
			description:
				"Live run ownership, provider observations and startup cancellation",
			files: {
				"src/live/startup-cancel.test.ts": 2,
				"src/live/provider-lifecycle.test.ts": 50,
			},
		},
		{
			id: "library-render-recovery",
			workspace: "@bitovp/worker",
			directory: "apps/worker",
			description:
				"Library composition, derivative ownership and render recovery",
			files: {
				"src/library-editing/sweep-composition.test.ts": 18,
				"src/library-editing/derivatives.test.ts": 5,
			},
		},
	].map((f) =>
		Object.freeze({
			...f,
			files: Object.freeze(f.files),
			requiresDatabaseClient: f.workspace !== "@bitovp/core",
			scope: "unit-contract",
			timeoutMs: 120000,
			prerequisites: [
				"Node >=24",
				"pinned pnpm installed",
				"workspace dependencies installed",
				...(f.workspace !== "@bitovp/core" ? ["generated Prisma client"] : []),
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
