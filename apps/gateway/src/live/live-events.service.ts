import { Injectable, type MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/** In-memory fan-out from incoming TCP events to connected SSE browsers. */
@Injectable()
export class LiveEventsService {
  private readonly stream = new Subject<MessageEvent>();

  push(type: string, data: object) {
    this.stream.next({ type, data });
  }

  asObservable(): Observable<MessageEvent> {
    return this.stream.asObservable();
  }
}
