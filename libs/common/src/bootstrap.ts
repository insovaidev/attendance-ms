import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ensureTopics, kafkaConsumerOptions, type KafkaConsumerConfig } from './kafka.js';
import { listenAddress, ServiceToken } from './services.js';

/**
 * Boots a pure TCP microservice (no HTTP). Used by auth, shift,
 * attendance and notification — only the gateway speaks HTTP.
 *
 * Services that also consume Kafka events use bootstrapHybridService().
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

/**
 * Boots a service that answers TCP requests AND consumes Kafka events.
 * One Nest app, two transports ("hybrid application"). Handlers choose a
 * transport with the second decorator argument:
 *   @MessagePattern(pattern, Transport.TCP)   requests from the gateway
 *   @EventPattern(topic, Transport.KAFKA)     events from the log
 * Without it, the Kafka server would also subscribe to every TCP pattern
 * as if it were a topic.
 */
export async function bootstrapHybridService(
  module: Parameters<typeof NestFactory.create>[0],
  service: ServiceToken,
  name: string,
  kafka: KafkaConsumerConfig,
) {
  const logger = new Logger(name);
  const { host, port } = listenAddress(service);
  // create() (not createMicroservice) so we can attach two transports.
  // The HTTP server is never started: no listen() call.
  const app = await NestFactory.create(module);
  app.enableShutdownHooks();
  app.connectMicroservice<MicroserviceOptions>(
    { transport: Transport.TCP, options: { host, port } },
    { inheritAppConfig: true },
  );
  app.connectMicroservice<MicroserviceOptions>(
    { transport: Transport.KAFKA, options: kafkaConsumerOptions(kafka) },
    { inheritAppConfig: true },
  );

  // Subscribing to a topic that doesn't exist yet would create it with the
  // broker's defaults, so make sure ours (3 partitions) exist first.
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureTopics();
      break;
    } catch (err) {
      logger.warn(`Waiting for Kafka (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 10_000)));
    }
  }

  await app.startAllMicroservices();
  await app.init();
  logger.log(`TCP on ${host}:${port}, Kafka consumer group "${kafka.groupId}"`);
}
