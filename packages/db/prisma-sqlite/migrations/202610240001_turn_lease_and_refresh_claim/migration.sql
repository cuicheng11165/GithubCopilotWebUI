-- AlterTable
ALTER TABLE "GitHubAccount" ADD COLUMN "refreshClaimedBy" TEXT;
ALTER TABLE "GitHubAccount" ADD COLUMN "refreshClaimedUntil" DATETIME;

-- AlterTable
ALTER TABLE "Turn" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "Turn" ADD COLUMN "leaseExpiresAt" DATETIME;

-- CreateIndex
CREATE INDEX "Turn_status_leaseExpiresAt_idx" ON "Turn"("status", "leaseExpiresAt");
