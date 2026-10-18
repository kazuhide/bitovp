import { describe, expect, it } from "vitest";
import { viewAsMayRead } from "./view-as";

describe("owner view-as read capability", () => {
	it.each([
		"/",
		"/vod/jobs",
		"/live/channel-id",
		"/qc/job-id",
		"/api/dashboard/usage",
		"/api/bitmovin-accounts",
		"/api/encoding-jobs/job-id",
		"/api/live-channels/channel-id/runs/run-id/health",
	])("permits target-scoped metadata %s", (path) =>
		expect(viewAsMayRead(path, "GET")).toBe(true));
	it.each([
		"/settings",
		"/settings/organizations",
		"/api/users",
		"/api/platform/users",
		"/api/access-events",
		"/api/api-tokens",
		"/api/credentials/id/storage/objects",
		"/api/bitmovin-accounts/id",
		"/api/live/stream-keys/id",
		"/api/live-channels/id/runs/run-id/heartbeats/export",
		"/api/live-channels/id/runs/run-id/final-heartbeat",
		"/api/future-read",
		"/api/encoding-jobs-evil",
	])("refuses credentials, administration and unreviewed GET %s", (path) =>
		expect(viewAsMayRead(path, "GET")).toBe(false));
	it.each([
		"POST",
		"PUT",
		"PATCH",
		"DELETE",
	])("refuses every %s including an otherwise readable path", (method) =>
		expect(viewAsMayRead("/api/encoding-jobs", method)).toBe(false));
});
