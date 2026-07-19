import { env } from "../../config/env";
import { supabaseAdmin } from "../supabaseAdmin";

/**
 * Single interface over Supabase Storage -- identical in local dev (the
 * Supabase CLI's Storage emulator) and prod (hosted Supabase Storage), no
 * branching. Nothing outside this file talks to Storage directly.
 */
export const storageProvider = {
  async upload(orderId: string, slot: number, file: Express.Multer.File): Promise<string> {
    const storagePath = `${orderId}/slot-${slot}-${Date.now()}`;

    const { error } = await supabaseAdmin.storage.from(env.STORAGE_BUCKET_NAME).upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return storagePath;
  },

  async getSignedUrl(storagePath: string, expiresInSeconds = 3600): Promise<string> {
    const { data, error } = await supabaseAdmin.storage
      .from(env.STORAGE_BUCKET_NAME)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data) throw new Error(`Failed to sign URL: ${error?.message}`);
    return data.signedUrl;
  },

  async delete(storagePath: string): Promise<void> {
    const { error } = await supabaseAdmin.storage.from(env.STORAGE_BUCKET_NAME).remove([storagePath]);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  },
};
