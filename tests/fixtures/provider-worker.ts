import { reply, progress } from "../../packages/protocol/src/worker.js";
process.once("message", (request: { action: string }) => {
  if (request.action === "environment") reply({ inheritedSecret: Boolean(process.env.PERSISTARA_TEST_SECRET) });
  else if (request.action === "success") reply(new Uint8Array([1, 2, 3]));
  else if (request.action === "crash") process.exit(1);
  else if (request.action === "bad") process.send?.({ unexpected: true });
  else {
    progress("submitted", `0x${"a".repeat(64)}`);
    setInterval(() => {}, 1_000);
  }
});
