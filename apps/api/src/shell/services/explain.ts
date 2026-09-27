import { explainPrompt, sanitizeExplanation, type TaskDetail } from '@otkryvay/core';
import type { FastifyBaseLogger } from 'fastify';
import type { LlmClient } from '../llm/client.js';
import type { RouteService } from './routes.js';

export type ExplainResult = { status: 'ok'; text: string; source: TaskDetail['source'] } | { status: 'not_found' } | { status: 'unavailable' };

/**
 * «Объясни проще»: rephrases a card the rules engine already selected. Answers are cached per
 * pack version and task, so the same card is explained once and the text stays stable.
 */
export function createExplainService(deps: { routes: RouteService; llm: LlmClient | null; log: FastifyBaseLogger }) {
  const cache = new Map<string, string>();

  return {
    enabled: deps.llm !== null,

    async explain(userId: number, taskId: string): Promise<ExplainResult> {
      const loaded = await deps.routes.getRoute(userId);
      const task = loaded ? await deps.routes.getTask(userId, taskId) : null;
      if (!loaded || !task) return { status: 'not_found' };
      if (!deps.llm) return { status: 'unavailable' };

      const key = `${loaded.pack.manifest.id}@${loaded.pack.manifest.version}:${taskId}`;
      const cached = cache.get(key);
      if (cached) return { status: 'ok', text: cached, source: task.source };

      try {
        const text = sanitizeExplanation(await deps.llm.complete(explainPrompt(task)));
        if (!text) return { status: 'unavailable' };
        cache.set(key, text);
        return { status: 'ok', text, source: task.source };
      } catch (error) {
        deps.log.warn({ err: error, taskId }, 'explanation unavailable');
        return { status: 'unavailable' };
      }
    },
  };
}

export type ExplainService = ReturnType<typeof createExplainService>;
