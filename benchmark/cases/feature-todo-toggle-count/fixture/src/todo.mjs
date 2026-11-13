const items = [];

export function add(title) {
  items.push({ title, done: false });
  return items.length - 1;
}

export function list() {
  return items.map((item, index) => `${index}: ${item.done ? '[x] ' : '[ ] '}${item.title}`);
}

export function clear() {
  items.length = 0;
}
