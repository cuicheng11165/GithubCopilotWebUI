CREATE TYPE "ApprovalMode" AS ENUM ('INTERACTIVE', 'SESSION_SCOPED', 'ALLOW_ALL');
CREATE TYPE "SessionStatus" AS ENUM ('IDLE', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'ERROR');
CREATE TYPE "TurnStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'STOPPED', 'FAILED');
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');
CREATE TYPE "PermissionStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

CREATE TABLE "User" (
  "id" UUID NOT NULL, "login" TEXT NOT NULL, "displayName" TEXT, "avatarUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GitHubAccount" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "provider" TEXT NOT NULL, "providerUserId" TEXT NOT NULL,
  "host" TEXT NOT NULL, "encryptedAccessToken" TEXT NOT NULL, "encryptedRefreshToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMP(3), "refreshTokenExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GitHubAccount_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WebSession" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "githubAccountId" UUID NOT NULL, "tokenHash" TEXT NOT NULL,
  "csrfToken" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ChatSession" (
  "id" UUID NOT NULL, "sdkSessionId" TEXT NOT NULL, "userId" UUID NOT NULL, "githubAccountId" UUID NOT NULL,
  "repositoryId" TEXT NOT NULL, "repositoryName" TEXT NOT NULL, "title" TEXT NOT NULL DEFAULT 'New chat',
  "model" TEXT NOT NULL DEFAULT 'auto', "approvalMode" "ApprovalMode" NOT NULL DEFAULT 'INTERACTIVE',
  "approvalScopes" TEXT[], "status" "SessionStatus" NOT NULL DEFAULT 'IDLE', "branch" TEXT, "headSha" TEXT,
  "dirty" BOOLEAN NOT NULL DEFAULT false, "skillManifest" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Turn" (
  "id" UUID NOT NULL, "sessionId" UUID NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "status" "TurnStatus" NOT NULL DEFAULT 'QUEUED', "error" TEXT, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Turn_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Message" (
  "id" UUID NOT NULL, "sessionId" UUID NOT NULL, "turnId" UUID, "role" "MessageRole" NOT NULL,
  "content" TEXT NOT NULL, "metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SessionEvent" (
  "cursor" BIGSERIAL NOT NULL, "sessionId" UUID NOT NULL, "turnId" UUID, "kind" TEXT NOT NULL,
  "data" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("cursor")
);
CREATE TABLE "PermissionRequest" (
  "id" UUID NOT NULL, "sdkRequestId" TEXT NOT NULL, "sessionId" UUID NOT NULL, "turnId" UUID NOT NULL,
  "scope" TEXT NOT NULL, "intention" TEXT NOT NULL, "display" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" "PermissionStatus" NOT NULL DEFAULT 'PENDING', "expiresAt" TIMESTAMP(3) NOT NULL, "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PermissionRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AuditLog" (
  "id" BIGSERIAL NOT NULL, "userId" UUID, "action" TEXT NOT NULL, "targetId" TEXT, "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GitHubAccount_userId_idx" ON "GitHubAccount"("userId");
CREATE UNIQUE INDEX "GitHubAccount_provider_providerUserId_key" ON "GitHubAccount"("provider", "providerUserId");
CREATE UNIQUE INDEX "WebSession_tokenHash_key" ON "WebSession"("tokenHash");
CREATE INDEX "WebSession_userId_idx" ON "WebSession"("userId");
CREATE INDEX "WebSession_githubAccountId_idx" ON "WebSession"("githubAccountId");
CREATE INDEX "WebSession_expiresAt_idx" ON "WebSession"("expiresAt");
CREATE UNIQUE INDEX "ChatSession_sdkSessionId_key" ON "ChatSession"("sdkSessionId");
CREATE INDEX "ChatSession_userId_updatedAt_idx" ON "ChatSession"("userId", "updatedAt" DESC);
CREATE INDEX "Turn_sessionId_createdAt_idx" ON "Turn"("sessionId", "createdAt");
CREATE UNIQUE INDEX "Turn_sessionId_idempotencyKey_key" ON "Turn"("sessionId", "idempotencyKey");
CREATE INDEX "Message_sessionId_createdAt_idx" ON "Message"("sessionId", "createdAt");
CREATE INDEX "SessionEvent_sessionId_cursor_idx" ON "SessionEvent"("sessionId", "cursor");
CREATE INDEX "PermissionRequest_sessionId_status_idx" ON "PermissionRequest"("sessionId", "status");
CREATE UNIQUE INDEX "PermissionRequest_sessionId_sdkRequestId_key" ON "PermissionRequest"("sessionId", "sdkRequestId");
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

ALTER TABLE "GitHubAccount" ADD CONSTRAINT "GitHubAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebSession" ADD CONSTRAINT "WebSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebSession" ADD CONSTRAINT "WebSession_githubAccountId_fkey" FOREIGN KEY ("githubAccountId") REFERENCES "GitHubAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_githubAccountId_fkey" FOREIGN KEY ("githubAccountId") REFERENCES "GitHubAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PermissionRequest" ADD CONSTRAINT "PermissionRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PermissionRequest" ADD CONSTRAINT "PermissionRequest_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
