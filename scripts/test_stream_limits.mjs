import assert from "node:assert/strict";
import { readBodyBytes, readBodyText } from "../runtime/pi/net.mjs";

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

console.log("streaming network limits: PASS");
