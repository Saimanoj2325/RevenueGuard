import { describe, expect, it } from 'vitest';
import { sheetIdOf } from '@/components/money/SheetPicker';
describe('sheetIdOf', () => {
  it('pulls the id out of a full link', () => expect(sheetIdOf('https://docs.google.com/spreadsheets/d/1AbC_d-9xYz/edit#gid=0')).toBe('1AbC_d-9xYz'));
  it('keeps a bare id', () => expect(sheetIdOf('  1AbC_d-9xYz ')).toBe('1AbC_d-9xYz'));
});
