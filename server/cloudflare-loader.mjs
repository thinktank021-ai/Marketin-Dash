// Cloudflare Workers ESM loader for standalone Node.js and cPanel execution.
// Intercepts `cloudflare:workers` and returns the global server environment.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export const env = globalThis.__CLOUDFLARE_ENV || {};",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
