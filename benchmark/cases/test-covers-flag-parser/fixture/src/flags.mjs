export function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals === -1) {
      const next = argv[index + 1];
      flags[body] = next && !next.startsWith('--') ? argv[++index] : true;
      continue;
    }
    flags[body.slice(0, equals)] = body.slice(equals + 1);
  }
  return flags;
}
