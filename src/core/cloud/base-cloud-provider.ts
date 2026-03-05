import { CloudProvider } from '../../shared/messages';

export type ProgressCallback = (uploaded: number, total: number) => void;

export abstract class BaseCloudProvider {
  abstract readonly id: CloudProvider;

  /**
   * Upload blob to this provider.
   * Returns the shareable URL of the uploaded file.
   */
  abstract upload(
    blob: Blob,
    filename: string,
    onProgress?: ProgressCallback,
  ): Promise<string>;
}
