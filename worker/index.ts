/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { guardAppRequest } from "./app-auth";
import { dispatchTelegramReports } from "../app/telegram-report";

// Declares every platform binding used by the generated Worker runtime.
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DASHBOARD_ADMIN_USER?: string;
  DASHBOARD_ADMIN_PASSWORD_HASH?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

// Minimal execution-context surface passed through to the Vinext request handler.
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Cloudflare invokes this handler from the configured cron trigger. The report
// module re-checks the manager's interval and exact end-of-day settings, so a
// minute-level trigger never causes duplicate Telegram messages.
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  // Routes image-optimization requests through Cloudflare Images and all other requests through Vinext.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const activeEnv = env?.DB ? env : ((globalThis as unknown as { __CLOUDFLARE_ENV?: Env }).__CLOUDFLARE_ENV || env || ({} as Env));
    const url = new URL(request.url);
    const authResponse = await guardAppRequest(request, activeEnv);
    if (authResponse) return authResponse;

    // Validate requested widths and transform only the framework's image endpoint.
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    // Forward pages, API routes, and static requests to the application router.
    const response = await handler.fetch(request, activeEnv, ctx);
    if (!url.pathname.startsWith("/assets/")) {
      const protectedResponse = new Response(response.body, response);
      protectedResponse.headers.set("cache-control", "no-store, private");
      return protectedResponse;
    }
    return response;
  },
  // Keep scheduled work outside the request path so a dashboard visitor is
  // never responsible for keeping automatic Telegram delivery alive.
  async scheduled(_controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchTelegramReports().then(result => {
      if (["source_unavailable", "no_enabled_brands", "no_recipients", "disabled"].includes(result.reason || "")) {
        throw new Error(`telegram_scheduled_${result.reason}`);
      }
    }).catch(() => {
      // Avoid leaking upstream payloads or stored credentials in production logs.
      throw new Error("telegram_scheduled_dispatch_failed");
    }));
  },
};

export default worker;
