import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RESET_CATALOG,
	RESET_GLOBAL_MODELS,
	RESET_INTERNAL_MODELS,
	RESET_PROTECTED_EDITING_MODELS,
	RESET_RETAINED_EXPERIMENT_MODELS,
	requiredResetCategories,
} from "./reset-selection";

describe("reset selection", () => {
	it("classifies every model for selected Application data reset", () => {
		const schema = readFileSync(
			join(__dirname, "../../../../packages/db/prisma/schema.prisma"),
			"utf8",
		);
		const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((match) => {
			const name = match[1] ?? "";
			return name.charAt(0).toLowerCase() + name.slice(1);
		});
		const customerModels = [
			...new Set(RESET_CATALOG.flatMap((item) => item.models)),
		];
		const classified = [
			...customerModels,
			...RESET_GLOBAL_MODELS,
			...RESET_INTERNAL_MODELS,
			...RESET_RETAINED_EXPERIMENT_MODELS,
		];
		expect(new Set(classified).size).toBe(classified.length);
		expect(classified.sort()).toEqual(models.sort());
		expect(models).toHaveLength(69);
		expect(RESET_PROTECTED_EDITING_MODELS).toContain("libraryFlowEvidencePin");
		expect(RESET_GLOBAL_MODELS).toEqual([
			"user",
			"setupCode",
			"organization",
			"membership",
			"platformSetting",
		]);
		expect(RESET_RETAINED_EXPERIMENT_MODELS).toEqual([
			"encodingExperimentCampaign",
			"encodingExperimentTrial",
			"encodingExperimentBatch",
		]);
		for (const model of [
			...RESET_GLOBAL_MODELS,
			...RESET_INTERNAL_MODELS,
			...RESET_RETAINED_EXPERIMENT_MODELS,
		])
			expect(customerModels).not.toContain(model);
		expect(RESET_PROTECTED_EDITING_MODELS[0]).toBe("libraryAnalysisBinding");
		expect(
			RESET_CATALOG.find((item) => item.category === "contentLibrary")?.models,
		).toEqual([
			...RESET_PROTECTED_EDITING_MODELS,
			"contentRevision",
			"content",
			"sceneAnalysisRevision",
			"librarySource",
		]);
	});
	it.each([
		"createRequest",
		"liveStopNotification",
		"encodingResourceRemoval",
	])("preserves %s across every selectable reset category", (model) => {
		expect(RESET_INTERNAL_MODELS).toContain(model);
		expect(RESET_CATALOG.flatMap((entry) => entry.models)).not.toContain(model);
	});
	it("keeps Library-only deletion independent from jobs and settings", () => {
		expect(requiredResetCategories(["contentLibrary"])).toEqual([
			"contentLibrary",
		]);
	});
	it("includes cloud profiles and credentials in their existing customer reset choices", () => {
		expect(
			RESET_CATALOG.find((entry) => entry.category === "applicationSettings")
				?.models,
		).toContain("vmafExecutionProfile");
		expect(
			RESET_CATALOG.find((entry) => entry.category === "credentials")?.models,
		).toContain("vmafComputeCredential");
	});
	it("makes cascade and credential dependencies explicit before deletion", () => {
		expect(requiredResetCategories(["applicationSettings"])).toEqual(
			expect.arrayContaining(["applicationSettings", "webhookRegistrations"]),
		);
		expect(requiredResetCategories(["liveChannels"])).toEqual(
			expect.arrayContaining([
				"liveChannels",
				"liveSchedules",
				"pseudoLiveFeeds",
				"channelAlertRules",
				"alertHistory",
			]),
		);
		expect(requiredResetCategories(["credentials"])).toEqual(
			expect.arrayContaining([
				"credentials",
				"watchFolders",
				"watchFolderHistory",
				"notificationChannels",
				"notificationRules",
				"storageChecks",
				"storagePresets",
			]),
		);
	});
});
