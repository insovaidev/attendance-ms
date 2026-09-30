import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { isProduction, listenAddress, SERVICES } from '#common';
import { GatewayModule } from './gateway.module.js';

const app = await NestFactory.create(GatewayModule);

// Browsers may only call the API from these origins (comma separated).
// Unset: any origin in development, same-origin only in production.
const origins = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
if (origins?.length) app.enableCors({ origin: origins, credentials: true });
else if (!isProduction()) app.enableCors();

// Behind a load balancer / reverse proxy, set TRUST_PROXY (e.g. "1" = one hop)
// so req.ip is the real client IP. The rate limiter keys on it.
const http = app.getHttpAdapter().getInstance();
http.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  http.set('trust proxy', Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
}

app.enableShutdownHooks();
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

// Hybrid app: HTTP for clients + a TCP listener so other services can
// push events to us (used by the live SSE dashboard).
// inheritAppConfig applies the global guards (InternalAuthGuard) here too;
// without it, anyone who reaches this port could inject fake live events.
app.connectMicroservice<MicroserviceOptions>(
  { transport: Transport.TCP, options: listenAddress(SERVICES.GATEWAY_EVENTS) },
  { inheritAppConfig: true },
);
await app.startAllMicroservices();

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);

const events = listenAddress(SERVICES.GATEWAY_EVENTS);
new Logger('Gateway').log(`HTTP on :${port}, event listener on TCP ${events.host}:${events.port}`);
