import { Inngest } from 'inngest';
import { realtimeMiddleware } from '@inngest/realtime/middleware';

export const inngest = new Inngest({
  id: 'mastra',
  baseUrl: 'http://localhost:8288',
  isDev: true, // remove or set to false in production
  middleware: [realtimeMiddleware()],
});
