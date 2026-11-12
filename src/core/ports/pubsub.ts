export interface RealtimeEvent<T = unknown> {
  action: "create" | "update" | "delete" | (string & {});
  data?: T;
  timestamp?: number;
}

export type RealtimeEventListener<T = unknown> = (
  event: RealtimeEvent<T>,
) => void | Promise<void>;

export interface PubSubPort {
  publish: <T = unknown>(topic: string, event: RealtimeEvent<T>) => Promise<void>;
  subscribe: <T = unknown>(
    topic: string,
    listener: RealtimeEventListener<T>,
  ) => Promise<() => Promise<void>>;
  ping?: () => Promise<void>;
  close: () => Promise<void>;
}
