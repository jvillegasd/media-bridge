declare module "mpd-parser" {
  interface ParseOptions {
    manifestUri?: string;
    previousManifest?: unknown;
    sidxMapping?: Record<string, unknown>;
  }

  interface MpdSegment {
    uri: string;
    resolvedUri: string;
    duration: number;
    map?: {
      uri: string;
      resolvedUri: string;
      byterange?: { offset: number | bigint; length: number | bigint };
    };
  }

  interface MpdPlaylist {
    uri: string;
    attributes: {
      BANDWIDTH?: number;
      RESOLUTION?: { width: number; height: number };
      CODECS?: string;
      [key: string]: unknown;
    };
    segments: MpdSegment[];
    contentProtection?: Record<string, unknown>;
  }

  interface MpdManifest {
    playlists: MpdPlaylist[];
    mediaGroups: {
      AUDIO?: {
        audio?: Record<string, { playlists?: MpdPlaylist[] }>;
      };
    };
    minimumUpdatePeriod?: number;
    [key: string]: unknown;
  }

  function parse(manifestString: string, options?: ParseOptions): MpdManifest;

  export { parse, MpdSegment, MpdPlaylist, MpdManifest };
}
