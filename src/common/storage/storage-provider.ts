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
  delete(storagePath: string): Promise<void>;
}
