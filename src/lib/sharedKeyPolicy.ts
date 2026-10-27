/**
 * Beta switch for ShadRox's server-side shared key. While this is false the
 * app is BYOK-only: the "Use ShadRox key" control is locked in the UI and no
 * request may be served from an operator key. The shared-key code paths stay
 * in place so the paid launch can flip this without a rewrite.
 */
export const SHARED_KEY_ENABLED = false;
