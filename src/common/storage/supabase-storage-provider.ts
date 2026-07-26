import { env } from "../../config/env";
import { supabaseClient } from "../database/supabase-client";
import type { StorageProvider } from "./storage-provider";

export class SupabaseStorageProvider implements StorageProvider {
  async upload(orderId: string, slot: number, file: Express.Multer.File): Promise<string> {
    const storagePath = `${orderId}/slot-${slot}-${Date.now()}`;

    const { error } = await supabaseClient.storage.from(env.STORAGE_BUCKET_NAME).upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return storagePath;
  }

  async getSignedUrl(storagePath: string, expiresInSeconds = 3600): Promise<string> {
    const { data, error } = await supabaseClient.storage
      .from(env.STORAGE_BUCKET_NAME)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data) throw new Error(`Failed to sign URL: ${error?.message}`);
    return data.signedUrl;
  }

  async getSignedUrls(storagePaths: string[], expiresInSeconds = 3600): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (storagePaths.length === 0) return urls;

    const { data, error } = await supabaseClient.storage
      .from(env.STORAGE_BUCKET_NAME)
      .createSignedUrls(storagePaths, expiresInSeconds);

    if (error || !data) throw new Error(`Failed to sign URLs: ${error?.message}`);
    // Per-item errors (data[i].error) are tolerated: a path that couldn't be
    // signed is left out of the map, not thrown -- one bad image must not
    // fail the whole list response.
    for (const item of data) {
      if (item.path && item.signedUrl) urls.set(item.path, item.signedUrl);
    }
    return urls;
  }

  async delete(storagePath: string): Promise<void> {
    const { error } = await supabaseClient.storage.from(env.STORAGE_BUCKET_NAME).remove([storagePath]);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }
}

/** Module-level singleton -- manual composition root, no DI container needed at this size. */
export const storageProvider: StorageProvider = new SupabaseStorageProvider();
