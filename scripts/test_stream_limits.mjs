import assert from "node:assert/strict";
import { decodeBoundedText, readBodyBytes, readBodyText } from "../runtime/pi/net.mjs";

function streamOf(chunks, onCancel = () => {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(chunks[index++]));
    },
    cancel(reason) { onCancel(reason); },
  });
}

{
  let cancelled = false;
  const { bytes, truncated } = await readBodyBytes(streamOf(["12345", "67890", "EXTRA"], () => { cancelled = true; }), 10, { truncate: true });
  assert.equal(new TextDecoder().decode(bytes), "1234567890");
  assert.equal(truncated, true);
  assert.equal(cancelled, true);
}

{
  let failed = false;
  try {
    await readBodyBytes(streamOf(["12345", "67890", "X"]), 10, { truncate: false });
  } catch (error) {
    failed = /byte limit/.test(String(error));
  }
  assert.equal(failed, true, "hard byte limit must fail before unbounded buffering");
}

{
  const { text, truncated } = await readBodyText(streamOf(["这是一个很长的中文响应正文，用于测试流式读取限制。"]), 8);
  assert.equal(Array.from(text).length <= 8, true);
  assert.equal(truncated, true);
}

// Regression: fetchText (runtime/pi/newsroom.ts) peeks at raw bytes before
// deciding whether to decode as text (so it can route PDFs to pdftotext
// instead), so it cannot just call readBodyText on an already-consumed
// stream. It must compute the truncated flag from decodeBoundedText's own
// pre-slice length - not from `sliced.length > maxChars`, which can never
// be true since sliced was already capped to maxChars. This is exactly the
// f6b350e regression: decodeBoundedText did not exist there at all, so this
// file fails to import on that commit.
{
  const maxChars = 50;
  const ascii = "A".repeat(maxChars * 2);
  const { text, truncated } = decodeBoundedText(new TextEncoder().encode(ascii), maxChars);
  assert.equal(text.length, maxChars, "a body over maxChars must still be cut to exactly maxChars");
  assert.equal(truncated, true, "cutting a body over maxChars must be reported as truncated");
}

{
  // Multibyte case: each "中" is 3 UTF-8 bytes but one UTF-16 code unit, so
  // byte-counting alone would undercount how many characters actually fit.
  const maxChars = 50;
  const multibyte = "中".repeat(maxChars * 2);
  const { text, truncated } = decodeBoundedText(new TextEncoder().encode(multibyte), maxChars);
  assert.equal(text, "中".repeat(maxChars));
  assert.equal(text.length, maxChars);
  assert.equal(truncated, true);
}

{
  // Bodies at or under maxChars must round-trip unchanged and unflagged -
  // this is the JSON/HTML no-regression case: both branches in fetchText
  // feed decodeBoundedText's `text` straight into JSON.parse/normalizeHtml,
  // so an unchanged decode+no-truncation result for small bodies is exactly
  // what keeps their output identical to before the PDF fix.
  const small = '{"ok":true}';
  const { text, truncated } = decodeBoundedText(new TextEncoder().encode(small), 1000);
  assert.equal(text, small);
  assert.equal(truncated, false);
}

console.log("streaming network limits: PASS");
