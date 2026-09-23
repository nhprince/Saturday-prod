import { describe, it, expect } from 'vitest';
import { classify } from '../src/services/router';
import { stateFromStatus, isRetryable } from '../src/types';

const msg = (content: string) => ({ role: 'user' as const, content });
const route = (content: string, extra: Record<string, unknown> = {}) =>
  classify({ selection: 'smart', messages: [msg(content)], ...extra } as any);

describe('request classification', () => {
  it('flags code', () => {
    expect(route('Can you refactor this function to be async?').signals).toContain('code');
  });

  it('flags mathematics', () => {
    expect(route('Prove that the eigenvalues are real').signals).toContain('mathematics');
    expect(route('Compute \\frac{dy}{dx}').signals).toContain('mathematics');
  });

  it('flags reasoning', () => {
    expect(route('Compare the trade-offs of these two strategies').signals).toContain('reasoning');
  });

  it('flags structured output', () => {
    expect(route('Return the result as JSON matching this schema').signals).toContain('structured output');
    expect(route('plain question', { wantsJson: true }).signals).toContain('structured output');
  });

  it('flags image input only when images are present', () => {
    expect(route('what is this?', { hasImages: true }).signals).toContain('image input');
    expect(route('what is this?').signals).not.toContain('image input');
  });

  it('flags short turns', () => {
    expect(route('hey there').signals).toContain('short turn');
  });

  it('flags long context by cumulative characters', () => {
    expect(route('x'.repeat(21_000)).signals).toContain('long context');
  });

  it('asks for a large model on math/reasoning and a small one on chat', () => {
    expect(route('Why does this strategy fail? Analyse the trade-offs').want).toBe('large');
    expect(route('hey').want).toBe('small');
    // >= 140 chars with no signals lands on medium (below that is a "short turn")
    expect(route('Tell me something interesting about the history of the weekend. '.repeat(3)).want).toBe('medium');
  });

  it('requires vision and json through to the capability filter', () => {
    expect(route('describe this', { hasImages: true }).requires.vision).toBe(true);
    expect(route('json please').requires.json).toBe(true);
  });
});

describe('status classification', () => {
  it('maps HTTP statuses onto health states', () => {
    expect(stateFromStatus(401)).toBe('AUTH_FAILED');
    expect(stateFromStatus(404)).toBe('NOT_FOUND');
    expect(stateFromStatus(422)).toBe('UNSUPPORTED');
    expect(stateFromStatus(429)).toBe('RATE_LIMITED');
    expect(stateFromStatus(500)).toBe('ERROR');
    expect(stateFromStatus(504)).toBe('TIMEOUT');
  });

  it('knows which states deserve a retry', () => {
    expect(isRetryable('RATE_LIMITED')).toBe(true);
    expect(isRetryable('AUTH_FAILED')).toBe(false);
    expect(isRetryable('NOT_FOUND')).toBe(false);
  });
});
