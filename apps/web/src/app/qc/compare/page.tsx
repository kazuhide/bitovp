import { notFound } from "next/navigation";
import { Suspense } from "react";
import { localizedTitle } from "@/lib/i18n/metadata";
import { readFeatureFlags } from "@/lib/server/feature-flags";
import { CompareClient } from "./compare-client";

export const generateMetadata = localizedTitle("pageTitles.compareVmafReports");

/**
 * VMAF report comparison (/qc/compare?jobs=id1,id2,…). Overlays the per-frame
 * VMAF series and the quality ladders of 2–6 finished reports so encodes can be
 * compared head-to-head. The job ids live in the query string; the client
 * fans out one GET /api/vmaf-jobs/[id] per id (no batch endpoint) and tolerates
 * any single one failing. `useSearchParams` requires a Suspense boundary under
 * the App Router.
 */
export default async function CompareVmafPage() {
	// : with QC/VMAF off this surface does not exist for the
	// deployment — 404 rather than an empty page, matching the API gate.
	if (!(await readFeatureFlags()).qcVmaf) {
		notFound();
	}
	return (
		<Suspense fallback={null}>
			<CompareClient />
		</Suspense>
	);
}
