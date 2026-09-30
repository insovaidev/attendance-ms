import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { listenAddress, SERVICES } from '#common';
import { GatewayModule } from './gateway.module.js';

const app = await NestFactory.create(GatewayModule);

app.enableCors();
app.enableShutdownHooks();
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

// Hybrid app: HTTP for clients + a TCP listener so other services can
// push events to us (used by the live SSE dashboard).
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.TCP,
  options: listenAddress(SERVICES.GATEWAY_EVENTS),
});
await app.startAllMicroservices();

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);

const events = listenAddress(SERVICES.GATEWAY_EVENTS);
new Logger('Gateway').log(`HTTP on :${port}, event listener on TCP ${events.host}:${events.port}`);
