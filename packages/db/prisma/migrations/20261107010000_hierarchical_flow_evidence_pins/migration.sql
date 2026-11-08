-- Private FLOW evidence pins are permanent until a separately designed release policy.
-- Existing receipt/source foreign keys retain the pinned source tuple transitively.
CREATE TABLE "LibraryFlowEvidencePin" (
 "organizationId" UUID NOT NULL DEFAULT (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid),
 "taskId" UUID NOT NULL,
 "receiptId" UUID NOT NULL,
 CONSTRAINT "LibraryFlowEvidencePin_pkey" PRIMARY KEY ("organizationId","taskId","receiptId")
);
CREATE INDEX "LibraryFlowEvidencePin_organizationId_receiptId_idx" ON "LibraryFlowEvidencePin"("organizationId","receiptId");
ALTER TABLE "LibraryFlowEvidencePin" ADD CONSTRAINT "LibraryFlowEvidencePin_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LibraryFlowEvidencePin" ADD CONSTRAINT "LibraryFlowEvidencePin_taskId_tenant_fkey" FOREIGN KEY ("organizationId","taskId") REFERENCES "LibraryMediaTask"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LibraryFlowEvidencePin" ADD CONSTRAINT "LibraryFlowEvidencePin_receiptId_tenant_fkey" FOREIGN KEY ("organizationId","receiptId") REFERENCES "LibraryEvidenceReceipt"("organizationId","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bitovp_keep_flow_evidence_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'FLOW evidence pins are immutable' USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER "flow_evidence_pin_immutable" BEFORE UPDATE OR DELETE ON "LibraryFlowEvidencePin" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_flow_evidence_pin();
CREATE TRIGGER "organization_immutable" BEFORE UPDATE ON "LibraryFlowEvidencePin" FOR EACH ROW EXECUTE FUNCTION bitovp_keep_organization();
ALTER TABLE "LibraryFlowEvidencePin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryFlowEvidencePin" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_scope" ON "LibraryFlowEvidencePin" USING ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid)) WITH CHECK ("organizationId" = (NULLIF(current_setting('bitovp.organization_id', true), '')::uuid));
