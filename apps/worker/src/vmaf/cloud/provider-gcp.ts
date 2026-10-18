import type { VmafCloudProfile, VmafComputeAdapter } from "@bitovp/core";
import { GoogleAuth } from "google-auth-library";
import {
	hashId,
	launchSeconds,
	object,
	profileHash,
	type RestDependencies,
	restClient,
	taskName,
	waitMissing,
} from "./provider-common.js";

// Batch only exposes taskExecution.exitCode in task-level status events.
// https://docs.cloud.google.com/batch/docs/reference/rest/v1/StatusEvent
function events(status: Record<string, unknown>): Record<string, unknown>[] {
	if (status.statusEvents === undefined) return [];
	if (!Array.isArray(status.statusEvents))
		throw new Error("Invalid GCP status events");
	return status.statusEvents.map(object);
}
function preempted(event: Record<string, unknown>): boolean {
	if (event.taskExecution !== undefined)
		return object(event.taskExecution).exitCode === 50001;
	return (
		typeof event.description === "string" &&
		/due to Spot Preemption with exit code 50001\b/.test(event.description)
	);
}
function explicitFailure(event: Record<string, unknown>): boolean {
	return (
		event.taskState === "FAILED" ||
		event.type === "TASK_FAILED" ||
		(event.taskExecution !== undefined &&
			object(event.taskExecution).exitCode !== 0)
	);
}

