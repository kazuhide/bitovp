-- Ledger #26: the listing's object size rides the inspection row so the
-- worker can aim a TRUE tail read (bytes=(size-TAIL)..(size-1)) instead of
-- the next-slice approximation. Advisory only — the worker still bounds on
-- arrival and requires Content-Range.
ALTER TABLE "StorageInspection" ADD COLUMN "objectSize" BIGINT;
