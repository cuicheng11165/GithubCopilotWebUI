import type { EphemeralStore } from "./ephemeral-store.js";

declare module "fastify" {
  interface FastifyInstance {
    ephemeral: EphemeralStore;
  }
}
