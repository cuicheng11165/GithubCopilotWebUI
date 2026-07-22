import type { Redis } from "ioredis";

export interface EphemeralStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  take(key: string): Promise<string | null>;
  close(): Promise<void>;
}

interface MemoryValue {
  value: string;
  expiresAt: number;
}

export class MemoryEphemeralStore implements EphemeralStore {
  private readonly values = new Map<string, MemoryValue>();

  private sweepExpired(now = Date.now()): void {
    for (const [key, entry] of this.values) if (entry.expiresAt <= now) this.values.delete(key);
  }

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.sweepExpired();
    this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async take(key: string): Promise<string | null> {
    const value = await this.get(key);
    this.values.delete(key);
    return value;
  }

  async close(): Promise<void> {
    this.values.clear();
  }
}

export class RedisEphemeralStore implements EphemeralStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  async take(key: string): Promise<string | null> {
    return this.redis.getdel(key);
  }

  async close(): Promise<void> {
    // The owning coordination backend closes the shared Redis connection.
  }
}
