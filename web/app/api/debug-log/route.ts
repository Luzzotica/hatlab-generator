import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export const runtime = "nodejs";

/**
 * Appends one NDJSON line to the active Cursor debug log (dev only).
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ ok: false }, { status: 403 });
  }
  const text = await req.text();
  const logPath = join(process.cwd(), "..", ".cursor", "debug-9fab0c.log");
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${text}\n`, "utf8");
  } catch {
    // ignore fs errors
  }
  return Response.json({ ok: true });
}
