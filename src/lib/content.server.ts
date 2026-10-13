import { timingSafeEqual } from "crypto";

/** In-memory content storage fallback when database is not connected */
const inMemoryStore = new Map<string, { content: unknown; updated_at: string }>();

/** In-memory media storage fallback for uploaded assets */
export const inMemoryMedia = new Map<string, { buffer: Buffer; type: string }>();

/** Security is now handled via the secret admin URL; logins and passkeys are removed. */
export function assertAdminKey(_key?: string) {
  // No-op: authentication via passkey is removed; access relies on the secret URL.
}

export async function readRow(id: "draft" | "published") {
  const hasConfig =
    (process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"]) &&
    process.env["SUPABASE_SERVICE_ROLE_KEY"];

  if (hasConfig) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("site_content")
      .select("content, updated_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error(`[Site Content] Supabase read failed for "${id}":`, error.message);
      throw new Error(`Database read error: ${error.message}`);
    }

    if (data) {
      inMemoryStore.set(id, data);
      return data;
    }

    // Row does not exist in database yet
    return null;
  }

  console.warn(`[Site Content] Supabase not configured — reading from memory for "${id}"`);
  return inMemoryStore.get(id) ?? null;
}

export async function writeRow(id: "draft" | "published", content: unknown) {
  const url = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

  if (!url || !serviceKey) {
    const missing: string[] = [];
    if (!url) missing.push("SUPABASE_URL");
    if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    const errorMsg = `Supabase configuration missing: ${missing.join(", ")}. Cannot persist content to database.`;
    console.error(`[Site Content] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const updated_at = new Date().toISOString();

  // Persist directly to Supabase site_content table
  const { data, error } = await supabaseAdmin
    .from("site_content")
    .upsert({ id, content: content as never, updated_at }, { onConflict: "id" })
    .select("content, updated_at")
    .single();

  if (error) {
    console.error(`[Site Content] Supabase write failed for "${id}":`, error);
    throw new Error(`Failed to persist ${id} content to Supabase database: ${error.message}`);
  }

  // Verify persistence from database
  const verified =
    data ??
    (await supabaseAdmin
      .from("site_content")
      .select("content, updated_at")
      .eq("id", id)
      .single()
      .then((r) => {
        if (r.error || !r.data) {
          throw new Error(
            `Supabase persistence verification failed: ${r.error?.message || "Row not found"}`,
          );
        }
        return r.data;
      }));

  // Update in-memory cache only after confirmed database write
  inMemoryStore.set(id, { content: verified.content, updated_at: verified.updated_at });

  return verified;
}
