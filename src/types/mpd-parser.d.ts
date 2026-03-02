declare module "mpd-parser" {
  interface ParseOptions {
    manifestUri?: string;
    previousManifest?: unknown;
    sidxMapping?: Record<string, unknown>;
  }

  function parse(manifestString: string, options?: ParseOptions): unknown;

  export { parse };
}
