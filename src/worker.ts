import { MinesweeperGame } from '../functions/api/game';

export { MinesweeperGame };

interface Env {
  GAME: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return env.GAME.get(env.GAME.idFromName('global')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
