import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/*',
  out: './drizzle/migrations',
  dbCredentials: {
    url: './store/messages.db',
  },
});
