import {
	type VodInputFavoriteWire,
	type VodInputPreviewTask,
	type VodInputTimelineSource,
	vodInputFavoriteCreateSchema,
	vodInputPreviewSubmissionSchema,
} from "@bitovp/core/vod-input-timeline";
import { DEMO_BUCKET, DEMO_STORAGE_ID, DEMO_VOD_SAMPLE_KEY } from "./fixtures";

const previewPath = "/api/vod/input-previews";
const favoritesPath = "/api/vod/input-favorites";
const maxProbes = 32;
const probeLifetimeMs = 24 * 60 * 60 * 1000;

function isSample(
	source: Pick<VodInputTimelineSource, "credentialId" | "bucket" | "objectKey">,
) {
	return (
		source.credentialId === DEMO_STORAGE_ID &&
		source.bucket === DEMO_BUCKET &&
		source.objectKey === DEMO_VOD_SAMPLE_KEY
	);
}

function sampleFacts(source: VodInputTimelineSource) {
	return {
		key: source.key,
		durationMs: 10_000,
		video: {
			streamIndex: 0,
			width: 1920,
			height: 1080,
			frameRate: { num: 24, den: 1 },
			durationMs: 10_000,
		},
		audio: {
			streamIndex: 1,
			sampleRate: 48_000,
			channels: 2,
			durationMs: 10_000,
		},
		identity: { size: 3_200_000, etag: "demo-big-buck-bunny-10s" },
	};
}

export function createDemoVodInputRoutes({
	json,
	readBody,
	now,
}: {
	json(value: unknown, status?: number): Response;
	readBody(request: Request): Promise<Record<string, unknown>>;
	now(): number;
}) {
	const probes = new Map<string, VodInputPreviewTask>();
	let favorite: VodInputFavoriteWire | undefined;

	async function probe(request: Request) {
		const parsed = vodInputPreviewSubmissionSchema.safeParse(
			await readBody(request),
		);
		if (!parsed.success)
			return json({ error: "Invalid VOD input request." }, 400);
		if (parsed.data.kind !== "PROBE") return undefined;
		if (!parsed.data.sources.every(isSample))
			return json({ error: "Choose the sample in Demo storage." }, 422);

		const timestamp = now();
		const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
		const requestHash = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		const task: VodInputPreviewTask = {
			id: crypto.randomUUID(),
			kind: "PROBE",
			status: "SUCCEEDED",
			stage: "READY",
			requestHash,
			createdAt: new Date(timestamp).toISOString(),
			expiresAt: new Date(timestamp + probeLifetimeMs).toISOString(),
			result: { sources: parsed.data.sources.map(sampleFacts) },
		};
		if (probes.size >= maxProbes) {
			const oldest = probes.keys().next().value;
			if (oldest) probes.delete(oldest);
		}
		probes.set(task.id, task);
		return json({ task });
	}

	async function pin(request: Request) {
		const parsed = vodInputFavoriteCreateSchema.safeParse(
			await readBody(request),
		);
		if (!parsed.success) return json({ error: "Invalid fixed source." }, 400);
		if (!isSample(parsed.data) || parsed.data.kind !== "VIDEO")
			return json({ error: "Choose the sample in Demo storage." }, 422);
		favorite ??= {
			...parsed.data,
			id: crypto.randomUUID(),
			availability: "AVAILABLE",
			inputKind: "S3",
		};
		return json({ favorite }, 201);
	}

	return {
		async route(request: Request, url: URL): Promise<Response | undefined> {
			const path = url.pathname.replace(/\/$/, "");
			const method = request.method;
			if (path === previewPath && method === "POST") return probe(request);
			const taskId = /^\/api\/vod\/input-previews\/([^/]+)$/.exec(path)?.[1];
			if (taskId && (method === "GET" || method === "DELETE")) {
				const task = probes.get(taskId);
				if (!task || Date.parse(task.expiresAt) <= now())
					return json({ error: "The sample probe has expired." }, 404);
				return json({ task });
			}
			if (path === favoritesPath && method === "GET")
				return json({ favorites: favorite ? [favorite] : [] });
			if (path === favoritesPath && method === "POST") return pin(request);
			if (
				favorite &&
				path === `${favoritesPath}/${favorite.id}` &&
				method === "DELETE"
			) {
				favorite = undefined;
				return new Response(null, {
					status: 204,
					headers: {
						"cache-control": "no-store",
						"x-bitovp-demo": "simulated",
					},
				});
			}
			return undefined;
		},
		reset() {
			probes.clear();
			favorite = undefined;
		},
	};
}
