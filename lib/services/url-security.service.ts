export const LOCAL_TRANSPORT_ENVIRONMENT_VARIABLE =
  'OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS';

export function isLocalTransportAllowed() {
  return process.env[LOCAL_TRANSPORT_ENVIRONMENT_VARIABLE] === 'true';
}

export function isLoopbackHostname(hostname: string) {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '[::1]' ||
    normalizedHostname === '::1'
  );
}
