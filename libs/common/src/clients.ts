import { DynamicModule } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { endpoint, ServiceToken } from './services.js';

/**
 * Registers TCP clients for the given services, injectable with
 * @Inject(SERVICES.SHIFT) private readonly shift: ClientProxy
 */
export function tcpClients(...services: ServiceToken[]): DynamicModule {
  return ClientsModule.register(
    services.map((name) => ({
      name,
      transport: Transport.TCP,
      options: endpoint(name),
    })),
  );
}
