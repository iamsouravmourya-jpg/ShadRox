The loop is right; the divisor counts one extra value, so short lists are dragged
toward zero.

```ts path=average.mjs
<<<<<<< ORIGINAL
  return total / (values.length + 1);
=======
  return total / values.length;
>>>>>>> UPDATED
```
