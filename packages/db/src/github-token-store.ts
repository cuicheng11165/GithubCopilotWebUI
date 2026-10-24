import type { PrismaClient } from "../generated/sqlite/index.js";
import type { GitHubAccountTokenRecord, GitHubTokenStore, GitHubTokenUpdate } from "./github-access-token.js";

function toRecord(account: {
  id: string;
  provider: string;
  host: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  refreshClaimedBy: string | null;
  refreshClaimedUntil: Date | null;
}): GitHubAccountTokenRecord {
  return account;
}

export function createPrismaGitHubTokenStore(client: PrismaClient): GitHubTokenStore {
  return {
    async find(id) {
      const account = await client.gitHubAccount.findUnique({
        where: { id },
        select: {
          id: true,
          provider: true,
          host: true,
          encryptedAccessToken: true,
          encryptedRefreshToken: true,
          accessTokenExpiresAt: true,
          refreshTokenExpiresAt: true,
          refreshClaimedBy: true,
          refreshClaimedUntil: true
        }
      });
      return account ? toRecord(account) : null;
    },
    async claim(input) {
      const claimed = await client.gitHubAccount.updateMany({
        where: {
          id: input.id,
          encryptedRefreshToken: input.encryptedRefreshToken,
          OR: [
            { refreshClaimedUntil: null },
            { refreshClaimedUntil: { lte: input.now } }
          ]
        },
        data: { refreshClaimedBy: input.owner, refreshClaimedUntil: input.until }
      });
      return claimed.count === 1;
    },
    async save(input) {
      const saved = await client.gitHubAccount.updateMany({
        where: { id: input.id, refreshClaimedBy: input.owner },
        data: clearClaim(input.update)
      });
      return saved.count === 1;
    },
    async saveIfRefreshTokenMatches(input) {
      const saved = await client.gitHubAccount.updateMany({
        where: { id: input.id, encryptedRefreshToken: input.encryptedRefreshToken },
        data: clearClaim(input.update)
      });
      return saved.count === 1;
    },
    async release(id, owner) {
      await client.gitHubAccount.updateMany({
        where: { id, refreshClaimedBy: owner },
        data: { refreshClaimedBy: null, refreshClaimedUntil: null }
      });
    }
  };
}

function clearClaim(update: GitHubTokenUpdate) {
  return { ...update, refreshClaimedBy: null, refreshClaimedUntil: null };
}