type Profile = Extract<VmafCloudProfile, { provider: "GCP_BATCH" }>;
export function gcpAdapter(
	profile: Profile,
	deps: RestDependencies,
): VmafComputeAdapter {
	const auth = new GoogleAuth({
		scopes: ["https://www.googleapis.com/auth/cloud-platform"],
	});
	const api = restClient(
		deps,
		deps.googleToken ??
			(async () => {
				const token = await auth.getAccessToken();
				if (!token) throw new Error("Missing GCP credentials");
				return token;
			}),
	);
	const parent = `projects/${profile.project}/locations/${profile.region}/jobs/`;
	const url = (id: string) => {
		if (
			!id.startsWith(parent) ||
			!/^vmaf-[a-f0-9]{40}$/.test(id.slice(parent.length))
		)
			throw new Error("Invalid GCP job ID");
		return `https://batch.googleapis.com/v1/${id}`;
	};
	const read = async (id: string) => {
		const job = await api(url(id));
		if (!job) return undefined;
		const labels = object(job.labels);
		if (
			labels["vmaf-profile"] !== profileHash(profile) ||
			`vmaf-${labels["vmaf-task"]}` !== id.slice(parent.length)
		)
			throw new Error("Cloud job ownership mismatch");
		return job;
	};
	const remove = async (id: string) => {
		if (!(await read(id))) return;
		const operation = await api(url(id), "DELETE");
		if (
			!operation ||
			typeof operation.name !== "string" ||
			!/^projects\/[a-zA-Z0-9-]+\/locations\/[a-zA-Z0-9-]+\/operations\/[a-zA-Z0-9_-]+$/.test(
				operation.name,
			)
		)
			throw new Error("GCP deletion operation was not returned");
		const operationUrl = `https://batch.googleapis.com/v1/${operation.name}`;
		const completion = (value: Record<string, unknown>) => {
			if (value.error) throw new Error("GCP deletion operation failed");
			return value.done === true ? undefined : value;
		};
		if (completion(operation) === undefined) return;
		await waitMissing(async () => {
			const current = await api(operationUrl);
			if (!current) throw new Error("GCP deletion operation disappeared");
			return completion(current);
		}, deps);
	};
	return {
		async submit(launch) {
			const seconds = launchSeconds(profile, launch, deps.now?.());
			const id = taskName(launch.taskId);
			const result = await api(
				`https://batch.googleapis.com/v1/${parent.slice(0, -1)}?jobId=${id}`,
				"POST",
				{
					labels: {
						"vmaf-profile": profileHash(profile),
						"vmaf-task": hashId(launch.taskId),
					},
					taskGroups: [
						{
							taskCount: "1",
							parallelism: "1",
							taskCountPerNode: "1",
							taskSpec: {
								runnables: [
									{
										container: {
											imageUri: profile.image,
											entrypoint: "node",
											commands: [
												"--import",
												"tsx",
												"/app/apps/worker/scripts/vmaf-cloud-worker.mjs",
											],
										},
									},
								],
								environment: {
									variables: { VMAF_MANIFEST_URL: launch.manifestUrl },
								},
								computeResource: {
									cpuMilli: profile.cpu * 1000,
									memoryMib: profile.memoryMiB,
								},
								maxRetryCount: 0,
								maxRunDuration: `${seconds}s`,
							},
						},
					],
					allocationPolicy: {
						serviceAccount: { email: profile.serviceAccount },
						instances: [
							{
								policy: {
									machineType: profile.machineType,
									provisioningModel: profile.spot ? "SPOT" : "STANDARD",
									bootDisk: {
										sizeGb: String(profile.diskGiB),
										type: "pd-balanced",
									},
								},
							},
						],
					},
					logsPolicy: { destination: "CLOUD_LOGGING" },
				},
			);
			if (!result?.name) throw new Error("GCP Batch did not return an ID");
			return parent + id;
		},
		async find(id) {
			const providerId = parent + taskName(id);
			return (await read(providerId)) ? providerId : undefined;
		},
		async status(id) {
			const job = await read(id);
			if (!job) return "MISSING";
			const state = object(job.status).state;
			if (state === "SUCCEEDED" || state === "FAILED" || state === "RUNNING")
				return state;
			if (state === "DELETION_IN_PROGRESS") return "FAILED";
			return "QUEUED";
		},
		async failureReason(id) {
			const job = await read(id);
			if (!job) return "OTHER";
			const status = object(job.status);
			if (!["FAILED", "QUEUED", "SCHEDULED"].includes(String(status.state)))
				return "OTHER";
			const jobEvents = events(status);
			const taskEvents: Record<string, unknown>[] = [];
			let unknownTaskFailure = false;
			// Use the documented group ID map, never a provider-supplied URL.
			const groups = Object.keys(object(status.taskGroups ?? {}));
			for (const group of groups) {
				if (!/^[a-zA-Z0-9_-]+$/.test(group))
					throw new Error("Invalid GCP task group");
				const taskParent = `${id}/taskGroups/${group}/tasks/`;
				const tokens = new Set<string>();
				let token = "";
				do {
					if (tokens.has(token) || tokens.size >= 100)
						throw new Error("Invalid GCP task pagination");
					tokens.add(token);
					const query = new URLSearchParams({
						pageSize: "100",
						...(token ? { pageToken: token } : {}),
					});
					const page = await api(
						`${url(id)}/taskGroups/${group}/tasks?${query}`,
					);
					if (
						!page ||
						(Array.isArray(page.unreachable) && page.unreachable.length)
					)
						throw new Error("Incomplete GCP tasks");
					if (page.tasks !== undefined && !Array.isArray(page.tasks))
						throw new Error("Invalid GCP tasks");
					for (const value of (page.tasks ?? []) as unknown[]) {
						const task = object(value);
						if (
							typeof task.name !== "string" ||
							!task.name.startsWith(taskParent) ||
							!/^\d+$/.test(task.name.slice(taskParent.length))
						)
							throw new Error("GCP task ownership mismatch");
						const taskStatus = object(task.status);
						const history = events(taskStatus);
						if (taskStatus.state === "FAILED" && !history.some(preempted))
							unknownTaskFailure = true;
						taskEvents.push(...history);
					}
					if (
						page.nextPageToken !== undefined &&
						typeof page.nextPageToken !== "string"
					)
						throw new Error("Invalid GCP page token");
					token = (page.nextPageToken as string | undefined) ?? "";
				} while (token);
			}
			if (
				unknownTaskFailure ||
				taskEvents.some(
					(event) => explicitFailure(event) && !preempted(event),
				) ||
				jobEvents.some(
					(event) =>
						event.taskExecution !== undefined &&
						explicitFailure(event) &&
						!preempted(event),
				)
			)
				return "OTHER";
			if ([...taskEvents, ...jobEvents].some(preempted)) return "PREEMPTED";
			// A stockout earlier in a job must not hide its later application failure.
			if ([...taskEvents, ...jobEvents].some(explicitFailure)) return "OTHER";
			return jobEvents.some(
				(event) =>
					typeof event.description === "string" &&
					/\bZONE_RESOURCE_POOL_EXHAUSTED(?:_WITH_DETAILS)?\b/.test(
						event.description,
					),
			)
				? "CAPACITY"
				: "OTHER";
		},
		cancel: remove,
		async cleanup(id) {
			await remove(id);
			await waitMissing(() => read(id), deps);
		},
	};
}
