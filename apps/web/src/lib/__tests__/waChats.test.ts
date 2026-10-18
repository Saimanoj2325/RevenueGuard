import { describe, expect, it } from 'vitest';
import { formatPhone } from '../format';
import { chatKind, chatSubtitle, chatTitle, inFilter, matchesSearch, sortChats } from '../waChats';
import type { WaChat } from '../v2types';

const c = (o: Partial<WaChat> & { jid: string }): WaChat => ({ name: null, is_group: false, last_message_at: null, watched: false, ...o });

describe('chat picker helpers', () => {
  it('formats Indian and other numbers', () => {
    expect(formatPhone('919876543204')).toBe('+91 98765 43204');
    expect(formatPhone('14155550100')).toBe('+1 415 555 0100');
    expect(formatPhone('12')).toBeNull();
  });

  it('never shows a raw JID or masked number as the name', () => {
    expect(chatTitle(c({ jid: '919876543204@s.whatsapp.net', name: '919876543204@s.whatsapp.net' }))).toBe('+91 98765 43204');
    expect(chatTitle(c({ jid: '81234567890123@lid', phone: '919876543204' }))).toBe('+91 98765 43204');
    expect(chatTitle(c({ jid: '81234567890123@lid' }))).toBe('Unknown contact');
    expect(chatSubtitle(c({ jid: '81234567890123@lid' }))).toBe('Person · number hidden by WhatsApp');
    expect(chatSubtitle(c({ jid: '919876543204@s.whatsapp.net', name: 'Ramesh', push_name: 'Ramu' }))).toBe('Person · +91 98765 43204 · ~ Ramu');
    expect(chatSubtitle(c({ jid: '919876543204@s.whatsapp.net' }))).toBe('Person · not in your contacts');
  });

  it('tells groups, communities, announcement groups and channels apart', () => {
    expect(chatKind(c({ jid: '1@g.us', is_group: true }))).toBe('group');
    expect(chatKind(c({ jid: '9@newsletter' }))).toBe('channel');
    const ann = c({ jid: '2@g.us', is_group: true, kind: 'announcement', name: 'Traders', parent_name: 'Traders', members: 240 });
    expect(chatSubtitle(ann)).toBe('Announcements · in Traders · 240 members');
    const sub = c({ jid: '3@g.us', is_group: true, kind: 'group', parent: '1@g.us', name: 'Steel' });
    expect(inFilter(sub, 'group', new Set())).toBe(true);
    expect(inFilter(sub, 'community', new Set())).toBe(true);
    expect(inFilter(c({ jid: '9@newsletter' }), 'channel', new Set())).toBe(true);
    expect(inFilter(c({ jid: '9@newsletter' }), 'person', new Set())).toBe(false);
  });

  it('puts selected chats first, then newest', () => {
    const rows = [
      c({ jid: 'a@g.us', name: 'A', last_message_at: '2026-10-18T03:00:00Z' }),
      c({ jid: 'b@g.us', name: 'B', last_message_at: '2026-10-17T03:00:00Z' }),
      c({ jid: 'c@g.us', name: 'C', last_message_at: '2026-10-18T04:00:00Z' }),
    ];
    expect(sortChats(rows, new Set(['b@g.us'])).map((r) => r.jid)).toEqual(['b@g.us', 'c@g.us', 'a@g.us']);
  });

  it('searches by phone digits', () => {
    expect(matchesSearch(c({ jid: '919876543204@s.whatsapp.net' }), '98765')).toBe(true);
    expect(matchesSearch(c({ jid: '919876543204@s.whatsapp.net' }), '11111')).toBe(false);
  });
});
