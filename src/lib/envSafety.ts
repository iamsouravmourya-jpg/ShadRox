const SENSITIVE_ENV_RE = /^(?:SHADROX_|.*(?:GEMINI|GROQ|SUPABASE).*(?:API_KEY|KEY|SECRET|TOKEN|PASSWORD)|.*(?:API_KEY|SECRET|PASSWORD|TOKEN))$/i;

export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => {
      if (typeof value !== 'string') return false;
      return !SENSITIVE_ENV_RE.test(key);
    })
  );
}
