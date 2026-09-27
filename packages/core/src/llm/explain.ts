import type { TaskDetail } from '../rules/view.js';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const SYSTEM_PROMPT = [
  'Ты помогаешь начинающему предпринимателю понять шаг открытия кофейни.',
  'Перескажи карточку простыми словами, как объяснил бы знакомый бухгалтер: коротко, по-дружески, без канцелярита.',
  'Строгие правила:',
  '- используй только факты из карточки, ничего не добавляй от себя;',
  '- не называй законы, сроки, суммы, штрафы и организации, которых нет в карточке;',
  '- не давай юридических гарантий;',
  '- не больше 5 предложений, без списков и заголовков.',
].join('\n');

/**
 * Prompt for the optional "explain simply" feature. Only the text of a card that the rules
 * engine already selected is sent — the model rephrases, it never decides what applies.
 */
export function explainPrompt(task: Pick<TaskDetail, 'title' | 'why' | 'doNow' | 'prepare' | 'doneWhen'>): ChatMessage[] {
  const card = [
    `Шаг: ${task.title}`,
    `Зачем: ${task.why}`,
    `Что сделать сейчас: ${task.doNow}`,
    task.prepare.length > 0 ? `Что подготовить: ${task.prepare.join('; ')}` : null,
    `Что считается выполненным: ${task.doneWhen}`,
  ].filter((line): line is string => line !== null);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Карточка:\n${card.join('\n')}\n\nОбъясни проще.` },
  ];
}

/** Trims the model output; returns null when there is nothing usable. */
export function sanitizeExplanation(text: string | null | undefined, maxLength = 1200): string | null {
  const cleaned = (text ?? '').replace(/\s+\n/g, '\n').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trimEnd()}…` : cleaned;
}
