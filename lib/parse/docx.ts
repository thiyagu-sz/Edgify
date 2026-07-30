import mammoth from "mammoth";
import { ParseFailure } from "./failures";

/**
 * DOCX text extraction, in memory. `extractRawText` deliberately, not `convertToHtml`: the graph
 * and Quick Notes both want plain source material, and pulling HTML in would hand model output a
 * markup surface for no benefit.
 *
 * mammoth holds nothing after the promise settles — there is no document object to release, which
 * is why the `finally` discipline in `pdf.ts` has no counterpart here.
 */

export type DocxDeps = {
  read?: (buffer: Buffer) => Promise<{ value: string }>;
};

export async function extractDocx(
  bytes: Uint8Array,
  deps: DocxDeps = {},
): Promise<{ text: string } | ParseFailure> {
  const read =
    deps.read ?? ((buffer: Buffer) => mammoth.extractRawText({ buffer }));
  try {
    const { value } = await read(Buffer.from(bytes));
    return { text: (value ?? "").trim() };
  } catch (error) {
    // A DOCX that will not open is damaged from the user's point of view, whatever the cause.
    return new ParseFailure("corrupt", error);
  }
}
