import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface PromptAdapter {
  select(title: string, choices: string[]): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  input(message: string): Promise<string | undefined>;
}

export function createPrompts(options: { isTTY: boolean; input: Readable; output: Writable }): PromptAdapter {
  const ask = async (message: string): Promise<string | undefined> => {
    if (!options.isTTY) return undefined;
    const terminal = createInterface({ input: options.input, output: options.output });
    try {
      return (await terminal.question(`${message} `)).trim();
    } finally {
      terminal.close();
    }
  };
  return {
    async select(title, choices) {
      if (!options.isTTY || choices.length === 0) return undefined;
      options.output.write(`${title}\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join("\n")}\n`);
      const answer = await ask("Selection:");
      const index = Number(answer) - 1;
      return Number.isInteger(index) && choices[index] !== undefined ? choices[index] : undefined;
    },
    async confirm(message) {
      const answer = await ask(`${message} [y/N]`);
      return answer?.toLowerCase() === "y" || answer?.toLowerCase() === "yes";
    },
    input: ask,
  };
}
