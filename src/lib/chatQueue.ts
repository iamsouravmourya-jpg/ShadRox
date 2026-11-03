export const MAX_QUEUED_CHAT_MESSAGES = 5;

export interface QueuedChatItem {
  id: string;
  text: string;
}

export function enqueueChatItem<T extends QueuedChatItem>(
  queue: T[],
  item: T
): { queue: T[]; accepted: boolean } {
  if (queue.length >= MAX_QUEUED_CHAT_MESSAGES) return { queue, accepted: false };
  return { queue: [...queue, item], accepted: true };
}

export function dequeueChatItem<T>(queue: T[]): { item: T | null; queue: T[] } {
  if (queue.length === 0) return { item: null, queue };
  return { item: queue[0], queue: queue.slice(1) };
}

export function removeQueuedChatItem<T extends QueuedChatItem>(queue: T[], id: string): T[] {
  return queue.filter((item) => item.id !== id);
}
