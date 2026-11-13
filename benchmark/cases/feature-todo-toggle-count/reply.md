`add`/`list`/`clear` exist; nothing can flip an item or count what is left. Both
belong next to `list()`, and an index nobody added has to be refused out loud.

```ts path=src/todo.mjs
<<<<<<< ORIGINAL
export function list() {
  return items.map((item, index) => `${index}: ${item.done ? '[x] ' : '[ ] '}${item.title}`);
}
=======
export function list() {
  return items.map((item, index) => `${index}: ${item.done ? '[x] ' : '[ ] '}${item.title}`);
}

export function remaining() {
  return items.filter((item) => !item.done).length;
}

export function toggle(index) {
  const item = items[index];
  if (!item) throw new Error(`no todo at index ${index}`);
  item.done = !item.done;
  return item;
}
>>>>>>> UPDATED
```
