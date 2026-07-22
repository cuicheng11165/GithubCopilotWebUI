import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  COOKIE_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  REPOSITORIES_CONFIG: z.string().min(1).default("./config/repositories.yaml"),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_ALLOWED_ORGS: z.string().default(""),
  GITHUB_ALLOWED_ENTERPRISES: z.string().default(""),
  GHE_HOST: z.string().regex(/^[a-z0-9-]+\.ghe\.com$/i, "GHE_HOST must be a GitHub Enterprise Cloud *.ghe.com host").optional().or(z.literal("")),
  GHE_CLIENT_ID: z.string().optional(),
  GHE_CLIENT_SECRET: z.string().optional(),
  GHE_ALLOWED_ORGS: z.string().default(""),
  GHE_ALLOWED_ENTERPRISES: z.string().default("")
});

export const config = envSchema.parse(process.env);

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
  {
    id: "github",
    label: "GitHub.com",
    host: "github.com",
    webBaseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    allowedOrgs: config.GITHUB_ALLOWED_ORGS.split(",").map((item) => item.trim()).filter(Boolean),
    allowedEnterprises: config.GITHUB_ALLOWED_ENTERPRISES.split(",").map((item) => item.trim()).filter(Boolean)
  },
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
