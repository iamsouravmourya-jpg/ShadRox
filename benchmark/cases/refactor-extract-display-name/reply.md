The fallback belongs in one place. New helper first, then both call sites.

```ts path=src/name.mjs
export function displayName(user) {
  const name = typeof user.name === 'string' ? user.name.trim() : '';
  if (name) return name;
  return typeof user.handle === 'string' && user.handle ? user.handle : 'friend';
}
```

```ts path=src/greet.mjs
<<<<<<< ORIGINAL
export function greet(user) {
  const name = user && user.name ? user.name : 'friend';
  return 'Hello, ' + String(name).toUpperCase() + '!';
=======
import { displayName } from './name.mjs';

export function greet(user) {
  return 'Hello, ' + displayName(user ?? {}).toUpperCase() + '!';
>>>>>>> UPDATED
```

```ts path=src/card.mjs
<<<<<<< ORIGINAL
import { greet } from './greet.mjs';

export function card(user) {
  const name = user && user.name ? user.name : 'friend';
=======
import { displayName } from './name.mjs';
import { greet } from './greet.mjs';

export function card(user) {
  const name = displayName(user ?? {});
>>>>>>> UPDATED
```
