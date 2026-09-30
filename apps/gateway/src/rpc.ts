import {
  BadGatewayException,
  Logger,
  GatewayTimeoutException,
  HttpException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { isRpcErrorBody, withInternalToken } from '#common';

const DEFAULT_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 5000);
const logger = new Logger('rpc');

/**
 * Call another service and translate its failure into an HTTP error.
 *
 * Three different things can go wrong, and they mean different things:
 *   1. The service answered with an error      -> pass its status through (404, 409...)
 *   2. The service is not running               -> 503 Service Unavailable
 *   3. The service is running but too slow      -> 504 Gateway Timeout
 */
export async function call<T>(
  client: ClientProxy,
  pattern: string,
  data: object = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  try {
    return await firstValueFrom(client.send<T>(pattern, withInternalToken(data)).pipe(timeout(timeoutMs)));
  } catch (err) {
    if (isRpcErrorBody(err)) throw new HttpException(err.message, err.status);
    if (err instanceof TimeoutError) {
      throw new GatewayTimeoutException(`"${pattern}" did not answer within ${timeoutMs}ms`);
    }
    const code = (err as { code?: string })?.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
      throw new ServiceUnavailableException(`Service for "${pattern}" is unavailable`);
    }
    // Unhandled exception inside the service: Nest replies { status: 'error', message }.
    if ((err as { status?: string })?.status === 'error') {
      throw new BadGatewayException(`"${pattern}" failed inside the service`);
    }
    // Log the details; never send internal error text to the client.
    logger.error(`"${pattern}" failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    throw new InternalServerErrorException();
  }
}
