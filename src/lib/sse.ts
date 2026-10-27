/**
 * Incremental Server-Sent Events decoder shared by the browser client and the
 * Node API layer. It implements the parts of the event-stream grammar that
 * providers actually use: LF/CRLF line endings, multi-line `data:` fields,
 * `event:` names, comments, and dispatch on a blank line.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export interface SseDecoder {
  push(chunk: string): void;
  flush(): void;
  readonly hasPendingData: boolean;
}

export function createSseDecoder(onEvent: (event: SseEvent) => void): SseDecoder {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName = '';

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const data = dataLines.join('\n');
    const name = eventName || 'message';
    dataLines = [];
    eventName = '';
    onEvent({ event: name, data });
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(newline + 1);
        processLine(line);
        newline = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        buffer = '';
        processLine(line);
      }
      // A provider may close the connection without the final blank line.
      dispatch();
    },
    get hasPendingData() {
      return buffer.length > 0 || dataLines.length > 0;
    }
  };
}
