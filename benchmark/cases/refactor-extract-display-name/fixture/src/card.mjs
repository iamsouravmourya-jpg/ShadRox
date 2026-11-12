import { greet } from './greet.mjs';

export function card(user) {
  const name = user && user.name ? user.name : 'friend';
  return greet({ name }) + ' — welcome back, ' + name + '.';
}
