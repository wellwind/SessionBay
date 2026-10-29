import { describe, expect, it } from 'vitest';
import { taskInputText } from './task-input';
describe('task input text', () => {
  it('joins planning fields without a trailing submit newline', () => {
    expect(taskInputText('Synthetic task', 'Review\r\n\nNotes\n')).toBe('Synthetic task\n\nReview\n\nNotes');
    expect(taskInputText('', '')).toBe('');
  });
  it('removes terminal control bytes including bracketed-paste terminators', () => {
    expect(taskInputText('Task\x1b[201~', 'a\x00\x03\x7fb\x9bc')).toBe('Task[201~\n\nabc');
  });
});
