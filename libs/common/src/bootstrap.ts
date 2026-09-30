import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { listenAddress, ServiceToken } from './services.js';

/**
 * Boots a pure TCP microservice (no HTTP). Used by auth, shift,
 * attendance and notification — only the gateway speaks HTTP.
 *
 * To move to RabbitMQ later, this is the one place to change:
 *   transport: Transport.RMQ, options: { urls: [...], queue: 'auth' }
 */
export async function bootstrapTcpService(
  module: Parameters<typeof NestFactory.createMicroservice>[0],
  service: ServiceToken,
  name: string,
) {
  const { host, port } = listenAddress(service);
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(module, {
    transport: Transport.TCP,
    options: { host, port },
  });
  app.enableShutdownHooks();
  await app.listen();
  new Logger(name).log(`TCP microservice listening on ${host}:${port}`);
}
