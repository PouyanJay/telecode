import { loadDotenv } from '../src/db/load-env';

/**
 * Vitest setup: load the repo-root `.env` so integration tests find `DATABASE_URL` locally. In CI the
 * env is provided by the workflow and the file is absent — then this is a no-op.
 */
loadDotenv();
