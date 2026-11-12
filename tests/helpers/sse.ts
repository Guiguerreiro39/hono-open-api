export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface ReadSseEventsOptions {
  count?: number;
  timeoutMs?: number;
  ignoreEvents?: string[];
  cancelOnComplete?: boolean;
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split("\n");
  let event: string | undefined;
  const dataLines: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  let hasField = false;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        event = value;
        hasField = true;
        break;
      case "data":
        dataLines.push(value);
        hasField = true;
        break;
      case "id":
        if (!value.includes("\0")) {
          id = value;
          hasField = true;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          retry = Number.parseInt(value, 10);
          hasField = true;
        }
        break;
    }
  }

  if (!hasField) {
    return null;
  }

  return {
    event: event ?? "message",
    data: dataLines.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

function resolveReadableStream(
  source: Response | ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if ("body" in source) {
    if (!source.body) {
      throw new Error("Response has no body stream");
    }
    return source.body;
  }
  return source;
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for SSE event`));
        }, timeoutMs);
      }),
    ]);
  }
  finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface SseStreamReader {
  next: (timeoutMs?: number) => Promise<SseEvent | null>;
  close: () => Promise<void>;
}

export function createSseReader(
  source: Response | ReadableStream<Uint8Array>,
  defaultTimeoutMs = 2000,
): SseStreamReader {
  const reader = resolveReadableStream(source).getReader();
  const decoder = new TextDecoder("utf-8");
  const queued: SseEvent[] = [];
  let buffer = "";
  let pendingCarriageReturn = false;
  let ended = false;
  let closed = false;

  const pushChunk = (rawChunk: string) => {
    let chunk = rawChunk;
    if (pendingCarriageReturn) {
      if (chunk.startsWith("\n")) {
        chunk = chunk.slice(1);
      }
      pendingCarriageReturn = false;
    }
    if (chunk.endsWith("\r")) {
      pendingCarriageReturn = true;
      chunk = `${chunk.slice(0, -1)}\n`;
    }
    buffer += chunk.replace(/\r\n?/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock(block);
      if (parsed) {
        queued.push(parsed);
      }
      boundary = buffer.indexOf("\n\n");
    }
  };

  return {
    async next(timeoutMs = defaultTimeoutMs): Promise<SseEvent | null> {
      const deadline = Date.now() + timeoutMs;

      while (queued.length === 0) {
        if (ended || closed) {
          return null;
        }
        const remainingMs = Math.max(1, deadline - Date.now());
        const { done, value } = await readWithTimeout(reader, remainingMs);
        if (done) {
          const tail = decoder.decode();
          if (tail.length > 0) {
            pushChunk(tail);
          }
          if (buffer.trim().length > 0) {
            const parsed = parseSseBlock(buffer);
            buffer = "";
            if (parsed) {
              queued.push(parsed);
            }
          }
          ended = true;
          break;
        }
        if (value) {
          pushChunk(decoder.decode(value, { stream: true }));
        }
      }

      return queued.shift() ?? null;
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      ended = true;
      await reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      }
      catch {}
    },
  };
}

export async function readSseEvents(
  source: Response | ReadableStream<Uint8Array>,
  options: ReadSseEventsOptions = {},
): Promise<SseEvent[]> {
  const {
    count,
    timeoutMs = 2000,
    ignoreEvents = [],
    cancelOnComplete = true,
  } = options;
  const ignored = new Set(ignoreEvents);
  const sse = createSseReader(source, timeoutMs);
  const events: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      if (count !== undefined && events.length >= count) {
        break;
      }
      const remainingMs = Math.max(1, deadline - Date.now());
      const evt = await sse.next(remainingMs);
      if (evt === null) {
        break;
      }
      if (!ignored.has(evt.event)) {
        events.push(evt);
      }
    }
    return events;
  }
  finally {
    if (cancelOnComplete) {
      await sse.close();
    }
  }
}
