import "server-only";
import { dbSql } from "@bitovp/db";

/** Lateral subquery for an EditProject already scoped to this tenant as p. */
export function retainedExportForProject() {
	return dbSql`
    SELECT r.id FROM "RenderRun" r
    JOIN "RenderArtifact" a ON a."runId" = r.id AND a."organizationId" = r."organizationId"
    JOIN "EditRevision" v ON v.id = r."revisionId" AND v."projectId" = p.id
      AND v."organizationId" = r."organizationId"
    WHERE r."projectId" = p.id AND r."organizationId" = p."organizationId"
      AND r.generation > 0 AND r.state = 'SUCCEEDED' AND r.profile->>'kind' = 'EXPORT'
    ORDER BY r.generation DESC, r."createdAt" DESC, r.id DESC LIMIT 1`;
}
