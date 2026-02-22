import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    user: process.env.DATABASE_USER ?? 'rag_user',
    password: process.env.DATABASE_PASSWORD ?? 'rag_password',
    database: process.env.DATABASE_NAME ?? 'web_rag_lab',
    ssl: process.env.DATABASE_SSL === 'true',
  },
});
