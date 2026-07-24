import { Container, getContainer } from '@cloudflare/containers';

/**
 * Sticky single instance keeps the SQLite file warm longer.
 * Container disk is still ephemeral across sleep/redeploy — fine for demos.
 */
export class BraynApp extends Container {
  defaultPort = 8080;
  sleepAfter = '6h';
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: 'production',
      PORT: '8080',
      APP_URL: env.APP_URL || 'https://www.myprototype.work',
      SESSION_SECRET: env.SESSION_SECRET || '',
      ADMIN_USERNAME: env.ADMIN_USERNAME || 'admin',
      ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
    };
  }
}

export default {
  async fetch(request, env) {
    return getContainer(env.BRAYN_APP, 'main').fetch(request);
  },
};
