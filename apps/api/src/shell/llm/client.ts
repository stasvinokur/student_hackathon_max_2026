import type { ChatMessage } from '@otkryvay/core';

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface LlmClientOptions {
  /** Full URL of an OpenAI-compatible chat completions endpoint. */
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Minimal OpenAI-compatible client over fetch — no vendor SDK. */
export function createLlmClient(options: LlmClientOptions): LlmClient {
  const doFetch = options.fetch ?? fetch;
  return {
    async complete(messages) {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: options.model, messages, temperature: 0.2, max_tokens: 400 }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!response.ok) throw new Error(`LLM responded ${response.status}`);
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}
