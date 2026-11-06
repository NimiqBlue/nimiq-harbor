import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { createApp } from './index.js';

// Local export defaults; no deployment or credential configuration is inherited.
process.env.APP_ORIGIN ||= `http://localhost:${process.env.PORT || '18787'}`;
const app = createApp();
const root = resolve('dist');
app.addHook('onSend', async (_req, reply) => {
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://polygon-rpc.com https://polygon.drpc.org https://rpc-mainnet.matic.quiknode.pro; frame-src https://widget.mtpelerin.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});
if (existsSync(root)) {
  await app.register(fastifyStatic, { root });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.split('?')[0]!.includes('.')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
  });
}
const port = Number(process.env.PORT || '18787');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
const host = process.env.HOST || '127.0.0.1';
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host, port });
console.log(`Harbor listening on ${host}:${port}`);
