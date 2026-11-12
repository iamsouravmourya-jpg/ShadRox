export function greet(user) {
  const name = user && user.name ? user.name : 'friend';
  return 'Hello, ' + String(name).toUpperCase() + '!';
}
