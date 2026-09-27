import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /** polling — local development; webhook — public HTTPS stand; off — API only. */
    BOT_MODE: z.enum(['polling', 'webhook', 'off']).default('polling'),
    MAX_BOT_TOKEN: z.string().optional(),
    /** Public HTTPS origin of this API, e.g. https://api.example.ru (webhook mode). */
    WEBHOOK_URL: z.url({ protocol: /^https$/ }).optional(),
    /** Sent back by MAX in X-Max-Bot-Api-Secret; 5–256 chars of [A-Za-z0-9-]. */
    WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9-]{5,256}$/, 'WEBHOOK_SECRET must be 5–256 chars of [A-Za-z0-9-]')
      .optional(),
    /** Value of `web_app` in open_app buttons; defaults to the bot username. */
    MAX_WEB_APP: z.string().min(1).optional(),
    /** Delay of the "next step" reminder after the route changes (20 h by default; set to 60 for demos). */
    REMINDER_DELAY_SECONDS: z.coerce.number().int().min(0).default(20 * 60 * 60),
    /** How long signed mini-app launch data stays valid (24 h; raised on the review stand). */
    INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(60).default(24 * 60 * 60),
    /** How often the reminder worker polls the queue. */
    REMINDER_POLL_SECONDS: z.coerce.number().int().min(5).default(30),
    /** Optional «Объясни проще»: an OpenAI-compatible chat completions endpoint. Off by default. */
    LLM_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    LLM_API_URL: z.url({ protocol: /^https?$/ }).optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_MODEL: z.string().min(1).optional(),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    /** The «Карта» tab: serve the location index snapshots of the rules packs (content/<pack>/location-index.json). On by default. */
    LOCATION_INDEX_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.BOT_MODE !== 'off' && !env.MAX_BOT_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['MAX_BOT_TOKEN'], message: `MAX_BOT_TOKEN is required when BOT_MODE=${env.BOT_MODE}` });
    }
    if (env.LLM_ENABLED) {
      for (const key of ['LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when LLM_ENABLED=true` });
      }
    }
    if (env.BOT_MODE === 'webhook') {
      if (!env.WEBHOOK_URL) {
        ctx.addIssue({ code: 'custom', path: ['WEBHOOK_URL'], message: 'WEBHOOK_URL is required when BOT_MODE=webhook' });
      }
      if (!env.WEBHOOK_SECRET) {
        ctx.addIssue({ code: 'custom', path: ['WEBHOOK_SECRET'], message: 'WEBHOOK_SECRET is required when BOT_MODE=webhook' });
      }
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings from .env / compose interpolation as "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
