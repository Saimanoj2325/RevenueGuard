import { formatPhone } from './format';
import type { WaChat, WaChatKind } from './v2types';

export type ChatFilter = 'all' | 'selected' | 'person' | 'group' | 'community' | 'channel';

/** Kind of a chat; falls back to the JID for older APIs that only send is_group. */
export function chatKind(c: Pick<WaChat, 'jid' | 'is_group' | 'kind'>): WaChatKind {
  if (c.kind) return c.kind;
  const j = c.jid.toLowerCase();
  if (j.endsWith('@newsletter')) return 'channel';
  if (j.endsWith('@broadcast')) return 'broadcast';
  return c.is_group || j.endsWith('@g.us') ? 'group' : 'person';
}

/** Phone digits for a 1:1 chat: the API's `phone`, else the digits of a phone JID. LIDs are not phone numbers. */
export function chatPhone(c: Pick<WaChat, 'jid' | 'phone'>): string | null {
  if (c.phone) return c.phone;
  const [user, server] = c.jid.toLowerCase().split('@');
  return server === 's.whatsapp.net' || server === 'c.us' ? (user ?? '').split(':')[0] ?? null : null;
}

const looksLikeJidOrNumber = (s: string) => /@/.test(s) || /^[\s+\-().\d]{6,}$/.test(s);

/** What the row is called: saved name / group title, else the formatted number, else a plain fallback. */
export function chatTitle(c: WaChat): string {
  const name = c.name?.trim();
  if (name && !looksLikeJidOrNumber(name)) return name;
  const kind = chatKind(c);
  if (kind === 'person') return formatPhone(chatPhone(c)) ?? (c.push_name ? `~ ${c.push_name}` : 'Hidden number');
  if (kind === 'channel') return 'Unnamed channel';
  if (kind === 'community') return 'Unnamed community';
  return 'Unnamed group';
}

export const KIND_LABEL: Record<WaChatKind, string> = {
  person: 'Person', group: 'Group', community: 'Community', announcement: 'Announcements', channel: 'Channel', broadcast: 'Broadcast list',
};

/** Second line: kind, then the detail that tells similar rows apart (number, members, parent community). */
export function chatSubtitle(c: WaChat): string {
  const kind = chatKind(c);
  const parts: string[] = [KIND_LABEL[kind]];
  if (kind === 'person') {
    const title = chatTitle(c);
    const phone = formatPhone(chatPhone(c));
    if (phone && phone !== title) parts.push(phone);
    else if (!phone) parts.push('WhatsApp has not shared the number yet');
    if (c.push_name && c.push_name !== title && `~ ${c.push_name}` !== title) parts.push(`~ ${c.push_name}`);
    else if (phone && phone === title) parts.push('not in your contacts');
  } else {
    if (kind === 'announcement' || (kind === 'group' && c.parent)) parts.push(c.parent_name ? `in ${c.parent_name}` : 'in a community');
    if (c.members) parts.push(`${c.members.toLocaleString('en-IN')} members`);
  }
  return parts.join(' · ');
}

/** Which filter pills a chat belongs to. A group inside a community shows under both Groups and Communities. */
export function inFilter(c: WaChat, f: ChatFilter, selected: Set<string>): boolean {
  const k = chatKind(c);
  switch (f) {
    case 'all': return true;
    case 'selected': return selected.has(c.jid);
    case 'person': return k === 'person';
    case 'group': return k === 'group';
    case 'community': return k === 'community' || k === 'announcement' || (k === 'group' && !!c.parent);
    case 'channel': return k === 'channel' || k === 'broadcast';
  }
}

/** Search over the title, saved/profile name, community name and phone digits ("98765" finds +91 98765 43204). */
export function matchesSearch(c: WaChat, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const hay = [chatTitle(c), c.name ?? '', c.push_name ?? '', c.parent_name ?? ''].join(' ').toLowerCase();
  if (hay.includes(t)) return true;
  const digits = t.replace(/\D/g, '');
  return digits.length >= 3 && (chatPhone(c) ?? '').includes(digits);
}

/** Selected (pinned) chats first, then most recent message, then title. */
export function sortChats(rows: WaChat[], pinned: Set<string>): WaChat[] {
  const time = (c: WaChat) => (c.last_message_at ? new Date(c.last_message_at).getTime() : 0);
  return [...rows].sort((a, b) => {
    const pa = pinned.has(a.jid) ? 0 : 1;
    const pb = pinned.has(b.jid) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const d = time(b) - time(a);
    return d !== 0 ? d : chatTitle(a).localeCompare(chatTitle(b));
  });
}

export const FILTERS: { key: ChatFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'selected', label: 'Selected' }, { key: 'person', label: 'People' },
  { key: 'group', label: 'Groups' }, { key: 'community', label: 'Communities' }, { key: 'channel', label: 'Channels' },
];

/** A 1:1 chat with no number, no saved name and no profile name: nothing to tell it apart by. */
export function isFaceless(c: WaChat): boolean {
  return chatKind(c) === 'person' && !chatPhone(c) && !c.push_name && !(c.name && !/@|^[\s+\-().\d]{6,}$/.test(c.name));
}
