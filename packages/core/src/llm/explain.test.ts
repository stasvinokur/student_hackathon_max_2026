import { describe, expect, it } from 'vitest';
import { explainPrompt, sanitizeExplanation } from './explain.js';

describe('explainPrompt', () => {
  it('sends only the card text and forbids new facts', () => {
    const [system, user] = explainPrompt({ title: 'Касса', why: 'Чеки уходят в ФНС.', doNow: 'Купите кассу.', prepare: ['ККТ', 'ОФД'], doneWhen: 'Касса зарегистрирована.' });
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('используй только факты из карточки');
    expect(user?.content).toBe(
      'Карточка:\nШаг: Касса\nЗачем: Чеки уходят в ФНС.\nЧто сделать сейчас: Купите кассу.\nЧто подготовить: ККТ; ОФД\nЧто считается выполненным: Касса зарегистрирована.\n\nОбъясни проще.',
    );
  });

  it('omits an empty prepare list', () => {
    expect(explainPrompt({ title: 't', why: 'w', doNow: 'd', prepare: [], doneWhen: 'x' })[1]?.content).not.toContain('Что подготовить');
  });
});

describe('sanitizeExplanation', () => {
  it('trims, rejects empty output and caps the length', () => {
    expect(sanitizeExplanation('  Просто купите кассу.  ')).toBe('Просто купите кассу.');
    expect(sanitizeExplanation('   ')).toBeNull();
    expect(sanitizeExplanation(undefined)).toBeNull();
    expect(sanitizeExplanation('а'.repeat(20), 10)).toBe(`${'а'.repeat(10)}…`);
  });
});
