import { browserTablet } from "@/lib/browser-tablets";
import { browserUploadChunk } from "@/lib/browser-upload";
import { json, sameOrigin } from "@/lib/http";
import { InputError, uuid } from "@/lib/validation";
import { recorderDatabase } from "@/lib/recorder-server";

export const maxDuration = 60;
const maxChunkBytes = 4 * 1024 * 1024;

async function readChunk(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (
    !Number.isSafeInteger(declared) ||
    declared < 1 ||
    declared > maxChunkBytes
  )
    throw new InputError("Invalid upload chunk size.");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Missing upload chunk.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxChunkBytes) {
      await reader.cancel();
      throw new InputError("Upload chunk is too large.");
    }
    chunks.push(value);
  }
  if (size !== declared) throw new InputError("Upload chunk is incomplete.");
  return new Uint8Array(Buffer.concat(chunks));
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const tablet = await browserTablet();
    if (!tablet) return json({ error: "Enroll this browser first." }, 401);
    const id = uuid(new URL(request.url).searchParams.get("id"));
    const owned = await recorderDatabase()
      .from("browser_recordings")
      .select("session_id")
      .eq("session_id", id)
      .eq("device_id", tablet.device.id)
      .maybeSingle();
    if (owned.error || !owned.data)
      return json(
        { error: "This recording does not belong to this tablet." },
        403,
      );
    const contentRange = request.headers.get("content-range") || "";
    const mimeType = (request.headers.get("content-type") || "").split(";")[0];
    const chunk = await readChunk(request);
    return json(
      await browserUploadChunk(
        id,
        tablet.device.id,
        contentRange,
        mimeType,
        chunk,
      ),
    );
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Upload failed. Please retry.",
      },
      error instanceof InputError ? 400 : 409,
    );
  }
}
