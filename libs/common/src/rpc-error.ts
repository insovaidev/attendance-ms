import { RpcException } from '@nestjs/microservices';

/**
 * Errors crossing a service boundary must be plain objects.
 * Services throw rpcError(404, '...'); the gateway turns it back into
 * the matching HTTP status (see apps/gateway/src/rpc.ts).
 */
export interface RpcErrorBody {
  status: number;
  message: string;
}

export function rpcError(status: number, message: string): RpcException {
  return new RpcException({ status, message } satisfies RpcErrorBody);
}

export function isRpcErrorBody(value: unknown): value is RpcErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RpcErrorBody).status === 'number' &&
    typeof (value as RpcErrorBody).message === 'string'
  );
}
