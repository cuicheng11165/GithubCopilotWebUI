import { assertServiceSecret, parseEnv, serviceTokenSchema, tokenEncryptionKeySchema } from "@app/security";
import { z } from "zod";

const optionalServiceToken = (name: string) => z.string().optional().or(z.literal("")).superRefine((value, ctx) => {
  if (!value) return;
  try {
    assertServiceSecret(name, value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : `${name} is invalid.` });
  }
}).transform((value) => value || undefined);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  WORKER_CONTROL_URL: z.string().url().default("http://127.0.0.1:4200"),
  WORKER_CONTROL_TOKEN: serviceTokenSchema("WORKER_CONTROL_TOKEN"),
  SANDBOX_RUNNER_TOKEN: optionalServiceToken("SANDBOX_RUNNER_TOKEN"),
  SECURE_FORM_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(3_600).default(600),
  EVENT_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(5_000).default(200),
  COOKIE_SECRET: serviceTokenSchema("COOKIE_SECRET"),
  TOKEN_ENCRYPTION_KEY: tokenEncryptionKeySchema(),
  REPOSITORIES_CONFIG: z.string().min(1).default("./config/repositories.yaml"),
  GITHUB_CLIENT_ID: z.string().optional().or(z.literal("")),
  GITHUB_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  GITHUB_ALLOWED_ORGS: z.string().default(""),
  GITHUB_ALLOWED_ENTERPRISES: z.string().default(""),
  GHE_HOST: z.string().regex(/^[a-z0-9-]+\.ghe\.com$/i, "GHE_HOST must be a GitHub Enterprise Cloud *.ghe.com host").optional().or(z.literal("")),
  GHE_CLIENT_ID: z.string().optional(),
  GHE_CLIENT_SECRET: z.string().optional(),
  GHE_ALLOWED_ORGS: z.string().default(""),
  GHE_ALLOWED_ENTERPRISES: z.string().default("")
});

export const config = parseEnv(envSchema);

export interface OAuthProviderConfig {
  id: "github" | "ghe";
  label: string;
  host: string;
  webBaseUrl: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  allowedOrgs: string[];
  allowedEnterprises: string[];
}

export const oauthProviders: OAuthProviderConfig[] = [
  ...(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET ? [{
    id: "github" as const,
    label: "GitHub.com",
    host: "github.com",
    webBaseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    allowedOrgs: config.GITHUB_ALLOWED_ORGS.split(",").map((item) => item.trim()).filter(Boolean),
    allowedEnterprises: config.GITHUB_ALLOWED_ENTERPRISES.split(",").map((item) => item.trim()).filter(Boolean)
  }] : []),
  ...(config.GHE_HOST && config.GHE_CLIENT_ID && config.GHE_CLIENT_SECRET ? [{
    id: "ghe" as const,
    label: config.GHE_HOST,
    host: config.GHE_HOST,
    webBaseUrl: `https://${config.GHE_HOST}`,
    apiBaseUrl: `https://api.${config.GHE_HOST}`,
    clientId: config.GHE_CLIENT_ID,
    clientSecret: config.GHE_CLIENT_SECRET,
    allowedOrgs: config.GHE_ALLOWED_ORGS.split(",").map((item) => item.trim()).filter(Boolean),
    allowedEnterprises: config.GHE_ALLOWED_ENTERPRISES.split(",").map((item) => item.trim()).filter(Boolean)
  }] : [])
];
