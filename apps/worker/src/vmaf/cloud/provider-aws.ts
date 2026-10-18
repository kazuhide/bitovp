import {
	BatchClient,
	DescribeJobDefinitionsCommand,
	DescribeJobsCommand,
	type JobDetail,
	ListJobsCommand,
	SubmitJobCommand,
	TerminateJobCommand,
} from "@aws-sdk/client-batch";
import type { VmafCloudProfile, VmafComputeAdapter } from "@bitovp/core";
import {
	launchSeconds,
	type RestDependencies,
	taskName,
	WORKER_COMMAND,
} from "./provider-common.js";

type Profile = Extract<VmafCloudProfile, { provider: "AWS_BATCH" }>;
export type AwsDependencies = RestDependencies & {
	awsClient?: Pick<BatchClient, "send">;
};

export function awsAdapter(
	profile: Profile,
	deps: AwsDependencies,
): VmafComputeAdapter {
	// A lost SubmitJob response is ambiguous: never let the SDK repeat creation.
	const client =
		deps.awsClient ??
		new BatchClient({ region: profile.region, maxAttempts: 1 });
	const owned = (job: JobDetail) => {
		if (
			job.tags?.["bitovp:vmaf-profile"] !== profile.id ||
			!job.tags?.["bitovp:vmaf-task"] ||
			job.jobName !== taskName(job.tags["bitovp:vmaf-task"])
		)
			throw new Error("Cloud job ownership mismatch");
		return job;
	};
	const read = async (id: string) => {
		if (!/^[a-zA-Z0-9:_/-]{1,512}$/.test(id))
			throw new Error("Invalid cloud job ID");
		const jobs =
			(
				await client.send(new DescribeJobsCommand({ jobs: [id] }), {
					abortSignal: AbortSignal.timeout(30_000),
				})
			).jobs ?? [];
		return jobs[0] ? owned(jobs[0]) : undefined;
	};
	const cancel = async (id: string) => {
		const job = await read(id);
		if (job && !["SUCCEEDED", "FAILED"].includes(job.status ?? ""))
			await client.send(
				new TerminateJobCommand({ jobId: id, reason: "VMAF task stopped" }),
				{ abortSignal: AbortSignal.timeout(30_000) },
			);
	};
	return {
		async submit(launch) {
			const seconds = launchSeconds(profile, launch, deps.now?.());
			const definitions =
				(
					await client.send(
						new DescribeJobDefinitionsCommand({
							jobDefinitions: [profile.jobDefinition],
							status: "ACTIVE",
						}),
						{ abortSignal: AbortSignal.timeout(30_000) },
					)
				).jobDefinitions ?? [];
			const definition = definitions.sort(
				(a, b) => (b.revision ?? 0) - (a.revision ?? 0),
			)[0];
			if (
				!definition?.jobDefinitionArn ||
				definition.type !== "container" ||
				definition.containerProperties?.image !== profile.image ||
				definition.platformCapabilities?.some((p) => p !== "EC2") ||
				definition.nodeProperties ||
				definition.ecsProperties ||
				definition.eksProperties
			)
				throw new Error(
					"AWS Batch definition must pin the configured EC2 container image",
				);
			const result = await client.send(
				new SubmitJobCommand({
					jobName: taskName(launch.taskId),
					jobQueue: profile.jobQueue,
					jobDefinition: definition.jobDefinitionArn,
					retryStrategy: { attempts: 1 },
					timeout: { attemptDurationSeconds: seconds },
					tags: {
						"bitovp:vmaf-profile": profile.id,
						"bitovp:vmaf-task": launch.taskId,
						"bitovp:vmaf-deadline": launch.deadline,
					},
					containerOverrides: {
						command: WORKER_COMMAND,
						environment: [
							{ name: "VMAF_MANIFEST_URL", value: launch.manifestUrl },
						],
						resourceRequirements: [
							{ type: "VCPU", value: String(profile.cpu) },
							{ type: "MEMORY", value: String(profile.memoryMiB) },
						],
					},
				}),
				{ abortSignal: AbortSignal.timeout(30_000) },
			);
			if (!result.jobId) throw new Error("AWS Batch did not return an ID");
			return result.jobId;
		},
		async find(id) {
			const matches = new Set<string>();
			const tokens = new Set<string>();
			let nextToken: string | undefined;
			do {
				const page = await client.send(
					new ListJobsCommand({
						jobQueue: profile.jobQueue,
						filters: [{ name: "JOB_NAME", values: [taskName(id)] }],
						maxResults: 100,
						nextToken,
					}),
					{ abortSignal: AbortSignal.timeout(30_000) },
				);
				for (const summary of page.jobSummaryList ?? []) {
					if (summary.jobName !== taskName(id) || !summary.jobId) continue;
					const job = await read(summary.jobId);
					if (job?.tags?.["bitovp:vmaf-task"] === id)
						matches.add(summary.jobId);
				}
				nextToken = page.nextToken;
				if (nextToken && tokens.has(nextToken))
					throw new Error("Repeated provider page token");
				if (nextToken) tokens.add(nextToken);
			} while (nextToken);
			if (matches.size > 1) throw new Error("Ambiguous cloud job ownership");
			return [...matches][0];
		},
		async status(id) {
			const job = await read(id);
			if (!job) return "MISSING";
			if (
				job.status === "SUCCEEDED" ||
				job.status === "FAILED" ||
				job.status === "RUNNING"
			)
				return job.status;
			return "QUEUED";
		},
		cancel,
		async cleanup(id) {
			await cancel(id);
			const sleep =
				deps.sleep ??
				((ms: number) =>
					new Promise<void>((resolve) => setTimeout(resolve, ms)));
			for (let i = 0; i < 60; i++) {
				const job = await read(id);
				if (!job || ["SUCCEEDED", "FAILED"].includes(job.status ?? "")) return;
				await sleep(2_000);
			}
			throw new Error("AWS Batch termination is not confirmed");
		},
	};
}
