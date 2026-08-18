/**
 * Reusable client-side helper for connecting to a Hono Live Query (SSE) endpoint.
 *
 * Example usage:
 * ```ts
 * const unsubscribe = subscribeToLiveQuery<Task[]>({
 *   url: '/tasks/live',
 *   token: 'your_auth_bearer_token',
 *   onData: (tasks) => {
 *     console.log('Received updated tasks:', tasks);
 *   },
 *   onError: (err) => {
 *     console.error('SSE Error:', err);
 *   }
 * });
 *
 * // When cleaning up component / hook:
 * unsubscribe();
 * ```
 */

export interface LiveQueryClientOptions<T> {
  url: string;
  headers?: Record<string, string>;
  token?: string;
  onData: (data: T) => void;
  onError?: (error: Event | Error) => void;
}

export function subscribeToLiveQuery<T>(options: LiveQueryClientOptions<T>): () => void {
  const { url, token, onData, onError } = options;

  // Use URL with token parameter or EventSource
  const fullUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
  const eventSource = new EventSource(fullUrl, { withCredentials: true });

  const handleUpdate = (event: MessageEvent) => {
    try {
      const parsed: T = JSON.parse(event.data);
      onData(parsed);
    } catch (e) {
      onError?.(e as Error);
    }
  };

  eventSource.addEventListener("update", handleUpdate);

  if (onError) {
    eventSource.onerror = (err) => onError(err);
  }

  return () => {
    eventSource.removeEventListener("update", handleUpdate);
    eventSource.close();
  };
}
