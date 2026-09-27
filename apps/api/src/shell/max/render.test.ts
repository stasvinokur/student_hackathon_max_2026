import { describe, expect, it } from 'vitest';
import { renderReply } from './render.js';

describe('renderReply', () => {
  it('maps core buttons to a MAX inline keyboard', () => {
    const { text, extra } = renderReply(
      {
        text: 'hi',
        buttons: [
          [{ kind: 'open_app', text: 'Карта', startParam: 'task-1' }],
          [
            { kind: 'callback', text: 'Да', payload: 'yes' },
            { kind: 'request_geo', text: 'Где я' },
          ],
          [{ kind: 'link', text: 'Источник', url: 'https://example.ru' }],
        ],
      },
      { webApp: 'my_bot' },
    );

    expect(text).toBe('hi');
    expect(extra.attachments).toEqual([
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [{ type: 'open_app', text: 'Карта', web_app: 'my_bot', payload: 'task-1' }],
            [
              { type: 'callback', text: 'Да', payload: 'yes' },
              expect.objectContaining({ type: 'request_geo_location', text: 'Где я' }),
            ],
            [{ type: 'link', text: 'Источник', url: 'https://example.ru' }],
          ],
        },
      },
    ]);
  });

  it('sends no keyboard when there are no buttons', () => {
    expect(renderReply({ text: 'plain', buttons: [[]] }, { webApp: 'b' }).extra).toEqual({});
  });
});
