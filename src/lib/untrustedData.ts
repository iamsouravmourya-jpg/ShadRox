const BEGIN = '[[SHADROX_UNTRUSTED_DATA_BEGIN]]';
const END = '[[SHADROX_UNTRUSTED_DATA_END]]';

export function untrustedDataMarker(source: string): string {
  return `${BEGIN}\nSource: ${source}`;
}

export function isMarkedUntrustedData(text: string): boolean {
  return text.startsWith(BEGIN);
}

export function markUntrustedData(text: string, source?: string): string {
  const escaped = text.replaceAll(BEGIN, `\\${BEGIN}`).replaceAll(END, `\\${END}`);
  const header = source ? `${BEGIN}\nSource: ${source}\n` : `${BEGIN}\n`;
  return `${header}${escaped}\n${END}`;
}
