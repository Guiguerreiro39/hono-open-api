import { EventEmitter } from "node:events";

export interface RealtimeEvent<T = unknown> {
  action: "create" | "update" | "delete" | string;
  data?: T;
  timestamp?: number;
}

export type EventListener<T = unknown> = (event: RealtimeEvent<T>) => void | Promise<void>;

export class PubSubManager {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish<T = unknown>(topic: string, event: RealtimeEvent<T>): void {
    const payload: RealtimeEvent<T> = {
      ...event,
      timestamp: event.timestamp ?? Date.now(),
    };
    this.emitter.emit(topic, payload);
  }

  subscribe<T = unknown>(topic: string, listener: EventListener<T>): () => void {
    this.emitter.on(topic, listener as (...args: any[]) => void);
    return () => {
      this.emitter.off(topic, listener as (...args: any[]) => void);
    };
  }
}

export const pubsub = new PubSubManager();
export default pubsub;
