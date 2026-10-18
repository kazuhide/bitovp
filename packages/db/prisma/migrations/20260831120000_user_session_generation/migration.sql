-- Bind a users-mode session to the exact credential/revocation generation
-- whose password was verified. Existing cookies have no generation claim and
-- therefore fail closed after deploy; existing user rows begin at generation 0.
ALTER TABLE "User"
ADD COLUMN "sessionGeneration" INTEGER NOT NULL DEFAULT 0;
