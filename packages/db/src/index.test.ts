import { describe, expect, it } from "vitest";
import { Prisma as PostgreSqlPrisma } from "@prisma/client";
import { Prisma as SqlitePrisma } from "../generated/sqlite/index.js";
import { resolveDatabaseMode, validateDatabaseUrl } from "./index.js";

describe("database mode", () => {
  it("uses the explicit local mode", () => {
    expect(resolveDatabaseMode({ DATABASE_MODE: "local", DATABASE_URL: "postgresql://ignored" } as NodeJS.ProcessEnv)).toBe("local");
  });

  it("uses the explicit multi-user mode", () => {
    expect(resolveDatabaseMode({ DATABASE_MODE: "multi-user", DATABASE_URL: "file:./ignored.db" } as NodeJS.ProcessEnv)).toBe("multi-user");
  });

  it("infers local mode from a SQLite URL", () => {
    expect(resolveDatabaseMode({ DATABASE_URL: "file:./data/copilot.db" } as NodeJS.ProcessEnv)).toBe("local");
  });

  it("rejects an unknown explicit mode", () => {
    expect(() => resolveDatabaseMode({ DATABASE_MODE: "sqlite" } as NodeJS.ProcessEnv)).toThrow("local or multi-user");
  });

  it("rejects a database URL for the wrong mode", () => {
    expect(() => validateDatabaseUrl("local", "postgresql://localhost/copilot")).toThrow("SQLite");
    expect(() => validateDatabaseUrl("multi-user", "file:./copilot.db")).toThrow("PostgreSQL");
  });

  it("keeps the SQLite and PostgreSQL model surfaces aligned", () => {
    const shape = (models: typeof PostgreSqlPrisma.dmmf.datamodel.models) => models.map((model) => ({
      name: model.name,
      fields: model.fields.map((field) => field.name).sort()
    }));
    expect(shape(SqlitePrisma.dmmf.datamodel.models as typeof PostgreSqlPrisma.dmmf.datamodel.models)).toEqual(shape(PostgreSqlPrisma.dmmf.datamodel.models));
  });
});
