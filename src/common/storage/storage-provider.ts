/**
 * Storage abstraction every module depends on instead of calling Supabase
 * Storage directly. Identical behavior in local dev (the Supabase CLI's
 * Storage emulator) and prod (hosted Supabase Storage) -- no branching --
 * and the one seam in this codebase genuinely designed as an interface with
 * a swappable implementation, because "which backend" is a real axis of
 * variation here (local emulator vs. hosted), unlike table access, where
 * there is only ever one real implementation.
 */
export interface StorageProvider {
  upload(orderId: string, slot: number, file: Express.Multer.File): Promise<string>;
  getSignedUrl(storagePath: string, expiresInSeconds?: number): Promise<string>;
  /**
   * Batch variant of getSignedUrl -- signs many paths in ONE backend call.
   * The orders list resolves every image URL for a whole page; doing that
   * one-at-a-time is an N+1 against the storage backend (up to 4 round trips
   * per order). Returns a path->url map; a path that fails to sign is simply
   * absent from the map (the caller degrades to a missing image rather than
   * failing the whole request). An empty input makes no backend call.
   */
  getSignedUrls(storagePaths: string[], expiresInSeconds?: number): Promise<Map<string, string>>;
  delete(storagePath: string): Promise<void>;
}
