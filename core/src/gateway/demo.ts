/**
 * Demo provider (M0 gateway seam).
 *
 * Deterministic canned ChatEvent stream so `/v1/chat` works end to end before
 * M1 ships the real OpenAI-compatible client behind the same
 * {@link ProviderClient} interface. This module is DEMO-SEAM ONLY and is
 * replaced in M1 — it holds no credentials and never talks to the network.
 */
import type { ChatEvent, ChatMessage, ChatRequest, HealthReport, ProviderClient } from '@partner/shared';

export const DEMO_MODEL = 'demo';

/** Deterministic reply echoing the length of the last user message. */
export function demoReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return 'demo: no user message received';
  return `demo: received ${lastUser.content.length} characters`;
}

export function demoProvider(): ProviderClient {
  return {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      const started = Date.now();
      const text = demoReply(req.messages);
      yield { type: 'delta', text };
      const promptTokens = req.messages.reduce((sum, m) => sum + m.content.length, 0);
      const completionTokens = text.length;
      yield {
        type: 'usage',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
      yield { type: 'done', model: DEMO_MODEL, latencyMs: Date.now() - started };
    },

    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
}
