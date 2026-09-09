import { expect, test, vi } from "vitest";
import { createPrompts } from "../src/prompts.js";

test("noninteractive prompts return safe cancellation values", async () => {
  const prompts = createPrompts({ isTTY: false, input: process.stdin, output: process.stdout });
  await expect(prompts.select("pick", ["work"])).resolves.toBeUndefined();
  await expect(prompts.confirm("delete")).resolves.toBe(false);
  await expect(prompts.input("name")).resolves.toBeUndefined();
});

test("selection rejects an empty choice list without reading", async () => {
  const prompts = createPrompts({ isTTY: true, input: process.stdin, output: process.stdout });
  await expect(prompts.select("pick", [])).resolves.toBeUndefined();
});
