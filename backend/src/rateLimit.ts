import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";

export type RateLimitConfig = {
  // All limits count requests per client IP within the window.
  apiPerIp: number;
  compilePerIp: number;
  uploadPerIp: number;
  // Library installs, removals and ZIP uploads.
  libraryChangesPerIp: number;
  windowMs: number;
};

function readLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function rateLimitConfigFromEnv(): RateLimitConfig {
  return {
    apiPerIp: readLimit("RATE_LIMIT_API_PER_IP", 300),
    compilePerIp: readLimit("RATE_LIMIT_COMPILE_PER_IP", 20),
    uploadPerIp: readLimit("RATE_LIMIT_UPLOAD_PER_IP", 10),
    libraryChangesPerIp: readLimit("RATE_LIMIT_LIBRARY_CHANGES_PER_IP", 30),
    windowMs: readLimit("RATE_LIMIT_WINDOW_MS", 10 * 60_000),
  };
}

function limitResponse(message: string) {
  return { success: false, message, logs: "" };
}

export function createRateLimiters(config: RateLimitConfig): {
  api: RequestHandler;
  compile: RequestHandler;
  upload: RequestHandler;
  libraryChanges: RequestHandler;
} {
  const perIp = (limit: number, message: string) =>
    rateLimit({
      windowMs: config.windowMs,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: limitResponse(message),
    });

  return {
    api: perIp(config.apiPerIp, "Too many requests from this network. Wait a few minutes and try again."),
    compile: perIp(config.compilePerIp, "Too many compile requests. Wait a few minutes and try again."),
    upload: perIp(config.uploadPerIp, "Too many upload requests. Wait a few minutes and try again."),
    libraryChanges: perIp(
      config.libraryChangesPerIp,
      "Too many library changes. Wait a few minutes and try again.",
    ),
  };
}
