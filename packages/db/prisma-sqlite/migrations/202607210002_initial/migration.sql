-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "login" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GitHubAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHubAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "githubAccountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WebSession_githubAccountId_fkey" FOREIGN KEY ("githubAccountId") REFERENCES "GitHubAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sdkSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubAccountId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "model" TEXT NOT NULL DEFAULT 'auto',
    "approvalMode" TEXT NOT NULL DEFAULT 'INTERACTIVE',
    "approvalScopes" JSONB NOT NULL DEFAULT [],
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "branch" TEXT,
    "headSha" TEXT,
    "dirty" BOOLEAN NOT NULL DEFAULT false,
    "skillManifest" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatSession_githubAccountId_fkey" FOREIGN KEY ("githubAccountId") REFERENCES "GitHubAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Turn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Turn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionEvent" (
    "cursor" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionEvent_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PermissionRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sdkRequestId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "intention" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" DATETIME NOT NULL,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PermissionRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PermissionRequest_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GitHubAccount_userId_idx" ON "GitHubAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubAccount_provider_providerUserId_key" ON "GitHubAccount"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WebSession_tokenHash_key" ON "WebSession"("tokenHash");

-- CreateIndex
CREATE INDEX "WebSession_userId_idx" ON "WebSession"("userId");

-- CreateIndex
CREATE INDEX "WebSession_githubAccountId_idx" ON "WebSession"("githubAccountId");

-- CreateIndex
CREATE INDEX "WebSession_expiresAt_idx" ON "WebSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSession_sdkSessionId_key" ON "ChatSession"("sdkSessionId");

-- CreateIndex
CREATE INDEX "ChatSession_userId_updatedAt_idx" ON "ChatSession"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Turn_sessionId_createdAt_idx" ON "Turn"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Turn_sessionId_idempotencyKey_key" ON "Turn"("sessionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Message_sessionId_createdAt_idx" ON "Message"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionEvent_sessionId_cursor_idx" ON "SessionEvent"("sessionId", "cursor");

-- CreateIndex
CREATE INDEX "PermissionRequest_sessionId_status_idx" ON "PermissionRequest"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionRequest_sessionId_sdkRequestId_key" ON "PermissionRequest"("sessionId", "sdkRequestId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
