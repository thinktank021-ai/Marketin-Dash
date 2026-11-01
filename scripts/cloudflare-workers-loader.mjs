// Stubs Cloudflare's native module only while Node validates the generated Worker export.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export const env = globalThis.__CLOUDFLARE_TEST_ENV || {};",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
