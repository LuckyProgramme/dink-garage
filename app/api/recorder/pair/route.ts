import { randomBytes } from "node:crypto";
import { recorderDatabase } from "@/lib/recorder-server";
import { tokenHash } from "@/lib/recorder-protocol";
import { json, readBody } from "@/lib/http";
import { InputError } from "@/lib/validation";
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    if (
      typeof body.code !== "string" ||
      !/^cbpair_[A-Za-z0-9_-]{43}$/.test(body.code)
    )
      throw new InputError("Invalid pairing code.");
    const token = `cbrec_${randomBytes(32).toString("base64url")}`;
    const { data, error } = await recorderDatabase().rpc(
      "redeem_recorder_pair",
      { p_pairing_hash: tokenHash(body.code), p_token_hash: tokenHash(token) },
    );
    if (error || !data)
      return json(
        { error: "Pairing code is expired, already used, or invalid." },
        401,
      );
    return json({ recorderId: data, token });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Pairing is temporarily unavailable.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
